// Publishing across sources, end to end, on two tiny local source repos built with forge (no test
// chains; network only if forge has to download solc 0.8.17). Both repos compile the same
// contract S. Sources are published in id order whatever order --source names them, so alpha
// owns S: beta's build writes no entry for it, beta's tag file lists its fingerprint, and the
// view gives S alpha's tags only. A role in beta's contractRoles that disagrees with alpha's entry
// fails the run and publishes nothing. A range conflict with another source's entry fails the run
// until the pair is listed in either source's config. So does a proxy that forwards to one
// implementation through a slot other than EIP-1967's, until contractRoles lists EIP-1967's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { publish } from '../src/lib/publish.ts'
import { LocalAlertSink } from '../src/lib/alerts.ts'
import { stableJson } from '../src/lib/json.ts'
import { DataRepo, SourceData } from '../src/lib/datarepo.ts'
import type { ByLengthFile, Entry, IndexFile } from '../src/lib/types.ts'
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/walker/proxy.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim()

const contract = (name: string, body: string) => `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.17;\ncontract ${name} {\n${body}\n}\n`
const S = contract('S', '  function owner() external view returns (address) { return address(this); }\n  function s() external pure returns (uint256) { return 42; }')
const A = contract('A', '  function a() external pure returns (uint256) { return 1; }')
const B = (v: number) => contract('B', `  function f() external pure returns (uint256) { return ${v}; }`)

function sourcesJson(id: string, startTag: string): Record<string, any> {
  return {
    schemaVersion: 1, repo: `Example/${id}`, url: `https://github.com/Example/${id}.git`, directory: id, npmPackages: [id],
    start: { tag: startTag }, publishedRefs: { tags: ['v*'], branches: ['release-*'] },
    tagValidation: { rule: 'tag-equals-v-package-version', allowlist: {} },
    outOfScopeGetters: `config/${id}/out-of-scope-getters.json`,
    contractRoles: {}, reviewedRangePairs: [], testChains: null, reconcileGraceMinutes: 0,
    builds: [{
      name: 'forge', when: {}, toolchain: {}, setup: [],
      outputs: [{ name: 'forge', commands: ['forge build --build-info --force'], buildInfo: 'out/build-info', layout: 'standard-json', deployed: true }],
      include: ['src/**'], exclude: [],
    }],
  }
}

