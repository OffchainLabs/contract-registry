import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { DataRepo, SourceData } from '../src/lib/datarepo.ts'
import type { Entry, TagFile } from '../src/lib/types.ts'
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT } from '../src/walker/proxy.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLI = path.join(ROOT, 'tools/src/cli/ci-check.ts')
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const entry = (n: number): Entry => ({
  schemaVersion: 1, fingerprint: fp(n), repo: 'OffchainLabs/nitro-contracts', contracts: [`src/X${n}.sol:X${n}`], role: 'logic', codeLength: 100 + n,
  maskedRanges: [], cborMetadataLength: 12, getters: [], selectors: [],
  compiler: { language: 'Solidity', version: '0.8.17', evmVersion: 'london', optimizer: { enabled: true, runs: 2000 }, viaIR: false, metadata: { bytecodeHash: 'none', appendCBOR: true } },
  ref: 'release-1.0.0', commit: n.toString(16).padStart(40, '0'),
})
const tag = (name: string, n: number): TagFile => ({
  schemaVersion: 1, repo: 'OffchainLabs/nitro-contracts', tag: name, commit: '9'.repeat(40), prerelease: false, packageVersion: name.slice(1), contracts: { [`src/X${n}.sol:X${n}`]: fp(n) },
})

/** A data repo with this repo's config and schemas: its nitro-contracts data, git, and the CLI. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-ci-'))
  for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  return {
    dir, g,
    data: new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts'),
    views: () => DataRepo.open(dir).writeViews(),
    commit: (m: string) => { g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', m) },
    check: (base?: string) => {
      const r = spawnSync(process.execPath, [CLI, '--data-repo', dir, ...(base ? ['--base', base] : [])], { encoding: 'utf8' })
      return { ok: r.status === 0, out: r.stderr + r.stdout }
    },
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test('ci-check: appends pass; modified or deleted entries fail; hand-edited views fail', () => {
  const t = setup()
  t.data.writeEntry(entry(1)); t.views(); t.commit('one')
  const first = t.check('HEAD')
  assert.ok(first.ok, first.out)
  for (const ok of ['sources: ok', 'schema validation: ok', 'layout: ok', 'generated files match their inputs', 'entries: ok', 'ranges: ok', 'append-only: ok']) assert.ok(first.out.includes(ok), `${ok}\n---\n${first.out}`)

  t.data.writeEntry(entry(2)); t.views(); t.commit('append')
  const append = t.check('HEAD~1')
  assert.ok(append.ok, append.out)

  // Modify an entry (and regenerate, so only the append-only rule can catch it).
  const f = t.data.entryPath(fp(1))
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"release-1.0.0"', '"hotfix-1.0.1"'))
  t.views(); t.commit('modify')
  const mod = t.check('HEAD~1')
  assert.ok(!mod.ok)
  assert.ok(mod.out.includes(`append-only: modified registry/nitro-contracts/entries/${fp(1)}.json\n`), mod.out)

  fs.rmSync(t.data.entryPath(fp(2))); t.views(); t.commit('delete')
  assert.ok(t.check('HEAD~1').out.includes(`append-only: deleted registry/nitro-contracts/entries/${fp(2)}.json\n`))

  // A hand-edited generated file.
  const shard = path.join(t.dir, 'registry/by-length/101.json')
  fs.writeFileSync(shard, fs.readFileSync(shard, 'utf8').replace('"tags": []', '"tags": ["v9.9.9"]'))
  const edited = t.check()
  assert.ok(!edited.ok)
  assert.match(edited.out, /registry\/by-length\/101\.json differs/)

  // A schema violation.
  fs.mkdirSync(path.join(t.dir, 'registry/nitro-contracts/tags'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, 'registry/nitro-contracts/tags/v1.0.0.json'), '{"tag": "v1.0.0"}\n')
  assert.match(t.check().out, /schema: registry\/nitro-contracts\/tags\/v1\.0\.0\.json/)
  t.close()
})

test('ci-check: append-only compares content, so the move into registry/ passes and an edit or a deletion after it fails', () => {
  const t = setup()
  // The base: the layout before registry/, with per-source views.
  t.data.writeEntry(entry(1)); t.data.writeEntry(entry(2)); t.data.writeTag(tag('v1.0.0', 1))
  fs.renameSync(path.join(t.dir, 'registry/nitro-contracts'), path.join(t.dir, 'nitro-contracts'))
  fs.rmSync(path.join(t.dir, 'registry'), { recursive: true, force: true })
  fs.mkdirSync(path.join(t.dir, 'nitro-contracts/by-length'))
  fs.writeFileSync(path.join(t.dir, 'nitro-contracts/by-length/101.json'), '{}\n')
  fs.writeFileSync(path.join(t.dir, 'nitro-contracts/index.json'), '{}\n')
  t.commit('old layout')

  // The move: the old views deleted, git mv, the new views generated.
  t.g('rm', '-rq', 'nitro-contracts/by-length', 'nitro-contracts/index.json')
  fs.mkdirSync(path.join(t.dir, 'registry'))
  t.g('mv', 'nitro-contracts', 'registry/nitro-contracts')
  t.views(); t.commit('move')
  const moved = t.check('HEAD~1')
  assert.ok(moved.ok, moved.out)
  assert.match(moved.out, /append-only: ok/)
  // Git sees renames, so `git log --follow` works per file.
  assert.match(t.g('diff', '--name-status', '-M', 'HEAD~1', 'HEAD'), new RegExp(`R100\tnitro-contracts/entries/${fp(1)}.json\tregistry/nitro-contracts/entries/${fp(1)}.json`))

  // Modified after the move, compared with the old layout.
  const f = t.data.entryPath(fp(1))
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"release-1.0.0"', '"hotfix-1.0.1"'))
  t.views(); t.commit('modify')
  const mod = t.check('HEAD~2')
  assert.ok(!mod.ok)
  assert.ok(mod.out.includes(`append-only: modified nitro-contracts/entries/${fp(1)}.json (moved to registry/nitro-contracts/entries/${fp(1)}.json)\n`), mod.out)
  assert.match(mod.out, /append-only: 1 violation\(s\)/)
  t.g('-c', 'user.name=t', '-c', 'user.email=t@t', 'revert', '--no-edit', 'HEAD')

  // Deleted after the move; and a tag file moved to the wrong source's directory counts as deleted.
  t.g('rm', '-q', `registry/nitro-contracts/entries/${fp(2)}.json`)
  fs.mkdirSync(path.join(t.dir, 'registry/other/tags'), { recursive: true })
  t.g('mv', 'registry/nitro-contracts/tags/v1.0.0.json', 'registry/other/tags/v1.0.0.json')
  t.views(); t.commit('delete')
  const del = t.check('HEAD~4') // the old layout
  assert.ok(!del.ok)
  assert.ok(del.out.includes(`append-only: deleted nitro-contracts/entries/${fp(2)}.json (no registry/nitro-contracts/entries/${fp(2)}.json)\n`), del.out)
  assert.ok(del.out.includes('append-only: deleted nitro-contracts/tags/v1.0.0.json (no registry/nitro-contracts/tags/v1.0.0.json)\n'), del.out)
  t.close()
})

test('ci-check: data outside the layout fails', () => {
  const t = setup()
  t.data.writeEntry(entry(1)); t.views(); t.commit('one')
  assert.ok(t.check().ok)

  // A publish in the old layout landing after the move; an unconfigured source; a stray file.
  fs.mkdirSync(path.join(t.dir, 'nitro-contracts/entries'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, `nitro-contracts/entries/${fp(2)}.json`), JSON.stringify(entry(2)))
  fs.mkdirSync(path.join(t.dir, 'registry/old-source/entries'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, 'registry/notes.md'), 'notes\n')
  // Per-source views, as before registry/, inside a source's directory.
  fs.mkdirSync(path.join(t.dir, 'registry/nitro-contracts/by-length'))
  fs.writeFileSync(path.join(t.dir, 'registry/nitro-contracts/by-length/101.json'), '{}\n')
  const r = t.check()
  assert.ok(!r.ok)
  for (const line of [
    "layout: nitro-contracts/: a source's data at the top of the repo; it belongs in registry/nitro-contracts/",
    "layout: registry/old-source/: not a configured source's directory, registry/by-length/ or registry/index.json",
    "layout: registry/notes.md: not a configured source's directory, registry/by-length/ or registry/index.json",
    'layout: 3 problem(s)',
    'schema: registry/nitro-contracts/by-length/101.json: unexpected file',
  ]) assert.ok(r.out.includes(line), `${line}\n---\n${r.out}`)
  t.close()
})

test('ci-check: no two sources share a directory, a repo or an npm package, and each config sits in its directory', () => {
  const t = setup()
  t.views(); t.commit('nothing yet')
  const cfg = JSON.parse(fs.readFileSync(path.join(t.dir, 'config/nitro-contracts/sources.json'), 'utf8'))
  fs.mkdirSync(path.join(t.dir, 'config/other'))
  fs.writeFileSync(path.join(t.dir, 'config/other/sources.json'), JSON.stringify({ ...cfg, directory: 'other' }))
  const repo = t.check()
  assert.ok(!repo.ok)
  for (const line of [
    'sources: repo OffchainLabs/nitro-contracts is configured by more than one source: config/nitro-contracts/sources.json, config/other/sources.json',
    'sources: npm package @arbitrum/nitro-contracts is in the npmPackages of more than one source: config/nitro-contracts/sources.json, config/other/sources.json',
  ]) assert.ok(repo.out.includes(line), `${line}\n---\n${repo.out}`)

  fs.writeFileSync(path.join(t.dir, 'config/other/sources.json'), JSON.stringify({ ...cfg, repo: 'OffchainLabs/other' }))
  const dir = t.check()
  for (const line of [
    'sources: config/other/sources.json: directory nitro-contracts must equal its config directory\'s name, other',
    'sources: directory nitro-contracts is configured by more than one source: config/nitro-contracts/sources.json, config/other/sources.json',
  ]) assert.ok(dir.out.includes(line), `${line}\n---\n${dir.out}`)
  t.close()
})

test("ci-check: a source's outOfScopeGetters is the file the walker reads, config/<source>/out-of-scope-getters.json", () => {
  const t = setup()
  t.views(); t.commit('nothing yet')
  assert.ok(t.check().ok)
  const cfgFile = path.join(t.dir, 'config/nitro-contracts/sources.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  // Another file, valid on its own: publish would check against it, the walker against the default.
  fs.copyFileSync(path.join(t.dir, 'config/nitro-contracts/out-of-scope-getters.json'), path.join(t.dir, 'config/nitro-contracts/getters.json'))
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, outOfScopeGetters: 'config/nitro-contracts/getters.json' }))
  const bad = t.check()
  assert.ok(!bad.ok)
  assert.ok(bad.out.includes('sources: config/nitro-contracts/sources.json: outOfScopeGetters is config/nitro-contracts/getters.json, but the walker reads config/nitro-contracts/out-of-scope-getters.json; make it that file\n'), bad.out)
  // Another source's list (a copied config) is as wrong; the same path, written another way, is fine.
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, outOfScopeGetters: 'config/other/out-of-scope-getters.json' }))
  assert.match(t.check().out, /sources: config\/nitro-contracts\/sources\.json: outOfScopeGetters is config\/other\/out-of-scope-getters\.json, but the walker reads config\/nitro-contracts\/out-of-scope-getters\.json/)
  fs.rmSync(path.join(t.dir, 'config/nitro-contracts/getters.json'))
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, outOfScopeGetters: './config/nitro-contracts/out-of-scope-getters.json' }))
  const same = t.check()
  assert.ok(same.ok, same.out)
  t.close()
})

test('ci-check: same-length entries that mask different bytes fail, manual entries included, until the pair is reviewed', () => {
  const t = setup()
  const built: Entry = { ...entry(1), codeLength: 300, maskedRanges: [{ name: 'maxDataSize', type: 'uint256', offsets: [10], length: 32 }] }
  const same: Entry = { ...entry(3), codeLength: 300, maskedRanges: [{ name: 'otherName', type: 'uint256', offsets: [10], length: 32 }] }
  const manual: Entry = { ...entry(2), codeLength: 300, ref: null, commit: null, compiler: null, label: 'patched one-off' }
  t.data.writeEntry(built); t.data.writeEntry(same); t.views(); t.commit('same bytes')
  const ok1 = t.check('HEAD')
  assert.ok(ok1.ok, ok1.out)
  assert.match(ok1.out, /ranges: ok/)

  t.data.writeEntry(manual); t.views(); t.commit('a manual entry that masks less')
  const bad = t.check('HEAD~1')
  assert.ok(!bad.ok)
  assert.match(bad.out, /ranges: 2 pair\(s\) of entries with the same code length mask different bytes/)
  assert.ok(bad.out.includes(`ranges: - 300-byte entries ${fp(1)} in nitro-contracts (src/X1.sol:X1) and ${fp(2)} in nitro-contracts (src/X2.sol:X2)`), bad.out)
  assert.ok(bad.out.includes(`ranges:     masked only by ${fp(1)}: bytes 10-41 (maxDataSize)`), bad.out)
  assert.ok(bad.out.includes(`ranges:     masked only by ${fp(3)}: bytes 10-41 (otherName)`), bad.out)
  assert.match(bad.out, /ranges: 2 conflicting pair\(s\)/)
  assert.match(bad.out, /append-only: ok/, 'only the range check fails')

  // Review one pair: the other still fails. Review both: CI passes.
  const cfgFile = path.join(t.dir, 'config/nitro-contracts/sources.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.reviewedRangePairs = [{ fingerprints: [fp(2), fp(1)], note: 'rebuilt both; they differ at byte 0, which neither masks' }]
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  const half = t.check()
  assert.ok(!half.ok)
  assert.match(half.out, /ranges: 1 conflicting pair\(s\)/)
  cfg.reviewedRangePairs.push({ fingerprints: [fp(2), fp(3)], note: 'same' })
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  const ok2 = t.check()
  assert.ok(ok2.ok, ok2.out)
  t.close()
})

/** A second configured source, `other` (repo Example/other), alongside nitro-contracts. */
function addOther(dir: string): SourceData {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config/nitro-contracts/sources.json'), 'utf8'))
  fs.mkdirSync(path.join(dir, 'config/other'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config/other/sources.json'), JSON.stringify({
    ...cfg, directory: 'other', repo: 'Example/other', url: 'https://github.com/Example/other.git', npmPackages: ['@example/other'], reviewedRangePairs: [], outOfScopeGetters: 'config/other/out-of-scope-getters.json',
  }))
  fs.writeFileSync(path.join(dir, 'config/other/out-of-scope-getters.json'), JSON.stringify({ schemaVersion: 1, repo: 'Example/other', getters: {} }))
  return new SourceData(dir, 'other', 'Example/other')
}

