// Rebuilding published tags (rebuild.ts), on a tiny local source repo built with forge (network
// only if forge has to download solc 0.8.17): tags that publish wrote reproduce; a commit with two
// tags is built once; a changed fingerprint, an extra contract and a commit that won't build are
// reported per tag without hiding the others; the CLI prints one JSON report and exits 0, 1 or 2.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { publish } from '../src/lib/publish.ts'
import { LocalAlertSink } from '../src/lib/alerts.ts'
import { stableJson } from '../src/lib/json.ts'
import { rebuild, type RebuildReport } from '../src/lib/rebuild.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim()
const contract = (name: string, v: number) => `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.17;\ncontract ${name} {\n  function f() external pure returns (uint256) { return ${v}; }\n}\n`

test('rebuild reproduces published tags and reports each that does not', { timeout: 10 * 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-rebuild-'))
  // --- Source repo: v1.0.0, then v1.1.0-beta.0 and v1.1.0 on one commit ---
  const srcDir = path.join(tmp, 'src-repo')
  fs.mkdirSync(path.join(srcDir, 'src'), { recursive: true })
  const write = (f: string, s: string) => fs.writeFileSync(path.join(srcDir, f), s)
  write('foundry.toml', "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.17'\nbytecode_hash = 'none'\noptimizer = true\noptimizer_runs = 200\nevm_version = 'london'\n")
  const pkg = (v: string) => write('package.json', JSON.stringify({ name: 'x', version: v }) + '\n')
  const commit = (m: string) => { git(srcDir, 'add', '-A'); git(srcDir, 'commit', '-qm', m); return git(srcDir, 'rev-parse', 'HEAD') }
  git(tmp, 'init', '-q', srcDir)
  write('src/A.sol', contract('A', 1)); write('src/B.sol', contract('B', 1)); pkg('1.0.0')
  const c1 = commit('c1')
  git(srcDir, 'tag', 'v1.0.0')
  write('src/A.sol', contract('A', 2)); pkg('1.1.0')
  const c2 = commit('c2')
  git(srcDir, 'tag', 'v1.1.0-beta.0')
  git(srcDir, 'tag', 'v1.1.0')

  // --- Data repo, published once ---
  const data = path.join(tmp, 'data')
  const work = path.join(tmp, 'work')
  fs.mkdirSync(path.join(data, 'config/fake'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'schema'), path.join(data, 'schema'), { recursive: true })
  fs.writeFileSync(path.join(data, 'config/fake/sources.json'), stableJson({
    schemaVersion: 1, repo: 'Example/fake', url: 'https://github.com/Example/fake.git', directory: 'fake', npmPackages: ['x'],
    start: { tag: 'v1.0.0' }, publishedRefs: { tags: ['v*'], branches: ['release-*'] },
    tagValidation: { rule: 'tag-equals-v-package-version', allowlist: { 'v1.1.0-beta.0': 'shares its commit with v1.1.0' } },
    outOfScopeGetters: 'config/fake/out-of-scope-getters.json',
    contractRoles: {}, reviewedRangePairs: [], testChains: null, reconcileGraceMinutes: 0,
    builds: [{
      name: 'forge', when: {}, toolchain: {}, setup: [],
      outputs: [{ name: 'forge', commands: ['forge build --build-info --force'], buildInfo: 'out/build-info', layout: 'standard-json', deployed: true }],
      include: ['src/**'], exclude: [],
    }],
  }))
  fs.writeFileSync(path.join(data, 'config/fake/out-of-scope-getters.json'), stableJson({ schemaVersion: 1, repo: 'Example/fake', getters: {} }))
  git(tmp, 'init', '-q', data); git(data, 'add', '-A'); git(data, 'commit', '-qm', 'config')
  const published = await publish({ dataRepo: data, workDir: work, source: 'fake', alerts: new LocalAlertSink(path.join(tmp, 'alerts')), sourceUrl: srcDir, log: () => {} })
  assert.deepEqual(published.tagsAdded.sort(), ['v1.0.0', 'v1.1.0', 'v1.1.0-beta.0'])
  const tagPath = (t: string) => path.join(data, `registry/fake/tags/${t}.json`)

  // --- Every tag reproduces; the commit with two tags is built once ---
  const logs: string[] = []
  const all = await rebuild({ dataRepo: data, workDir: work, source: 'fake', sourceUrl: srcDir, log: s => logs.push(s) })
  assert.equal(all.reproduced, true)
  assert.deepEqual(all.tags.map(t => [t.tag, t.commit, t.profile, t.contracts, t.reproduced]), [
    ['v1.0.0', c1, 'forge', 2, true], ['v1.1.0-beta.0', c2, 'forge', 2, true], ['v1.1.0', c2, 'forge', 2, true],
  ])
  assert.deepEqual(logs.filter(l => l.startsWith('rebuilding ')), [`rebuilding v1.0.0 at ${c1.slice(0, 12)}`, `rebuilding v1.1.0-beta.0, v1.1.0 at ${c2.slice(0, 12)}`])
  assert.deepEqual(logs.filter(l => l.startsWith('build ')).length, 2, 'two builds for three tags')
  const one = await rebuild({ dataRepo: data, workDir: work, source: 'fake', tags: ['v1.1.0'], sync: false })
  assert.deepEqual(one.tags.map(t => t.tag), ['v1.1.0'])
  await assert.rejects(rebuild({ dataRepo: data, workDir: work, source: 'fake', tags: ['v9.0.0'], sync: false }), /fake has no tag file for v9\.0\.0/)
  await assert.rejects(rebuild({ dataRepo: data, workDir: work, source: 'nope', sync: false }), /no configured source nope \(configured: fake\)/)
  assert.equal(git(data, 'status', '--porcelain'), '', 'rebuild writes nothing to the data repo')

  // --- The CLI: one JSON report on stdout; exit 0, 1 or 2 ---
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/src/cli/rebuild.ts'), '--data-repo', data, '--work-dir', work, '--no-sync', ...args], { encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: () => JSON.parse(r.stdout) as RebuildReport }
  }
  const ok = cli('--source', 'fake', '--tag', 'v1.0.0')
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(ok.report().tags.map(t => [t.tag, t.reproduced]), [['v1.0.0', true]])
  for (const args of [['--source', 'fake'], ['--source', 'fake', '--all', '--tag', 'v1.0.0'], ['--all']]) {
    assert.equal(cli(...args).status, 2, `usage error: ${args.join(' ')}`)
  }
  const unknown = cli('--source', 'fake', '--tag', 'v9.0.0')
  assert.equal(unknown.status, 2)
  assert.equal(unknown.stdout, '')
  assert.match(unknown.stderr, /fake has no tag file for v9\.0\.0/)

  // --- What doesn't reproduce: a changed fingerprint, an extra contract, a commit that won't build ---
  const v100 = JSON.parse(fs.readFileSync(tagPath('v1.0.0'), 'utf8'))
  const realB = v100.contracts['src/B.sol:B']
  const fakeFp = `0x${'ab'.repeat(32)}`
  v100.contracts['src/B.sol:B'] = fakeFp
  v100.contracts['src/Z.sol:Z'] = fakeFp
  fs.writeFileSync(tagPath('v1.0.0'), stableJson(v100))
  const gone = '1'.repeat(40)
  fs.writeFileSync(tagPath('v2.0.0'), stableJson({ ...v100, tag: 'v2.0.0', commit: gone, packageVersion: '2.0.0', contracts: {} }))
  const bad = cli('--source', 'fake', '--all')
  assert.equal(bad.status, 1, bad.stderr)
  const r = bad.report()
  assert.equal(r.reproduced, false)
  assert.deepEqual(r.tags.map(t => [t.tag, t.reproduced]), [['v1.0.0', false], ['v1.1.0-beta.0', true], ['v1.1.0', true], ['v2.0.0', false]])
  assert.deepEqual(r.tags[0].differences, [
    { contract: 'src/B.sol:B', recorded: fakeFp, rebuilt: realB },
    { contract: 'src/Z.sol:Z', recorded: fakeFp, rebuilt: null },
  ])
  assert.equal(r.tags[0].failure, undefined)
  assert.equal(r.tags[3].commit, gone)
  assert.ok(r.tags[3].failure, 'a commit that is not in the source repo is a failure, not a crash')
  assert.deepEqual(r.tags[3].differences, [])
  fs.rmSync(tmp, { recursive: true, force: true })
})
