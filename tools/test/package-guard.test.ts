// A source never publishes another source's code. End to end on two tiny local source repos built
// with forge (no test chains; network only if forge has to download solc 0.8.17): beta compiles
// alpha's code twice, from alpha's npm package installed in node_modules/ and from a git submodule
// of alpha's repo. Publishing beta fails, naming each contract and the exclude to add, until its
// build profile excludes both; and it fails while beta's own package isn't in its npmPackages.
// Then ci-check over data that has another source's package code (no compiler).
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
import type { Entry } from '../src/lib/types.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim()
const contract = (name: string, body: string, imports = '') => `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.17;\n${imports}contract ${name} {\n${body}\n}\n`
const A = contract('A', '  function a() external pure returns (uint256) { return 1; }')
const FOUNDRY = "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.17'\nbytecode_hash = 'none'\noptimizer = true\noptimizer_runs = 200\nevm_version = 'london'\n"

test("publish refuses another source's code, from its package or a submodule of its repo, until the profile excludes it", { timeout: 10 * 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-guard-'))
  try {
    // --- Source repos, at the paths their https://github.com/Example/<id>.git URLs are redirected to ---
    const hosted = path.join(tmp, 'github')
    const redirect = ['-c', `url.${hosted}/.insteadOf=https://github.com/Example/`, '-c', 'protocol.file.allow=always']
    const repoDir = (id: string) => path.join(hosted, `${id}.git`)
    const write = (id: string, f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repoDir(id), f)), { recursive: true }); fs.writeFileSync(path.join(repoDir(id), f), s) }
    const release = (id: string, version: string) => {
      write(id, 'package.json', JSON.stringify({ name: `@example/${id}`, version }) + '\n')
      git(repoDir(id), 'add', '-A'); git(repoDir(id), 'add', '-f', '.'); git(repoDir(id), 'commit', '-qm', version); git(repoDir(id), 'tag', `v${version}`)
      return git(repoDir(id), 'rev-parse', 'HEAD')
    }
    for (const id of ['alpha', 'beta']) {
      fs.mkdirSync(repoDir(id), { recursive: true })
      git(hosted, 'init', '-q', repoDir(id))
      write(id, 'foundry.toml', FOUNDRY)
    }
    write('alpha', 'src/A.sol', A)
    release('alpha', '1.0.0')
    // beta: alpha's package installed (committed, so the build needs no install), and alpha's repo as a submodule.
    write('beta', 'node_modules/@example/alpha/package.json', JSON.stringify({ name: '@example/alpha', version: '1.0.0' }))
    write('beta', 'node_modules/@example/alpha/src/A.sol', A)
    git(repoDir('beta'), ...redirect, 'submodule', 'add', '-q', 'https://github.com/Example/alpha.git', 'lib/alpha')
    write('beta', 'src/B.sol', contract('B', '  function b() external pure returns (uint256) { return 2; }', 'import "../node_modules/@example/alpha/src/A.sol";\n'))
    write('beta', 'src/C.sol', contract('C', '  function c() external pure returns (uint256) { return 3; }', 'import "../lib/alpha/src/A.sol";\n'))
    const v2 = release('beta', '2.0.0').slice(0, 12)

    // --- Data repo: beta's profile includes everything and excludes nothing ---
    const data = path.join(tmp, 'data')
    fs.cpSync(path.join(ROOT, 'schema'), path.join(data, 'schema'), { recursive: true })
    for (const id of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(data, 'config', id), { recursive: true })
      fs.writeFileSync(path.join(data, `config/${id}/sources.json`), stableJson({
        schemaVersion: 1, repo: `Example/${id}`, url: `https://github.com/Example/${id}.git`, directory: id, npmPackages: [`@example/${id}`],
        start: { tag: id === 'alpha' ? 'v1.0.0' : 'v2.0.0' }, publishedRefs: { tags: ['v*'], branches: ['release-*'] },
        tagValidation: { rule: 'tag-equals-v-package-version', allowlist: {} },
        outOfScopeGetters: `config/${id}/out-of-scope-getters.json`,
        contractRoles: {}, reviewedRangePairs: [], testChains: null, reconcileGraceMinutes: 0,
        builds: [{
          name: 'forge', when: {}, toolchain: {}, setup: [`git ${redirect.join(' ')} submodule update --init --recursive`],
          outputs: [{ name: 'forge', commands: ['forge build --build-info --force'], buildInfo: 'out/build-info', layout: 'standard-json', deployed: true }],
          include: id === 'alpha' ? ['src/**'] : ['**'], exclude: [],
        }],
      }))
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
    const run = (source: string) => publish({ dataRepo: data, workDir, source, alerts: new LocalAlertSink(path.join(tmp, 'alerts')), sourceUrl: repoDir(source), log: () => {} })
    const beta = new SourceData(data, 'beta', 'Example/beta')
    /** Runs beta, which must fail with a publish error and leave the data repo as it was. */
    const refused = async () => {
      const head = git(data, 'rev-parse', 'HEAD')
      const r = await run('beta')
      assert.deepEqual(Object.keys(r.failures), ['publish-error'], JSON.stringify(r.failures))
      assert.equal(r.commit, null)
      assert.equal(git(data, 'rev-parse', 'HEAD'), head)
      assert.equal(git(data, 'status', '--porcelain'), '', "the run's files are discarded")
      assert.ok(!beta.hasTag('v2.0.0'))
      return r.failures['publish-error']![0]
    }

    const alpha = await run('alpha')
    assert.ok(alpha.ok, JSON.stringify(alpha.failures))

    // --- beta compiles alpha's code from both places: refused, naming both and both excludes ---
    const both = await refused()
    assert.equal(both.message,
      `tag v2.0.0 (${v2}): lib/alpha/src/A.sol:A is code from alpha (git submodule lib/alpha (Example/alpha); see config/alpha/sources.json), ` +
      "and a source never publishes another source's code; nothing published. " +
      'Add "lib/alpha/**", "@example/alpha/**" to the exclude list of build profile forge in config/beta/sources.json (2 contracts, listed below).')
    for (const line of [
      '\n  lib/alpha/src/A.sol:A: code from alpha (git submodule lib/alpha (Example/alpha); see config/alpha/sources.json); exclude "lib/alpha/**"\n',
      '\n  node_modules/@example/alpha/src/A.sol:A: code from alpha (package @example/alpha@1.0.0; see config/alpha/sources.json); exclude "@example/alpha/**"\n',
    ]) assert.ok(both.details!.includes(line), `${line}\n---\n${both.details}`)

    // --- Excluding the submodules (lib/**, as the token bridge does) leaves the package: still refused ---
    setConfig('beta', c => { c.builds[0].exclude = ['lib/**'] })
    const pkg = await refused()
    assert.equal(pkg.message,
      `tag v2.0.0 (${v2}): node_modules/@example/alpha/src/A.sol:A is code from alpha (package @example/alpha@1.0.0; see config/alpha/sources.json), ` +
      "and a source never publishes another source's code; nothing published. " +
      'Add "@example/alpha/**" to the exclude list of build profile forge in config/beta/sources.json.')

    // --- Both excluded, but beta's own package isn't in its npmPackages: refused ---
    setConfig('beta', c => { c.builds[0].exclude = ['lib/**', '@example/alpha/**']; c.npmPackages = [] })
    const own = await refused()
    assert.equal(own.message, `tag v2.0.0 (${v2}): package.json names the package @example/beta, which npmPackages in config/beta/sources.json doesn't list; nothing published. ` +
      "List it there: another source's build that installs it is then refused instead of publishing its code.")

    // --- Listed: published, with beta's own contracts only ---
    setConfig('beta', c => { c.npmPackages = ['@example/beta'] })
    const ok = await run('beta')
    assert.ok(ok.ok, JSON.stringify(ok.failures))
    assert.deepEqual(ok.tagsAdded, ['v2.0.0'])
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(beta.tagPath('v2.0.0'), 'utf8')).contracts), ['src/B.sol:B', 'src/C.sol:C'])
    const ci = spawnSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', data, '--base', first], { encoding: 'utf8' })
    assert.equal(ci.status, 0, ci.stderr)
    assert.match(ci.stderr, /packages: ok/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("ci-check: no source's entries, tags or branches have another source's package code", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-guard-ci-'))
  try {
    for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
    git(dir, 'init', '-q')
    const check = () => spawnSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', dir], { encoding: 'utf8' })
    const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
    const entry = (n: number, repo: string, contracts: string[], packages?: Record<string, string>): Entry => ({
      schemaVersion: 1, fingerprint: fp(n), repo, contracts, ...(packages ? { packages } : {}), role: 'logic', codeLength: 100 + n,
      maskedRanges: [], cborMetadataLength: 0, getters: [], selectors: [], compiler: null, ref: 'v1.0.0', commit: '1'.repeat(40),
    })
    const nc = new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts')
    const tb = new SourceData(dir, 'token-bridge-contracts', 'OffchainLabs/token-bridge-contracts')
    const UE = '@offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor'
    const INBOX = '@arbitrum/nitro-contracts/src/bridge/Inbox.sol:Inbox'
    // The token bridge's own code and OpenZeppelin's are fine.
    const OZ = '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin'
    tb.writeEntry(entry(1, tb.repo, ['contracts/tokenbridge/libraries/Whitelist.sol:Whitelist']))
    tb.writeEntry(entry(2, tb.repo, [OZ], { [OZ]: '@openzeppelin/contracts@4.8.3' }))
    tb.writeTag({ schemaVersion: 1, repo: tb.repo, tag: 'v1.0.0', commit: '1'.repeat(40), prerelease: false, packageVersion: '1.0.0', contracts: { 'contracts/tokenbridge/libraries/Whitelist.sol:Whitelist': fp(1), [OZ]: fp(2) } })
    DataRepo.open(dir).writeViews()
    const ok = check()
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stderr, /packages: ok \(no source's entries, tags or branches have another source's package code\)/)

    // An entry compiled from upgrade-executor's package (by its packages field), and a tag that lists
    // nitro-contracts' code from its package, under nitro-contracts' own entry.
    tb.writeEntry(entry(3, tb.repo, [UE], { [UE]: '@offchainlabs/upgrade-executor@1.1.0-beta.0' }))
    nc.writeEntry(entry(4, nc.repo, ['src/bridge/Inbox.sol:Inbox']))
    for (const t of ['v1.1.0', 'v1.2.0']) {
      tb.writeTag({ schemaVersion: 1, repo: tb.repo, tag: t, commit: '2'.repeat(40), prerelease: false, packageVersion: t.slice(1), contracts: { [UE]: fp(3), [INBOX]: fp(4) } })
    }
    DataRepo.open(dir).writeViews()
    const bad = check()
    assert.notEqual(bad.status, 0)
    for (const line of [
      `packages: registry/token-bridge-contracts/entries/${fp(3)}.json and 2 other file(s): ${UE} is code from upgrade-executor (package @offchainlabs/upgrade-executor@1.1.0-beta.0; ` +
        "see config/upgrade-executor/sources.json), and a source never publishes another source's code. " +
        'Builds of token-bridge-contracts must exclude "@offchainlabs/upgrade-executor/**" (config/token-bridge-contracts/sources.json)\n',
      `packages: registry/token-bridge-contracts/tags/v1.1.0.json and 1 other file(s): ${INBOX} is code from nitro-contracts (package @arbitrum/nitro-contracts; ` +
        "see config/nitro-contracts/sources.json), and a source never publishes another source's code. " +
        'Builds of token-bridge-contracts must exclude "@arbitrum/nitro-contracts/**" (config/token-bridge-contracts/sources.json)\n',
      'packages: 2 problem(s)',
    ]) assert.ok(bad.stderr.includes(line), `${line}\n---\n${bad.stderr}`)
    assert.match(bad.stderr, /entries: ok/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