test('ci-check: across sources, a fingerprint has one entry, and every tag and branch fingerprint has an entry in some source', () => {
  const t = setup()
  const other = addOther(t.dir)
  // nitro-contracts owns fp 1; other's tag lists it too (shared code), and other owns fp 2.
  t.data.writeEntry(entry(1)); t.data.writeTag(tag('v1.0.0', 1))
  other.writeEntry({ ...entry(2), repo: 'Example/other' })
  other.writeTag({ ...tag('v9.0.0', 1), repo: 'Example/other', contracts: { 'lib/X1.sol:X1': fp(1), 'src/X2.sol:X2': fp(2) } })
  other.writeBranch({ schemaVersion: 1, repo: 'Example/other', branch: 'release/x', commit: '8'.repeat(40), contracts: { 'src/X2.sol:X2': fp(2) } })
  t.views(); t.commit('two sources, shared code')
  const ok = t.check('HEAD')
  assert.ok(ok.ok, ok.out)
  assert.match(ok.out, /entries: ok \(one entry per fingerprint across sources; every tag and branch fingerprint has one\)/)

  // The same fingerprint's entry in both sources' directories (each valid on its own).
  other.writeEntry({ ...entry(1), repo: 'Example/other' }); t.views()
  const dup = t.check()
  assert.ok(!dup.ok)
  assert.ok(dup.out.includes(`entries: ${fp(1)} has an entry in more than one source: registry/nitro-contracts/entries/${fp(1)}.json, registry/other/entries/${fp(1)}.json\n`), dup.out)
  assert.match(dup.out, /schema validation: ok/)
  assert.match(dup.out, /generated files match their inputs/)
  fs.rmSync(other.entryPath(fp(1))); t.views()
  assert.ok(t.check().ok)

  // A tag and a branch file listing fingerprints that have no entry in any source.
  other.writeTag({ ...tag('v9.1.0', 2), repo: 'Example/other', contracts: { 'src/X2.sol:X2': fp(2), 'src/X7.sol:X7': fp(7) } })
  other.writeBranch({ schemaVersion: 1, repo: 'Example/other', branch: 'release/x', commit: '8'.repeat(40), contracts: { 'src/X8.sol:X8': fp(8) } })
  t.views()
  const dangling = t.check()
  assert.ok(!dangling.ok)
  for (const line of [
    `entries: registry/other/branches/release/x.json: src/X8.sol:X8 has fingerprint ${fp(8)}, which has no entry in any source\n`,
    `entries: registry/other/tags/v9.1.0.json: src/X7.sol:X7 has fingerprint ${fp(7)}, which has no entry in any source\n`,
    'entries: 2 problem(s)',
  ]) assert.ok(dangling.out.includes(line), `${line}\n---\n${dangling.out}`)
  t.close()
})

