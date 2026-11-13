// The publish run's bookkeeping, end to end, on a tiny local source repo built with forge (no
// test chains; network only if forge has to download solc 0.8.17): exact first commits through merges, tag on an unpublished commit,
// tag/version mismatch, nested and deleted branches, build failures, reruns with no diff, package
// provenance, roles from the config, libraries that are never deployed, and the range invariant (a
// new entry that masks different bytes from one of its length publishes nothing until reviewed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { publish } from '../src/lib/publish.ts'
import { LocalAlertSink } from '../src/lib/alerts.ts'
import { stableJson } from '../src/lib/json.ts'
import { SourceData } from '../src/lib/datarepo.ts'
import type { Entry } from '../src/lib/types.ts'
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/walker/walk.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim()

function contract(name: string, body: string) {
  return `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.17;\ncontract ${name} {\n${body}\n}\n`
}
const A = (v: number) => contract('A', `  uint256 public immutable x;\n  constructor(uint256 _x) { x = _x; }\n  function bridge() external view returns (address) { return address(this); }\n  function list(uint256 i) external view returns (address) { return address(uint160(i)); }\n  function v() external pure returns (uint256) { return ${v}; }`)
const B = (v: number) => contract('B', `  function f() external pure returns (uint256) { return ${v}; }`)
// U uses a contract from an installed package, an internal-only library and a linked one.
const U = `// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;
import "@fake/pkg/P.sol";
library L { function f(uint256 x) internal pure returns (uint256) { return x + 1; } }
library LE { function g(uint256 x) external pure returns (uint256) { return x + 2; } }
contract U { function u(uint256 x) external pure returns (uint256) { return L.f(x) + LE.g(x); } }
`

