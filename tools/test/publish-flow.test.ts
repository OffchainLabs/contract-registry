// The publish run's bookkeeping, end to end, on a tiny local source repo built with forge (no
// test chains; network only if forge has to download solc 0.8.17): only tags and release/hotfix
// branch heads are built (never main, develop or a branch's earlier commits); a tag after its
// release branch merges reuses its entries; deleted branches; the tag check against a branch
// head build of the same commit; tag/version mismatch; build failures; reruns with no diff;
// package provenance, roles from the config, libraries that are never deployed, and the range
// invariant (a new entry that masks different bytes from one of its length publishes nothing
// until reviewed).
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
import type { ByLengthEntry, Entry } from '../src/lib/types.ts'
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/walker/walk.ts'
import { versionOf } from '../src/walker/registry.ts'

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
  write('src/B.sol', B(6)); const m1 = commit('m1: B=6 on main, which is not published')
  git(srcDir, 'checkout', '-qb', 'develop', c1)
  write('src/B.sol', B(2)); const c2 = commit('c2: B=2 on develop, which is not published')
  write('src/A.sol', A(2)); const c3 = commit('c3: A=2 on develop')
  git(srcDir, 'checkout', '-qb', 'release-1.1.0')
  write('src/B.sol', B(3)); const rel1 = commit('rel1: B=3, not the release head')
  write('src/B.sol', B(4)); pkg('1.1.0'); const rel2 = commit('rel2: B=4, version 1.1.0 (the release head)')
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
    start: { tag: 'v1.0.0' }, publishedRefs: { tags: ['v*'], branches: ['release-*', 'hotfix*'] },
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
  /** The entries of one contract first built from `ref`. */
  const builtFrom = (name: string, ref: string) => entries().filter(e => e.contracts.includes(name) && e.ref === ref)
  const only = (es: Entry[], what: string) => { assert.equal(es.length, 1, what); return es[0] }
  const tagFile = (t: string) => JSON.parse(fs.readFileSync(path.join(data, `fake/tags/${t}.json`), 'utf8'))
  const branchFile = (b: string) => { const f = path.join(data, `fake/branches/${b}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }
  const shardOf = (e: Entry): ByLengthEntry => JSON.parse(fs.readFileSync(path.join(data, `fake/by-length/${e.codeLength}.json`), 'utf8')).entries.find((x: Entry) => x.fingerprint === e.fingerprint)

  // --- Run 1: tags v1.0.0 and v9.9.9, and the heads of release-1.1.0 and hotfix/y ---
  const r1 = await run()
  assert.ok(r1.commit, 'committed')
  assert.equal(git(data, 'log', '-1', '--format=%H'), r1.commit, 'one commit for the whole update')
  assert.equal(git(data, 'rev-list', '--count', 'HEAD'), '2')
  // A@1, B@1, P, LE, U from v1.0.0; A@2, B@4 from the release head; B@9 only via its tag; A@7 from hotfix/y.
  assert.equal(only(builtFrom('src/A.sol:A', 'v1.0.0'), 'A@1').commit, c1)
  assert.equal(only(builtFrom('src/B.sol:B', 'v1.0.0'), 'B@1').commit, c1)
  assert.equal(only(builtFrom('src/A.sol:A', 'release-1.1.0'), 'A@2, first built at the release head').commit, rel2)
  assert.equal(only(builtFrom('src/B.sol:B', 'release-1.1.0'), 'B@4').commit, rel2)
  assert.equal(only(builtFrom('src/B.sol:B', 'v9.9.9'), 'B@9, from a tag on no published branch').commit, u1)
  assert.equal(only(builtFrom('src/A.sol:A', 'hotfix/y'), 'A@7').commit, h1)
  assert.equal(entries().length, 9, 'mocks excluded; P, LE and U once')
  // Nothing from main, develop, or the release branch's earlier commits.
  assert.deepEqual(new Set(entries().map(e => e.commit)), new Set([c1, rel2, u1, h1]))
  assert.ok(![m1, c2, c3, rel1].some(c => entries().some(e => e.commit === c)))
  assert.equal(entries().filter(e => e.contracts.includes('src/B.sol:B')).length, 3, 'B@1, B@4, B@9: never B@6 (main), B@2 (develop) or B@3 (not the release head)')
  assert.deepEqual(r1.branchesUpdated, ['release-1.1.0', 'hotfix/y'])
  assert.equal(branchFile('release-1.1.0').commit, rel2)
  assert.equal(branchFile('hotfix/y').commit, h1)
  assert.equal(branchFile('main'), null)
  assert.equal(branchFile('develop'), null)
  assert.ok(!entries().some(e => e.contracts.some(c => c.includes('mocks'))))
  // Package provenance, roles from contractRoles, and no entry for the internal-only library.
  const one = (name: string) => only(entries().filter(e => e.contracts.includes(name)), name)
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
  const a1 = builtFrom('src/A.sol:A', 'v1.0.0')[0]
  assert.deepEqual(a1.maskedRanges.map(r => r.name), ['x'])
  assert.deepEqual(a1.getters.map(g => [g.signature, g.kind]), [['bridge()', 'single'], ['list(uint256)', 'list']])
  assert.equal(tagFile('v9.9.9').packageVersion, '1.0.0')
  // The tags had no branch head build to compare with: no reproduction failure, though their
  // fingerprints had no entry.
  assert.deepEqual(Object.keys(r1.failures), ['tag-version-mismatch'])
  assert.equal(open().length, 1)
  // Derived tags and versions: code in no tag gives <ref>@<commit>.
  assert.deepEqual(shardOf(builtFrom('src/B.sol:B', 'v1.0.0')[0]).tags, ['v1.0.0'])
  const a2 = builtFrom('src/A.sol:A', 'release-1.1.0')[0]
  assert.deepEqual(shardOf(a2).tags, [])
  assert.equal(versionOf(shardOf(a2)), `release-1.1.0@${rel2.slice(0, 12)}`)
  const releaseBuild = branchFile('release-1.1.0')

  // --- Run 2: nothing new. No diff; the mismatch alert stays open until allowlisted. ---
  const head = git(data, 'rev-parse', 'HEAD')
  const r2 = await run()
  assert.equal(r2.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head)
  assert.equal(git(data, 'status', '--porcelain'), '')
  assert.ok(r2.ok)
  assert.equal(open().length, 1)

  // --- Run 3: release-1.1.0 merged into main and tagged there, then deleted; hotfix/y deleted; v9.9.9 allowlisted. ---
  git(srcDir, 'merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge release-1.1.0', 'release-1.1.0')
  const merge = git(srcDir, 'rev-parse', 'HEAD')
  git(srcDir, 'tag', 'v1.1.0')
  git(srcDir, 'branch', '-D', 'release-1.1.0', 'hotfix/y')
  const cfgFile = path.join(data, 'config/fake/sources.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); cfg.tagValidation.allowlist['v9.9.9'] = 'test'; fs.writeFileSync(cfgFile, stableJson(cfg))
  git(data, 'commit', '-qam', 'allowlist v9.9.9')
  const r3 = await run()
  assert.ok(r3.ok, JSON.stringify(r3.failures))
  assert.deepEqual(r3.tagsAdded, ['v1.1.0'])
  assert.equal(tagFile('v1.1.0').commit, merge)
  assert.equal(r3.newEntries, 0, "the tag reuses the release head's entries")
  assert.deepEqual(tagFile('v1.1.0').contracts, releaseBuild.contracts)
  assert.deepEqual(r3.branchesDeleted, ['hotfix/y', 'release-1.1.0'])
  assert.equal(branchFile('release-1.1.0'), null, 'deleted branch file removed')
  assert.ok(!fs.existsSync(path.join(data, 'fake/branches/hotfix')), 'and its directory')
  assert.equal(only(builtFrom('src/A.sol:A', 'release-1.1.0'), 'its entries stay').commit, rel2)
  assert.equal(builtFrom('src/A.sol:A', 'hotfix/y').length, 1)
  assert.deepEqual(shardOf(a2).tags, ['v1.1.0'])
  assert.equal(versionOf(shardOf(a2)), 'v1.1.0')
  assert.deepEqual(open(), [], 'mismatch alert closed by the allowlist')

  // --- Run 4: a release branch head and a tag on it, new in one run: the entry names the tag. ---
  git(srcDir, 'checkout', '-qb', 'release-1.2.0')
  write('src/B.sol', B(5)); pkg('1.2.0-rc.1'); const rc = commit('rc: B=5, 1.2.0-rc.1')
  git(srcDir, 'tag', 'v1.2.0-rc.1')
  const r4 = await run()
  assert.ok(r4.ok, JSON.stringify(r4.failures))
  assert.equal(r4.newEntries, 1)
  const b5 = only(entries().filter(e => e.contracts.includes('src/B.sol:B') && e.commit === rc), 'B@5')
  assert.equal(b5.ref, 'v1.2.0-rc.1')
  assert.equal(branchFile('release-1.2.0').commit, rc)
  assert.equal(tagFile('v1.2.0-rc.1').commit, rc)

  // --- Run 5: two broken commits; only the head is built, and its branch file stays. ---
  write('src/B.sol', 'this does not compile'); const bad1 = commit('bad1: broken, not the head')
  write('src/B.sol', 'still broken'); const bad2 = commit('bad2: broken head')
  const r5 = await run()
  assert.deepEqual(Object.keys(r5.failures), ['build-failure'])
  assert.deepEqual(r5.failures['build-failure']!.map(i => [i.commit, i.refs]), [[bad2, ['release-1.2.0']]], `only the head is built, not ${bad1.slice(0, 12)}`)
  assert.equal(branchFile('release-1.2.0').commit, rc)
  assert.deepEqual(open().map(a => a.title), ['[registry] fake: build failure (build-failure)'])
  assert.equal(r5.commit, null)

  // --- Run 6: fixed at a new head; the failed head is superseded, so the alert closes. ---
  write('src/B.sol', B(5)); pkg('1.2.0'); const fixed = commit('fixed: B=5, 1.2.0')
  const r6 = await run()
  assert.ok(r6.ok, JSON.stringify(r6.failures))
  assert.equal(r6.newEntries, 0)
  assert.equal(branchFile('release-1.2.0').commit, fixed)
  assert.deepEqual(open(), [], 'build-failure alert closed')

  // --- Run 7: a tag on a commit built as a release head must reproduce that build. ---
  // Stand in for a nondeterministic build by altering the recorded head build.
  const relFile = path.join(data, 'fake/branches/release-1.2.0.json')
  const altered = JSON.parse(fs.readFileSync(relFile, 'utf8')); altered.contracts['src/B.sol:B'] = `0x${'cd'.repeat(32)}`
  fs.writeFileSync(relFile, stableJson(altered))
  git(data, 'commit', '-qam', 'test: a head build the tag build does not reproduce')
  git(srcDir, 'tag', 'v1.2.0')
  const r7 = await run()
  assert.deepEqual(Object.keys(r7.failures), ['tag-nondeterministic'])
  const nd = r7.failures['tag-nondeterministic']![0]
  assert.equal(nd.message, `tag v1.2.0 build doesn't reproduce the fingerprints of ${fixed.slice(0, 12)} built as the head of release-1.2.0; tag file not written`)
  assert.equal(nd.details, `release-1.2.0: src/B.sol:B: branch head build 0x${'cd'.repeat(32)} vs tag build ${b5.fingerprint}`)
  assert.ok(!fs.existsSync(path.join(data, 'fake/tags/v1.2.0.json')))
  assert.equal(r7.commit, null)

  // --- Run 8: the head build restored: the tag reproduces it and is published. ---
  git(data, 'revert', '--no-edit', 'HEAD')
  const r8 = await run()
  assert.ok(r8.ok, JSON.stringify(r8.failures))
  assert.deepEqual(r8.tagsAdded, ['v1.2.0'])
  assert.equal(r8.newEntries, 0)
  assert.deepEqual(open(), [], 'tag-nondeterministic alert closed')

  // --- Run 9: a new entry masks different bytes from an existing one of its length: nothing is published. ---
  // A manual entry with B's code length that masks one more range. Its pairs with the existing
  // entries of that length (B's, and P's, which happens to share it) have been reviewed; its pair
  // with the new B@8 entry hasn't.
  const bs = entries().filter(e => e.contracts.includes('src/B.sol:B'))
  assert.equal(new Set(bs.map(e => e.codeLength)).size, 1, 'every B build has one length')
  const sameLength = entries().filter(e => e.codeLength === bs[0].codeLength)
  const manual: Entry = {
    schemaVersion: 1, fingerprint: `0x${'ab'.repeat(32)}`, repo: 'Example/fake', contracts: ['src/B.sol:B'], role: 'logic',
    codeLength: bs[0].codeLength, maskedRanges: [{ name: 'patched', type: 'uint256', offsets: [0], length: 32 }], cborMetadataLength: bs[0].cborMetadataLength,
    getters: [], selectors: [], compiler: null, ref: null, commit: null, label: 'B, patched one-off',
  }
  const sd = new SourceData(data, 'fake', 'Example/fake')
  sd.writeEntry(manual); sd.writeViews()
  cfg.reviewedRangePairs = sameLength.map(b => ({ fingerprints: [manual.fingerprint, b.fingerprint], note: 'test: reviewed' }))
  fs.writeFileSync(cfgFile, stableJson(cfg))
  git(data, 'add', '-A'); git(data, 'commit', '-qm', 'manual entry')
  write('src/B.sol', B(8)); const b8 = commit('b8: B=8')
  const head9 = git(data, 'rev-parse', 'HEAD')
  const r9 = await run()
  assert.equal(r9.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head9)
  assert.equal(git(data, 'status', '--porcelain'), '', "the run's entries and views are discarded")
  assert.equal(branchFile('release-1.2.0').commit, fixed)
  const err = r9.failures['publish-error']![0]
  assert.match(err.message, /^range invariant broken; nothing published\. fake: 1 pair\(s\) of entries with the same code length mask different bytes/)
  assert.ok(err.details!.includes(manual.fingerprint) && err.details!.includes('src/B.sol:B') && err.details!.includes('bytes 0-31 (patched)'), err.details)
  assert.ok(open().some(a => a.title.endsWith('(publish-error)')))

  // --- Run 10: the pair reviewed, by pasting the report's snippet into the config: B@8 is published. ---
  const snippet = JSON.parse(/once reviewed: (\{.*\})/.exec(err.details!)![1])
  cfg.reviewedRangePairs.push({ ...snippet, note: 'test: rebuilt both; they differ at a byte neither masks' })
  fs.writeFileSync(cfgFile, stableJson(cfg))
  git(data, 'commit', '-qam', 'review the pair')
  const r10 = await run()
  assert.ok(r10.commit)
  assert.equal(only(builtFrom('src/B.sol:B', 'release-1.2.0'), 'B@8').commit, b8)
  assert.equal(versionOf(shardOf(builtFrom('src/B.sol:B', 'release-1.2.0')[0])), `release-1.2.0@${b8.slice(0, 12)}`)
  assert.equal(branchFile('release-1.2.0').commit, b8)
  assert.ok(!r10.failures['publish-error'])
  assert.ok(!open().some(a => a.title.endsWith('(publish-error)')), 'publish-error alert closed')

  // main and develop were never built.
  assert.ok(!entries().some(e => e.ref === 'main' || e.ref === 'develop'))
  assert.equal(branchFile('main'), null)
  assert.equal(branchFile('develop'), null)
  // Generated files still match their inputs, and CI's checks pass against the first data commit.
  execFileSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', data, '--base', git(data, 'rev-list', '--max-parents=0', 'HEAD')], { stdio: 'pipe' })
  fs.rmSync(tmp, { recursive: true, force: true })
})
