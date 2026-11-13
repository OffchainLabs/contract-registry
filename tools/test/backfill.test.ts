// Backfill: which tags are published (descendants of the start tag, plus releases at or above
// `start.releasesFrom`), build profiles chosen by semver tag range, and the test-chain check gated
// by `testChains.when`, with skipped commits reported. The last test runs the publish flow on a tiny
// local source repo built with forge (network only if forge has to download solc 0.8.17).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  describeSelector, loadSourceConfig, selectorMatches, selectProfile, tagInRange, tagInSemverRange, testChainsApply,
  type BuildProfile, type RefFacts, type SourceConfig,
} from '../src/lib/config.ts'
import { publish } from '../src/lib/publish.ts'
import { LocalAlertSink } from '../src/lib/alerts.ts'
import { stableJson } from '../src/lib/json.ts'
import type { TestChainDeployer } from '../src/lib/testcheck.ts'
import type { Entry } from '../src/lib/types.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const nitro = loadSourceConfig(ROOT, 'nitro-contracts')

/**
 * A stand-in for nitro-contracts' history: v3.0.0 (also tagged v3.0.0-beta.1) and v3.1.0 are
 * ancestors of v3.2.0; v3.1.1 and v3.1.0-qol are on a side branch; v3.3.0-rc.1 and the head of
 * release-3.3.0 descend from v3.2.0.
 */
const commits: Record<string, { tags: string[]; ancestors: string[] }> = {
  c300: { tags: ['v3.0.0', 'v3.0.0-beta.1'], ancestors: [] },
  c301b: { tags: ['v3.0.1-beta.1'], ancestors: ['c300'] },
  c310: { tags: ['v3.1.0'], ancestors: ['c300', 'c301b'] },
  cqol: { tags: ['v3.1.0-qol'], ancestors: ['c300', 'c301b', 'c310'] },
  c311: { tags: ['v3.1.1'], ancestors: ['c300', 'c301b', 'c310'] },
  c320b: { tags: ['v3.2.0-beta.0'], ancestors: ['c300', 'c301b', 'c310'] },
  c320: { tags: ['v3.2.0'], ancestors: ['c300', 'c301b', 'c310', 'c320b'] },
  c330rc: { tags: ['v3.3.0-rc.1'], ancestors: ['c300', 'c301b', 'c310', 'c320b', 'c320'] },
  head: { tags: [], ancestors: ['c300', 'c301b', 'c310', 'c320b', 'c320', 'c330rc'] },
  c213: { tags: ['v2.1.3'], ancestors: [] },
}
const tagCommit = (t: string) => Object.entries(commits).find(([, c]) => c.tags.includes(t))![0]
const facts: RefFacts = {
  contains: (ref, commit) => { const r = tagCommit(ref); return r === commit || commits[commit].ancestors.includes(r) },
  pointsAt: (ref, commit) => tagCommit(ref) === commit,
  tagsAt: commit => commits[commit].tags,
}

test('published tags: descendants of the start tag, plus releases at or above releasesFrom', () => {
  const inRange = (start: SourceConfig['start'], tag: string) => tagInRange(start, tag, () => facts.contains(start.tag, tagCommit(tag)))
  const start = { tag: 'v3.2.0', releasesFrom: 'v3.0.0' }
  const all = Object.values(commits).flatMap(c => c.tags)
  assert.deepEqual(all.filter(t => inRange(start, t)), ['v3.0.0', 'v3.1.0', 'v3.1.1', 'v3.2.0', 'v3.3.0-rc.1'],
    'releases from v3.0.0 wherever they are (v3.1.1 is on a side branch); prereleases only from v3.2.0 on')
  // The nitro-contracts config says exactly that.
  assert.deepEqual(nitro.start, start)
  // Without releasesFrom, only descendants of the start tag.
  assert.deepEqual(all.filter(t => inRange({ tag: 'v3.2.0' }, t)), ['v3.2.0', 'v3.3.0-rc.1'])
  // Going further back is one line: lower releasesFrom.
  assert.deepEqual(all.filter(t => inRange({ tag: 'v3.2.0', releasesFrom: 'v2.1.0' }, t)), ['v3.0.0', 'v3.1.0', 'v3.1.1', 'v3.2.0', 'v3.3.0-rc.1', 'v2.1.3'])
  // A release at or above releasesFrom needs no ancestry check; a tag that isn't semver does.
  let asked = 0
  assert.ok(tagInRange(start, 'v3.1.1', () => { asked++; return false }))
  assert.equal(asked, 0)
  assert.ok(!tagInRange(start, 'vnext', () => false))
  assert.ok(tagInRange(start, 'vnext', () => true))
})