test('publish bookkeeping on a local source repo', { timeout: 10 * 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-flow-'))
  // --- Source repo ---
  const srcDir = path.join(tmp, 'src-repo')
  fs.mkdirSync(path.join(srcDir, 'src/mocks'), { recursive: true })
  fs.mkdirSync(path.join(srcDir, 'node_modules/@fake/pkg'), { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'foundry.toml'), "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.17'\nbytecode_hash = 'none'\noptimizer = true\noptimizer_runs = 200\nevm_version = 'london'\nremappings = ['@fake/=node_modules/@fake/']\n")
  const write = (f: string, s: string) => fs.writeFileSync(path.join(srcDir, f), s)
  const pkg = (v: string) => write('package.json', JSON.stringify({ name: 'x', version: v }) + '\n')
  const commit = (m: string) => { git(srcDir, 'add', '-A'); git(srcDir, 'commit', '-qm', m); return git(srcDir, 'rev-parse', 'HEAD') }
  git(tmp, 'init', '-q', srcDir)
  write('src/A.sol', A(1)); write('src/B.sol', B(1)); write('src/mocks/M.sol', contract('M', '  function m() external {}')); pkg('1.0.0')
  // An installed package (committed here; nitro-contracts installs its own in the build's setup).
  write('node_modules/@fake/pkg/package.json', JSON.stringify({ name: '@fake/pkg', version: '1.2.3' }))
  write('node_modules/@fake/pkg/P.sol', contract('P', '  function p() external pure returns (uint256) { return 7; }'))
  write('src/U.sol', U)
  git(srcDir, 'add', '-f', 'node_modules')
  const c1 = commit('c1')
  git(srcDir, 'tag', 'v1.0.0')
  git(srcDir, 'checkout', '-qb', 'develop')
  write('src/B.sol', B(2)); const c2 = commit('c2: B=2')
  write('src/A.sol', A(2)); const c3 = commit('c3: A=2')
  write('src/B.sol', B(1)); const c4 = commit('c4: B back to 1')
  git(srcDir, 'checkout', '-qb', 'feat/x', c3)
  write('src/B.sol', B(3)); const f1 = commit('f1: B=3 on a feature branch')
  git(srcDir, 'checkout', '-q', 'develop')
  git(srcDir, 'merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'c5: merge feat/x', 'feat/x')
  pkg('1.1.0'); const c5 = commit('c5b: version 1.1.0')
  git(srcDir, 'tag', 'v1.1.0')
  git(srcDir, 'checkout', '-qb', 'unpublished', c1)
  write('src/B.sol', B(9)); const u1 = commit('u1: B=9, never on a published branch')
  git(srcDir, 'tag', 'v9.9.9') // package.json still says 1.0.0
  git(srcDir, 'checkout', '-qb', 'hotfix/y', c1)
  write('src/A.sol', A(7)); const h1 = commit('h1: A=7')
  git(srcDir, 'checkout', '-q', 'main')
  git(srcDir, 'branch', '-D', 'unpublished')

  // --- Data repo ---
  const data = path.join(tmp, 'data')
  fs.mkdirSync(path.join(data, 'config/fake'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'schema'), path.join(data, 'schema'), { recursive: true })
  fs.writeFileSync(path.join(data, 'config/fake/sources.json'), stableJson({
    schemaVersion: 1, repo: 'Example/fake', url: 'https://github.com/Example/fake.git', directory: 'fake',
    start: { tag: 'v1.0.0' }, publishedRefs: { tags: ['v*'], branches: ['main', 'hotfix*', 'release-*', 'develop'] },
    tagValidation: { rule: 'tag-equals-v-package-version', allowlist: {} },
    outOfScopeGetters: 'config/fake/out-of-scope-getters.json',
    contractRoles: { 'src/B.sol:B': { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] }, 'src/U.sol:U': { role: 'proxy-admin' } },
    reviewedRangePairs: [],
    testChains: null, reconcileGraceMinutes: 0,
    builds: [{
      name: 'forge', when: {}, toolchain: {}, setup: [],
      outputs: [{ name: 'forge', commands: ['forge build --build-info --force'], buildInfo: 'out/build-info', layout: 'standard-json', deployed: true }],
      include: ['src/**', '@fake/**'], exclude: ['src/mocks/**'],
    }],
  }))
  fs.writeFileSync(path.join(data, 'config/fake/out-of-scope-getters.json'), stableJson({ schemaVersion: 1, repo: 'Example/fake', getters: {} }))
  git(tmp, 'init', '-q', data); git(data, 'add', '-A'); git(data, 'commit', '-qm', 'config')

  const alertsDir = path.join(tmp, 'alerts')
  const alerts = new LocalAlertSink(alertsDir)
  const open = () => (fs.existsSync(alertsDir) ? fs.readdirSync(alertsDir) : []).map(f => JSON.parse(fs.readFileSync(path.join(alertsDir, f), 'utf8'))).filter(a => a.state === 'open')
  const run = () => publish({ dataRepo: data, workDir: path.join(tmp, 'work'), source: 'fake', alerts, sourceUrl: srcDir, concurrency: 4, log: () => {} })
  const entries = (): Entry[] => fs.readdirSync(path.join(data, 'fake/entries')).map(f => JSON.parse(fs.readFileSync(path.join(data, 'fake/entries', f), 'utf8')))
  const first = (name: string, commitSha: string) => entries().filter(e => e.contracts.includes(name) && e.firstCommit === commitSha)
  const tagFile = (t: string) => JSON.parse(fs.readFileSync(path.join(data, `fake/tags/${t}.json`), 'utf8'))

  // --- Run 1 ---
  const r1 = await run()
  assert.ok(r1.commit, 'committed')
  assert.equal(git(data, 'log', '-1', '--format=%H'), r1.commit, 'one commit for the whole update')
  assert.equal(git(data, 'rev-list', '--count', 'HEAD'), '2')
  // A@1,B@1 at c1 (main); B@2 at c2; A@2 at c3; B@3 first at the feature commit f1, reached through develop; A@7 at h1 (hotfix/y); B@9 only via tag.
  assert.equal(first('src/A.sol:A', c1)[0]?.firstBranch, 'main')
  assert.equal(first('src/B.sol:B', c1)[0]?.firstBranch, 'main')
  assert.equal(first('src/B.sol:B', c2)[0]?.firstBranch, 'develop')
  assert.equal(first('src/A.sol:A', c3)[0]?.firstBranch, 'develop')
  assert.equal(first('src/B.sol:B', f1)[0]?.firstBranch, 'develop', 'first commit is exact through a merge')
  assert.equal(first('src/A.sol:A', h1)[0]?.firstBranch, 'hotfix/y')
  assert.equal(first('src/B.sol:B', u1)[0]?.firstBranch, null, 'tag-only commit: firstBranch null')
  assert.equal(entries().length, 10, 'B back to 1 at c4 adds nothing; mocks excluded; P, LE and U once')
  assert.ok(!entries().some(e => e.contracts.some(c => c.includes('mocks'))))
  // Package provenance, roles from contractRoles, and no entry for the internal-only library.
  const one = (name: string) => { const es = entries().filter(e => e.contracts.includes(name)); assert.equal(es.length, 1, name); return es[0] }
  assert.deepEqual(one('node_modules/@fake/pkg/P.sol:P').packages, { 'node_modules/@fake/pkg/P.sol:P': '@fake/pkg@1.2.3' })
  assert.equal(one('node_modules/@fake/pkg/P.sol:P').role, 'logic')
  assert.ok(!('packages' in one('src/U.sol:U')))
  assert.equal(one('src/U.sol:U').role, 'proxy-admin')
  assert.equal(one('src/U.sol:LE').role, 'logic')
  assert.ok(!entries().some(e => e.contracts.includes('src/U.sol:L')), 'internal-only library skipped')
  assert.ok(!('src/U.sol:L' in tagFile('v1.0.0').contracts))
  for (const e of entries()) {
    if (e.contracts.includes('src/B.sol:B')) assert.deepEqual([e.role, e.implementationSlots], ['proxy', [EIP1967_IMPLEMENTATION_SLOT]])
    if (e.contracts.includes('src/A.sol:A')) assert.deepEqual([e.role, e.implementationSlots], ['logic', undefined])
  }
  const a1 = entries().find(e => e.contracts.includes('src/A.sol:A') && e.firstCommit === c1)!
  assert.deepEqual(a1.maskedRanges.map(r => r.name), ['x'])
  assert.deepEqual(a1.getters.map(g => [g.signature, g.kind]), [['bridge()', 'single'], ['list(uint256)', 'list']])
  assert.equal(tagFile('v1.1.0').commit, c5)
  assert.equal(tagFile('v9.9.9').packageVersion, '1.0.0')
  assert.ok(fs.existsSync(path.join(data, 'fake/branches/hotfix/y.json')))
  assert.deepEqual(Object.keys(r1.failures), ['tag-version-mismatch'])
  assert.equal(open().length, 1)
  // Derived tags: B@1 only in v1.0.0 (v1.1.0 has B@3); A@2 and B@3 in v1.1.0.
  const shardOf = (e: Entry) => JSON.parse(fs.readFileSync(path.join(data, `fake/by-length/${e.codeLength}.json`), 'utf8')).entries.find((x: any) => x.fingerprint === e.fingerprint)
  assert.deepEqual(shardOf(first('src/B.sol:B', c1)[0]).tags, ['v1.0.0'])
  assert.deepEqual(shardOf(first('src/B.sol:B', f1)[0]).tags, ['v1.1.0'])
  assert.deepEqual(shardOf(first('src/A.sol:A', c3)[0]).tags, ['v1.1.0'])

  // --- Run 2: nothing new. No diff; the mismatch alert stays open until allowlisted. ---
  const head = git(data, 'rev-parse', 'HEAD')
  const r2 = await run()
  assert.equal(r2.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head)
  assert.equal(git(data, 'status', '--porcelain'), '')
  assert.ok(r2.ok)
  assert.equal(open().length, 1)

  // --- Run 3: hotfix/y deleted; develop gets a broken commit then a fix; v9.9.9 allowlisted. ---
  git(srcDir, 'branch', '-D', 'hotfix/y')
  git(srcDir, 'checkout', '-q', 'develop')
  write('src/B.sol', 'this does not compile'); const c6 = commit('c6: broken')
  write('src/B.sol', B(4)); const c7 = commit('c7: B=4')
  const cfgFile = path.join(data, 'config/fake/sources.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); cfg.tagValidation.allowlist['v9.9.9'] = 'test'; fs.writeFileSync(cfgFile, stableJson(cfg))
  git(data, 'commit', '-qam', 'allowlist v9.9.9')
  const r3 = await run()
  assert.ok(!fs.existsSync(path.join(data, 'fake/branches/hotfix')), 'deleted branch file and its directory removed')
  assert.ok(fs.existsSync(path.join(data, 'fake/entries')) && first('src/A.sol:A', h1).length === 1, 'its entries stay')
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'fake/branches/develop.json'), 'utf8')).commit, c7)
  assert.equal(first('src/B.sol:B', c7).length, 1)
  assert.deepEqual(Object.keys(r3.failures), ['build-failure'])
  assert.equal(r3.failures['build-failure']![0].commit, c6)
  assert.deepEqual(open().map(a => a.title), ['[registry] fake: build failure (build-failure)'], 'mismatch alert closed by the allowlist')

  // --- Run 4: the develop head itself is broken: branch file stays, alert gains the head. ---
  write('src/B.sol', 'still broken'); const c8 = commit('c8: broken head')
  const r4 = await run()
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'fake/branches/develop.json'), 'utf8')).commit, c7)
  assert.deepEqual(r4.failures['build-failure']!.map(i => i.commit), [c8])
  assert.equal(open()[0].items.length, 2)
  assert.equal(r4.commit, null)

  // --- Run 5: a new entry masks different bytes from an existing one of its length: nothing is published. ---
  // A manual entry with B's code length that masks one more range. Its pairs with the existing
  // entries of that length (B's, and P's, which happens to share it) have been reviewed; its pair
  // with the new B@5 entry hasn't.
  const bs = entries().filter(e => e.contracts.includes('src/B.sol:B'))
  assert.equal(new Set(bs.map(e => e.codeLength)).size, 1, 'every B build has one length')
  const sameLength = entries().filter(e => e.codeLength === bs[0].codeLength)
  const manual: Entry = {
    schemaVersion: 1, fingerprint: `0x${'ab'.repeat(32)}`, repo: 'Example/fake', contracts: ['src/B.sol:B'], role: 'logic',
    codeLength: bs[0].codeLength, maskedRanges: [{ name: 'patched', type: 'uint256', offsets: [0], length: 32 }], cborMetadataLength: bs[0].cborMetadataLength,
    getters: [], selectors: [], compiler: null, firstCommit: null, firstBranch: null, label: 'B, patched one-off',
  }
  const sd = new SourceData(data, 'fake', 'Example/fake')
  sd.writeEntry(manual); sd.writeViews()
  cfg.reviewedRangePairs = sameLength.map(b => ({ fingerprints: [manual.fingerprint, b.fingerprint], note: 'test: reviewed' }))
  fs.writeFileSync(cfgFile, stableJson(cfg))
  git(data, 'add', '-A'); git(data, 'commit', '-qm', 'manual entry')
  write('src/B.sol', B(5)); const c9 = commit('c9: B=5')
  const head5 = git(data, 'rev-parse', 'HEAD')
  const r5 = await run()
  assert.equal(r5.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head5)
  assert.equal(git(data, 'status', '--porcelain'), '', "the run's entries and views are discarded")
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'fake/branches/develop.json'), 'utf8')).commit, c7)
  const err = r5.failures['publish-error']![0]
  assert.match(err.message, /^range invariant broken; nothing published\. fake: 1 pair\(s\) of entries with the same code length mask different bytes/)
  assert.ok(err.details!.includes(manual.fingerprint) && err.details!.includes('src/B.sol:B') && err.details!.includes('bytes 0-31 (patched)'), err.details)
  assert.ok(open().some(a => a.title.endsWith('(publish-error)')))

  // --- Run 6: the pair reviewed, by pasting the report's snippet into the config: B@5 is published. ---
  const snippet = JSON.parse(/once reviewed: (\{.*\})/.exec(err.details!)![1])
  cfg.reviewedRangePairs.push({ ...snippet, note: 'test: rebuilt both; they differ at a byte neither masks' })
  fs.writeFileSync(cfgFile, stableJson(cfg))
  git(data, 'commit', '-qam', 'review the pair')
  const r6 = await run()
  assert.ok(r6.commit)
  assert.equal(first('src/B.sol:B', c9).length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'fake/branches/develop.json'), 'utf8')).commit, c9)
  assert.ok(!r6.failures['publish-error'])
  assert.ok(!open().some(a => a.title.endsWith('(publish-error)')), 'publish-error alert closed')

  // Generated files still match their inputs, and CI's checks pass against the first data commit.
  execFileSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', data, '--base', git(data, 'rev-list', '--max-parents=0', 'HEAD')], { stdio: 'pipe' })
  fs.rmSync(tmp, { recursive: true, force: true })
})