test("ci-check: shared code must have its owner's entry's role in every other source's contractRoles that lists it", () => {
  const t = setup()
  const other = addOther(t.dir)
  // nitro-contracts owns fp 1 (logic); two of other's tag files and a branch file list it as lib/X1.sol:X1.
  t.data.writeEntry(entry(1)); t.data.writeTag(tag('v1.0.0', 1))
  for (const v of ['v9.0.0', 'v9.1.0']) other.writeTag({ ...tag(v, 1), repo: 'Example/other', contracts: { 'lib/X1.sol:X1': fp(1) } })
  other.writeBranch({ schemaVersion: 1, repo: 'Example/other', branch: 'release/x', commit: '8'.repeat(40), contracts: { 'lib/X1.sol:X1': fp(1) } })
  t.views(); t.commit('shared code')
  const ok = t.check('HEAD')
  assert.ok(ok.ok, ok.out)
  assert.match(ok.out, /roles: ok/)

  // other's config gives the shared contract another role than the owner's entry has.
  const cfgFile = path.join(t.dir, 'config/other/sources.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, contractRoles: { ...cfg.contractRoles, 'lib/X1.sol:X1': { role: 'proxy-admin' } } }))
  const bad = t.check()
  assert.ok(!bad.ok)
  for (const line of [
    `roles: registry/other/branches/release/x.json and 2 other file(s): shared code's role disagrees with its owner's entry. ${fp(1)}: config/other/sources.json gives lib/X1.sol:X1 the role proxy-admin, ` +
      `but the entry registry/nitro-contracts/entries/${fp(1)}.json (src/X1.sol:X1, its role from config/nitro-contracts/sources.json) has the role logic.`,
    'roles: 1 problem(s)',
  ]) assert.ok(bad.out.includes(line), `${line}\n---\n${bad.out}`)
  assert.match(bad.out, /entries: ok/)

  // The owner's own config isn't rechecked against its entries (a proxy listed after its first build keeps its entry).
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  const ncFile = path.join(t.dir, 'config/nitro-contracts/sources.json')
  const nc = JSON.parse(fs.readFileSync(ncFile, 'utf8'))
  fs.writeFileSync(ncFile, JSON.stringify({ ...nc, contractRoles: { ...nc.contractRoles, 'src/X1.sol:X1': { role: 'proxy-admin' } } }))
  const own = t.check()
  assert.ok(own.ok, own.out)
  t.close()
})

test('ci-check: same-length entries of two sources that mask different bytes fail, until the pair is listed in either source\'s config', () => {
  const t = setup()
  const other = addOther(t.dir)
  t.data.writeEntry({ ...entry(1), codeLength: 300, maskedRanges: [{ name: 'maxDataSize', type: 'uint256', offsets: [10], length: 32 }] })
  other.writeEntry({ ...entry(2), repo: 'Example/other', codeLength: 300 })
  t.views(); t.commit('a conflict across sources')
  const bad = t.check('HEAD')
  assert.ok(!bad.ok)
  for (const line of [
    'ranges: 1 pair(s) of entries with the same code length mask different bytes',
    `ranges: - 300-byte entries ${fp(1)} in nitro-contracts (src/X1.sol:X1) and ${fp(2)} in other (src/X2.sol:X2)\n`,
    'ranges:     once reviewed, add to reviewedRangePairs in config/nitro-contracts/sources.json or config/other/sources.json: ',
    'ranges: 1 conflicting pair(s)',
  ]) assert.ok(bad.out.includes(line), `${line}\n---\n${bad.out}`)

  const pair = { fingerprints: [fp(1), fp(2)], note: 'rebuilt both; they differ at byte 0, which neither masks' }
  for (const listedIn of ['other', 'nitro-contracts']) {
    for (const s of ['other', 'nitro-contracts']) {
      const f = path.join(t.dir, `config/${s}/sources.json`)
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), reviewedRangePairs: s === listedIn ? [pair] : [] }))
    }
    const ok = t.check()
    assert.ok(ok.ok, `listed in ${listedIn}\n${ok.out}`)
    assert.match(ok.out, /ranges: ok/)
  }
  t.close()
})