test('semver tag ranges', () => {
  const r = { from: 'v3.0.0', before: 'v3.2.0' }
  assert.ok(tagInSemverRange('v3.0.0', r))
  assert.ok(tagInSemverRange('v3.1.1', r))
  assert.ok(tagInSemverRange('v3.2.0-beta.0', r), 'a prerelease of v3.2.0 is before it')
  assert.ok(!tagInSemverRange('v3.0.0-beta.1', r))
  assert.ok(!tagInSemverRange('v3.2.0', r))
  assert.ok(!tagInSemverRange('v2.1.3', r))
  assert.ok(!tagInSemverRange('vnext', {}), 'only semver tags')
  assert.ok(tagInSemverRange('v9.0.0', { from: 'v3.0.0' }))
  assert.ok(tagInSemverRange('v1.0.0', { before: 'v3.0.0' }))
})

test('build profiles are chosen by semver tag range', () => {
  const name = (c: string) => selectProfile(nitro.builds, facts, c).name
  for (const c of ['c320', 'c330rc', 'head']) assert.equal(name(c), 'hardhat-foundry-0.8.17', c)
  for (const c of ['c300', 'c310', 'c311']) assert.equal(name(c), 'hardhat-0.8.17-v3.0-v3.1', c)
  // A commit tagged both v3.0.0 and v3.0.0-beta.1 matches by its v3.0.0 tag.
  assert.ok(selectorMatches({ tags: { from: 'v3.0.0' } }, facts, 'c300'))
  // Nothing covers v2.1.3 yet: lowering releasesFrom alone fails loudly rather than building it
  // with settings meant for v3.0.
  assert.throws(() => name('c213'), /no build profile matches commit c213/)
  // A commit no published tag points at never matches a tag range.
  assert.ok(!selectorMatches({ tags: {} }, facts, 'head'))
  // The first matching profile wins.
  const p = (n: string, when: BuildProfile['when']): BuildProfile => ({ name: n, when, toolchain: {}, setup: [], outputs: [], include: [], exclude: [] })
  const builds = [p('a', { tags: { before: 'v3.1.0' } }), p('b', { tags: { from: 'v3.0.0' } }), p('c', {})]
  assert.deepEqual(['c300', 'c310', 'c213', 'head'].map(c => selectProfile(builds, facts, c).name), ['a', 'b', 'a', 'c'])
  // Every condition of a selector must hold.
  assert.ok(!selectorMatches({ tags: { from: 'v3.0.0' }, descendantOf: ['v3.2.0'] }, facts, 'c311'))
  assert.ok(selectorMatches({ tags: { from: 'v3.0.0' }, notDescendantOf: ['v3.2.0'] }, facts, 'c311'))
  assert.equal(describeSelector(nitro.builds[1].when), 'tagged >= v3.0.0 and < v3.2.0')
})

test('the test-chain check applies by testChains.when', () => {
  for (const c of ['c320', 'c330rc', 'head']) assert.ok(testChainsApply(nitro, facts, c), c)
  for (const c of ['c300', 'c310', 'c311']) assert.ok(!testChainsApply(nitro, facts, c), c)
  assert.equal(describeSelector(nitro.testChains!.when!), 'descendant of v3.2.0')
  assert.ok(testChainsApply({ testChains: { deployer: 'x' } }, facts, 'c300'), 'every commit without when')
  assert.ok(!testChainsApply({ testChains: null }, facts, 'c320'))
})

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim()
const contract = (v: number) => `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.17;\ncontract C {\n  function f() external pure returns (uint256) { return ${v}; }\n}\n`

