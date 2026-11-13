import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { SourceData } from '../src/lib/datarepo.ts'
import type { Entry } from '../src/lib/types.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLI = path.join(ROOT, 'tools/src/cli/ci-check.ts')
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const entry = (n: number): Entry => ({
  schemaVersion: 1, fingerprint: fp(n), repo: 'OffchainLabs/nitro-contracts', contracts: [`src/X${n}.sol:X${n}`], role: 'logic', codeLength: 100 + n,
  maskedRanges: [], cborMetadataLength: 12, getters: [], selectors: [],
  compiler: { language: 'Solidity', version: '0.8.17', evmVersion: 'london', optimizer: { enabled: true, runs: 2000 }, viaIR: false, metadata: { bytecodeHash: 'none', appendCBOR: true } },
  ref: 'release-1.0.0', commit: n.toString(16).padStart(40, '0'),
})

function setup(): { dir: string; data: SourceData; commit: (m: string) => void; check: (base?: string) => { ok: boolean; out: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-ci-'))
  for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  const data = new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts')
  return {
    dir, data,
    commit: m => { g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', m) },
    check: base => {
      const r = spawnSync(process.execPath, [CLI, '--data-repo', dir, ...(base ? ['--base', base] : [])], { encoding: 'utf8' })
      return { ok: r.status === 0, out: r.stderr + r.stdout }
    },
  }
}

test('ci-check: appends pass; modified or deleted entries fail; hand-edited views fail', () => {
  const t = setup()
  t.data.writeEntry(entry(1)); t.data.writeViews(); t.commit('one')
  assert.ok(t.check('HEAD').ok)

  t.data.writeEntry(entry(2)); t.data.writeViews(); t.commit('append')
  const append = t.check('HEAD~1')
  assert.ok(append.ok, append.out)

  // Modify an entry (and regenerate, so only the append-only rule can catch it).
  const f = t.data.entryPath(fp(1))
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"release-1.0.0"', '"hotfix-1.0.1"'))
  t.data.writeViews(); t.commit('modify')
  const mod = t.check('HEAD~1')
  assert.ok(!mod.ok)
  assert.match(mod.out, /append-only: M\tnitro-contracts\/entries\//)

  fs.rmSync(t.data.entryPath(fp(2))); t.data.writeViews(); t.commit('delete')
  assert.match(t.check('HEAD~1').out, /append-only: D\tnitro-contracts\/entries\//)

  // A hand-edited generated file.
  const shard = path.join(t.dir, 'nitro-contracts/by-length/101.json')
  fs.writeFileSync(shard, fs.readFileSync(shard, 'utf8').replace('"tags": []', '"tags": ["v9.9.9"]'))
  const edited = t.check()
  assert.ok(!edited.ok)
  assert.match(edited.out, /by-length\/101\.json differs/)

  // A schema violation.
  fs.mkdirSync(path.join(t.dir, 'nitro-contracts/tags'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, 'nitro-contracts/tags/v1.0.0.json'), '{"tag": "v1.0.0"}\n')
  assert.match(t.check().out, /schema: nitro-contracts\/tags\/v1\.0\.0\.json/)
  fs.rmSync(t.dir, { recursive: true })
})

test('ci-check: same-length entries that mask different bytes fail, manual entries included, until the pair is reviewed', () => {
  const t = setup()
  const built: Entry = { ...entry(1), codeLength: 300, maskedRanges: [{ name: 'maxDataSize', type: 'uint256', offsets: [10], length: 32 }] }
  const same: Entry = { ...entry(3), codeLength: 300, maskedRanges: [{ name: 'otherName', type: 'uint256', offsets: [10], length: 32 }] }
  const manual: Entry = { ...entry(2), codeLength: 300, ref: null, commit: null, compiler: null, label: 'patched one-off' }
  t.data.writeEntry(built); t.data.writeEntry(same); t.data.writeViews(); t.commit('same bytes')
  const ok1 = t.check('HEAD')
  assert.ok(ok1.ok, ok1.out)
  assert.match(ok1.out, /ranges: ok/)

  t.data.writeEntry(manual); t.data.writeViews(); t.commit('a manual entry that masks less')
  const bad = t.check('HEAD~1')
  assert.ok(!bad.ok)
  assert.match(bad.out, /ranges: nitro-contracts: 2 pair\(s\) of entries with the same code length mask different bytes/)
  assert.ok(bad.out.includes(`ranges: - 300-byte entries ${fp(1)} (src/X1.sol:X1) and ${fp(2)} (src/X2.sol:X2)`), bad.out)
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
  fs.rmSync(t.dir, { recursive: true })
})