test('ci-check: a proxy that forwards to one implementation must list the EIP-1967 slot getVersion reads', () => {
  const t = setup()
  const OTHER = `0x${'ab'.repeat(32)}` as const
  const proxy = (n: number, extra: Partial<Entry>): Entry => ({ ...entry(n), role: 'proxy', ...extra })
  t.data.writeEntry(proxy(1, { implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] }))
  t.data.writeEntry(proxy(2, { beaconSlot: EIP1967_BEACON_SLOT }))
  t.data.writeEntry(proxy(3, { implementationSlots: [OTHER, SECONDARY_IMPLEMENTATION_SLOT] })) // getVersion reads no slot of a known two-slot proxy
  t.views()
  const ok = t.check()
  assert.ok(ok.ok, ok.out)
  assert.match(ok.out, /proxies: ok \(every proxy that forwards to one implementation lists the EIP-1967 slot getVersion reads\)/)

  t.data.writeEntry(proxy(4, { implementationSlots: [OTHER] }))
  t.data.writeEntry(proxy(5, { beaconSlot: OTHER }))
  t.views()
  const bad = t.check()
  assert.ok(!bad.ok)
  for (const line of [
    `proxies: registry/nitro-contracts/entries/${fp(4)}.json: src/X4.sol:X4 is a proxy that forwards to one implementation, but its implementation slot is ${OTHER}, not EIP-1967's ${EIP1967_IMPLEMENTATION_SLOT}. getVersion reads only EIP-1967's slots for such a proxy`,
    `proxies: registry/nitro-contracts/entries/${fp(5)}.json: src/X5.sol:X5 is a proxy that forwards to one implementation, but its beacon slot is ${OTHER}, not EIP-1967's ${EIP1967_BEACON_SLOT}.`,
    'proxies: 2 problem(s)',
  ]) assert.ok(bad.out.includes(line), `${line}\n---\n${bad.out}`)
  t.close()
})