test('publish backfills old releases with their own profile, and reports skipped test-chain checks', { timeout: 10 * 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-backfill-'))
  // --- Source repo: v0.8.0 and v0.9.0 come before the start tag v1.0.0; v0.9.1 and v0.9.2-beta.0 are on a side branch. ---
  const srcDir = path.join(tmp, 'src-repo')
  fs.mkdirSync(path.join(srcDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'foundry.toml'), "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.17'\nbytecode_hash = 'none'\noptimizer = true\noptimizer_runs = 200\nevm_version = 'london'\n")
  const release = (v: string, n: number) => {
    fs.writeFileSync(path.join(srcDir, 'src/C.sol'), contract(n))
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'x', version: v }) + '\n')
    git(srcDir, 'add', '-A'); git(srcDir, 'commit', '-qm', v); git(srcDir, 'tag', `v${v}`)
    return git(srcDir, 'rev-parse', 'HEAD')
  }
  git(tmp, 'init', '-q', srcDir)
  release('0.8.0', 80)
  const c090 = release('0.9.0', 90)
  git(srcDir, 'checkout', '-qb', 'release-0.9', c090)
  const c091 = release('0.9.1', 91)
  release('0.9.2-beta.0', 92)
  git(srcDir, 'checkout', '-q', 'main')
  const c100 = release('1.0.0', 100)

  // --- Data repo: releases from v0.9.0; old tags build with 7 optimizer runs; test chains from v1.0.0 on. ---
  const data = path.join(tmp, 'data')
  fs.mkdirSync(path.join(data, 'config/fake'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'schema'), path.join(data, 'schema'), { recursive: true })
  const forge = (name: string, when: BuildProfile['when'], flags: string): BuildProfile => ({
    name, when, toolchain: {}, setup: [],
    outputs: [{ name: 'forge', commands: [`forge build --build-info --force${flags}`], buildInfo: 'out/build-info', layout: 'standard-json', deployed: true }],
    include: ['src/**'], exclude: [],
  })
  fs.writeFileSync(path.join(data, 'config/fake/sources.json'), stableJson({
    schemaVersion: 1, repo: 'Example/fake', url: 'https://github.com/Example/fake.git', directory: 'fake',
    start: { tag: 'v1.0.0', releasesFrom: 'v0.9.0' }, publishedRefs: { tags: ['v*'], branches: ['hotfix*'] },
    tagValidation: { rule: 'tag-equals-v-package-version', allowlist: {} },
    outOfScopeGetters: 'config/fake/out-of-scope-getters.json', contractRoles: {}, reviewedRangePairs: [],
    testChains: { deployer: 'fake', when: { descendantOf: ['v1.0.0'] } }, reconcileGraceMinutes: 0,
    builds: [forge('current', { descendantOf: ['v1.0.0'] }, ''), forge('old', { tags: { from: 'v0.9.0', before: 'v1.0.0' } }, ' --optimizer-runs 7')],
  }))
  fs.writeFileSync(path.join(data, 'config/fake/out-of-scope-getters.json'), stableJson({ schemaVersion: 1, repo: 'Example/fake', getters: {} }))
  git(tmp, 'init', '-q', data); git(data, 'add', '-A'); git(data, 'commit', '-qm', 'config')

  const deployed: string[] = []
  const deployer: TestChainDeployer = {
    async deployTestChains({ checkoutDir }) {
      deployed.push(git(checkoutDir, 'rev-parse', 'HEAD'))
      return { rpcUrl: 'http://127.0.0.1:1', chains: [], stop: async () => {} }
    },
  }
  const logs: string[] = []
  const run = () => publish({ dataRepo: data, workDir: path.join(tmp, 'work'), source: 'fake', alerts: new LocalAlertSink(path.join(tmp, 'alerts')), sourceUrl: srcDir, deployer, log: s => logs.push(s) })
  const entries = (): Entry[] => fs.readdirSync(path.join(data, 'fake/entries')).map(f => JSON.parse(fs.readFileSync(path.join(data, 'fake/entries', f), 'utf8')))
  const tagFile = (t: string) => JSON.parse(fs.readFileSync(path.join(data, `fake/tags/${t}.json`), 'utf8'))

  const r1 = await run()
  assert.ok(r1.ok, JSON.stringify(r1.failures))
  assert.deepEqual(r1.tagsAdded, ['v0.9.0', 'v0.9.1', 'v1.0.0'], 'not v0.8.0 (below releasesFrom) or v0.9.2-beta.0 (a prerelease off the start tag)')
  // Each tag was built with its profile: the old releases with 7 optimizer runs.
  const runsOf = (t: string) => entries().find(e => e.fingerprint === tagFile(t).contracts['src/C.sol:C'])!.compiler!.optimizer.runs
  assert.deepEqual(['v0.9.0', 'v0.9.1', 'v1.0.0'].map(runsOf), [7, 7, 200])
  // The check ran for v1.0.0 only; the old releases are reported as skipped, in the outcome, the log and the commit.
  assert.deepEqual(deployed, [c100])
  assert.deepEqual(r1.checks.map(c => [c.commit, c.ok]), [[c100, true]])
  const reason = 'outside testChains.when (descendant of v1.0.0); built and published without a test-chain check'
  assert.deepEqual(r1.checksSkipped, [{ commit: c090, refs: ['v0.9.0'], reason }, { commit: c091, refs: ['v0.9.1'], reason }])
  assert.ok(logs.includes(`test-chain check skipped for v0.9.0 (${c090.slice(0, 12)}): ${reason}`), logs.join('\n'))
  assert.match(git(data, 'log', '-1', '--format=%s'), /test-chain check skipped \(outside testChains\.when\) for v0\.9\.0, v0\.9\.1$/)

  // A rerun has nothing new: no diff and nothing skipped.
  const head = git(data, 'rev-parse', 'HEAD')
  const r2 = await run()
  assert.ok(r2.ok, JSON.stringify(r2.failures))
  assert.equal(r2.commit, null)
  assert.equal(git(data, 'rev-parse', 'HEAD'), head)
  assert.deepEqual(r2.checksSkipped, [])
  assert.deepEqual(deployed, [c100], 'the check result is cached')
  execFileSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', data, '--base', git(data, 'rev-list', '--max-parents=0', 'HEAD')], { stdio: 'pipe' })
  fs.rmSync(tmp, { recursive: true, force: true })
})