test('publish across sources: shared code has one entry, its owner\'s; roles must agree; the range invariant spans sources', { timeout: 10 * 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cross-'))
  // --- Source repos, at the paths their https://github.com/Example/<id>.git URLs are redirected to ---
  const hosted = path.join(tmp, 'github')
  const repoDir = (id: string) => path.join(hosted, `${id}.git`)
  const write = (id: string, f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repoDir(id), f)), { recursive: true }); fs.writeFileSync(path.join(repoDir(id), f), s) }
  const release = (id: string, version: string) => {
    write(id, 'package.json', JSON.stringify({ name: id, version }) + '\n')
    git(repoDir(id), 'add', '-A'); git(repoDir(id), 'commit', '-qm', version); git(repoDir(id), 'tag', `v${version}`)
  }
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(repoDir(id), { recursive: true })
    git(hosted, 'init', '-q', repoDir(id))
    write(id, 'foundry.toml', "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.17'\nbytecode_hash = 'none'\noptimizer = true\noptimizer_runs = 200\nevm_version = 'london'\n")
    write(id, 'src/S.sol', S)
  }
  write('alpha', 'src/A.sol', A); release('alpha', '1.0.0')
  write('beta', 'src/B.sol', B(1)); release('beta', '2.0.0')

  // --- Data repo ---
  const data = path.join(tmp, 'data')
  fs.cpSync(path.join(ROOT, 'schema'), path.join(data, 'schema'), { recursive: true })
  for (const [id, start] of [['alpha', 'v1.0.0'], ['beta', 'v2.0.0']]) {
    fs.mkdirSync(path.join(data, 'config', id), { recursive: true })
    fs.writeFileSync(path.join(data, `config/${id}/sources.json`), stableJson(sourcesJson(id, start)))
    fs.writeFileSync(path.join(data, `config/${id}/out-of-scope-getters.json`), stableJson({ schemaVersion: 1, repo: `Example/${id}`, getters: {} }))
  }
  git(tmp, 'init', '-q', data); git(data, 'add', '-A'); git(data, 'commit', '-qm', 'config')
  const first = git(data, 'rev-parse', 'HEAD')
  const setConfig = (id: string, change: (c: any) => void) => {
    const f = path.join(data, `config/${id}/sources.json`)
    const c = JSON.parse(fs.readFileSync(f, 'utf8')); change(c); fs.writeFileSync(f, stableJson(c))
    git(data, 'commit', '-qam', `config ${id}`)
  }

  const workDir = path.join(tmp, 'work')
  const alertsDir = path.join(tmp, 'alerts')
  const alpha = new SourceData(data, 'alpha', 'Example/alpha')
  const beta = new SourceData(data, 'beta', 'Example/beta')
  const tagFile = (s: SourceData, t: string) => JSON.parse(fs.readFileSync(s.tagPath(t), 'utf8'))
  const shard = (len: number): ByLengthFile => JSON.parse(fs.readFileSync(path.join(data, `registry/by-length/${len}.json`), 'utf8'))
  const ciCheck = () => spawnSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', data, '--base', first], { encoding: 'utf8' })
  const run = (source: string) => publish({ dataRepo: data, workDir, source, alerts: new LocalAlertSink(alertsDir), sourceUrl: repoDir(source), log: () => {} })

  // --- Run 1: the CLI, naming beta first. alpha (first by id) is published first and owns S. ---
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'tools/src/cli/publish.ts'), '--data-repo', data, '--work-dir', workDir, '--source', 'beta', '--source', 'alpha', '--alerts', `local:${alertsDir}`], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${hosted}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/Example/' },
  })
  assert.equal(cli.status, 0, cli.stderr)
  assert.deepEqual(git(data, 'log', '--format=%s', `${first}..HEAD`).split('\n').map(s => s.split(':')[0]), ['beta', 'alpha'], 'one commit per source, alpha first')
  const sFp = tagFile(alpha, 'v1.0.0').contracts['src/S.sol:S']
  assert.equal(tagFile(beta, 'v2.0.0').contracts['src/S.sol:S'], sFp, "beta's build reproduces S")
  assert.ok(alpha.hasEntry(sFp))
  assert.ok(!beta.hasEntry(sFp), 'no second entry for shared code')
  assert.deepEqual(beta.entries().map(e => e.contracts), [['src/B.sol:B']])
  const sEntry = alpha.readEntry(sFp)
  const rows = shard(sEntry.codeLength).entries.filter(e => e.fingerprint === sFp)
  assert.deepEqual(rows.map(e => [e.repo, e.ref, e.tags]), [['Example/alpha', 'v1.0.0', ['v1.0.0']]], "S's tags are its owner's: not beta's v2.0.0")
  const index: IndexFile = JSON.parse(fs.readFileSync(path.join(data, 'registry/index.json'), 'utf8'))
  assert.deepEqual(index.sources.beta.getters.map(g => g.signature), ['owner()'], "beta's one getter is the shared code's, which its tag lists")
  const ci1 = ciCheck()
  assert.equal(ci1.status, 0, ci1.stderr)
  assert.match(ci1.stderr, /entries: ok/)

  // --- Run 2: beta's contractRoles gives S another role than alpha's entry: nothing published. ---
  setConfig('beta', c => { c.contractRoles = { 'src/S.sol:S': { role: 'proxy-admin' } } })
  write('beta', 'src/B.sol', B(2)); release('beta', '2.1.0')
  const head2 = git(data, 'rev-parse', 'HEAD')
  const r2 = await run('beta')
  assert.deepEqual(Object.keys(r2.failures), ['publish-error'])
  const roleErr = r2.failures['publish-error']![0].message
  for (const part of [
    `shared code's role disagrees with its owner's entry; nothing published. ${sFp}: config/beta/sources.json gives src/S.sol:S the role proxy-admin,`,
    `but the entry registry/alpha/entries/${sFp}.json (src/S.sol:S, its role from config/alpha/sources.json) has the role logic.`,
    'make contractRoles in config/beta/sources.json agree with it.',
  ]) assert.ok(roleErr.includes(part), `${part}\n---\n${roleErr}`)
  assert.equal(r2.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head2)
  assert.equal(git(data, 'status', '--porcelain'), '', "the run's files are discarded")
  assert.ok(!beta.hasTag('v2.1.0'))
  assert.equal(beta.entries().length, 1, 'B@2 not published either')
  // CI catches the same config against the tag file already published.
  const ciRoles = ciCheck()
  assert.notEqual(ciRoles.status, 0)
  assert.ok(ciRoles.stderr.includes(`roles: registry/beta/tags/v2.0.0.json: shared code's role disagrees with its owner's entry. ${sFp}: config/beta/sources.json gives src/S.sol:S the role proxy-admin,`), ciRoles.stderr)

  // Roles agreeing again, the tag is published; S still has only alpha's entry.
  setConfig('beta', c => { c.contractRoles = {} })
  const r2b = await run('beta')
  assert.ok(r2b.ok, JSON.stringify(r2b.failures))
  assert.deepEqual([r2b.tagsAdded, r2b.newEntries], [['v2.1.0'], 1])
  assert.equal(tagFile(beta, 'v2.1.0').contracts['src/S.sol:S'], sFp)
  assert.ok(!beta.hasEntry(sFp))

  // --- Run 3: a new beta entry conflicts with an alpha entry of its length: nothing published. ---
  // A manual entry in alpha with B's code length that masks one more range. Its pairs with the
  // existing entries of that length are reviewed (in beta's config); its pair with the new B@3 isn't.
  const bs = beta.entries()
  assert.equal(new Set(bs.map(e => e.codeLength)).size, 1, 'every B build has one length')
  const len = bs[0].codeLength
  const manual: Entry = {
    schemaVersion: 1, fingerprint: `0x${'ab'.repeat(32)}`, repo: 'Example/alpha', contracts: ['src/A.sol:A'], role: 'logic',
    codeLength: len, maskedRanges: [{ name: 'patched', type: 'uint256', offsets: [0], length: 32 }], cborMetadataLength: bs[0].cborMetadataLength,
    getters: [], selectors: [], compiler: null, ref: null, commit: null, label: 'A, patched one-off',
  }
  alpha.writeEntry(manual); DataRepo.open(data).writeViews()
  const sameLength = [...alpha.entries(), ...beta.entries()].filter(e => e.codeLength === len && e.fingerprint !== manual.fingerprint)
  git(data, 'add', '-A'); git(data, 'commit', '-qm', 'a manual entry in alpha')
  setConfig('beta', c => { c.reviewedRangePairs = sameLength.map(e => ({ fingerprints: [manual.fingerprint, e.fingerprint], note: 'test: reviewed' })) })
  write('beta', 'src/B.sol', B(3)); release('beta', '2.2.0')
  const head3 = git(data, 'rev-parse', 'HEAD')
  const r3 = await run('beta')
  assert.deepEqual(Object.keys(r3.failures), ['publish-error'])
  const rangeErr = r3.failures['publish-error']![0]
  assert.match(rangeErr.message, /^range invariant broken; nothing published\. 1 pair\(s\) of entries with the same code length mask different bytes/)
  for (const part of [
    `${manual.fingerprint} in alpha (src/A.sol:A)`,
    ' in beta (src/B.sol:B)',
    'bytes 0-31 (patched)',
    'once reviewed, add to reviewedRangePairs in config/alpha/sources.json or config/beta/sources.json: ',
  ]) assert.ok(rangeErr.details!.includes(part), `${part}\n---\n${rangeErr.details}`)
  assert.equal(r3.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head3)
  assert.equal(git(data, 'status', '--porcelain'), '')
  assert.ok(!beta.hasTag('v2.2.0'))

  // The pair listed in alpha's config, not the publishing source's: B@3 is published.
  const snippet = JSON.parse(/once reviewed, add to reviewedRangePairs in .*: (\{.*\})$/m.exec(rangeErr.details!)![1])
  setConfig('alpha', c => { c.reviewedRangePairs.push({ ...snippet, note: 'test: rebuilt both; they differ at a byte neither masks' }) })
  const r3b = await run('beta')
  assert.ok(r3b.ok, JSON.stringify(r3b.failures))
  assert.deepEqual([r3b.tagsAdded, r3b.newEntries], [['v2.2.0'], 1])

  // --- Run 4: a proxy that forwards to one implementation through a slot getVersion doesn't read: nothing published. ---
  const otherSlot = `0x${'ab'.repeat(32)}`
  setConfig('alpha', c => { c.contractRoles = { 'src/A.sol:A': { role: 'proxy', implementationSlots: [otherSlot] } } })
  write('alpha', 'src/A.sol', contract('A', '  function a() external pure returns (uint256) { return 2; }\n  function b() external pure returns (uint256) { return 3; }\n  function c() external pure returns (uint256) { return 4; }'))
  release('alpha', '1.1.0')
  const head4 = git(data, 'rev-parse', 'HEAD')
  const r4 = await run('alpha')
  assert.deepEqual(Object.keys(r4.failures), ['publish-error'])
  const slotErr = r4.failures['publish-error']![0].message
  assert.match(slotErr, /^a proxy's slot isn't one getVersion reads; nothing published\. registry\/alpha\/entries\/0x[0-9a-f]{64}\.json: /)
  assert.ok(slotErr.includes(`src/A.sol:A is a proxy that forwards to one implementation, but its implementation slot is ${otherSlot}, not EIP-1967's ${EIP1967_IMPLEMENTATION_SLOT}.`), slotErr)
  assert.equal(r4.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head4)
  assert.equal(git(data, 'status', '--porcelain'), '')
  assert.ok(!alpha.hasTag('v1.1.0'))
  // With EIP-1967's slot, it is published.
  setConfig('alpha', c => { c.contractRoles = { 'src/A.sol:A': { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] } } })
  const r4b = await run('alpha')
  assert.ok(r4b.ok, JSON.stringify(r4b.failures))
  assert.deepEqual([r4b.tagsAdded, r4b.newEntries], [['v1.1.0'], 1])

  // CI's checks pass over everything, against the config-only commit.
  const ci2 = ciCheck()
  assert.equal(ci2.status, 0, ci2.stderr)
  fs.rmSync(tmp, { recursive: true, force: true })
})
