// Recognising another source's code in a build (`foreignOrigin`): by its installed package, by a
// path that names another source's package, and by a git submodule of another source's repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { packageRootOf } from '../src/lib/extract.ts'
import { foreignCode, foreignCodeRefusal, foreignOrigin, githubRepoOf, submodulesOf, unlistedOwnPackage, type SourceIdentity } from '../src/lib/foreign.ts'

const OTHERS: SourceIdentity[] = [
  { id: 'nitro-contracts', repo: 'OffchainLabs/nitro-contracts', npmPackages: ['@arbitrum/nitro-contracts'] },
  { id: 'upgrade-executor', repo: 'OffchainLabs/upgrade-executor', npmPackages: ['@offchainlabs/upgrade-executor'] },
  { id: 'plain', repo: 'Example/plain', npmPackages: ['plain-pkg'] },
]
const NC_SUB = { path: 'lib/nitro-contracts', repo: 'OffchainLabs/nitro-contracts' }

test('packageRootOf: the package directory of a Foundry path, a nested install and a Hardhat import name', () => {
  assert.equal(packageRootOf('node_modules/@scope/pkg/src/X.sol'), 'node_modules/@scope/pkg')
  assert.equal(packageRootOf('node_modules/a/node_modules/@b/c/X.sol'), 'node_modules/a/node_modules/@b/c')
  assert.equal(packageRootOf('@scope/pkg/src/X.sol'), '@scope/pkg')
  assert.equal(packageRootOf('pkg/X.sol'), 'pkg')
})

test("foreignOrigin: another source's package, installed or named by the path, and its exclude", () => {
  const of = (contract: string, pkg: string | null = null, subs = [NC_SUB]) => foreignOrigin(contract, pkg, subs, OTHERS)
  // Hardhat import name, and the same file as Foundry names it.
  assert.deepEqual(of('@offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor', '@offchainlabs/upgrade-executor@1.1.0'), {
    contract: '@offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor', owner: 'upgrade-executor',
    via: 'package @offchainlabs/upgrade-executor@1.1.0', exclude: '@offchainlabs/upgrade-executor/**',
  })
  assert.equal(of('node_modules/@offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor', '@offchainlabs/upgrade-executor@1.1.0')!.exclude, '@offchainlabs/upgrade-executor/**')
  // An npm alias: the directory is another name, the installed package.json says whose it is.
  assert.deepEqual(of('node_modules/nc/src/bridge/Bridge.sol:Bridge', '@arbitrum/nitro-contracts@3.1.0'), {
    contract: 'node_modules/nc/src/bridge/Bridge.sol:Bridge', owner: 'nitro-contracts', via: 'package @arbitrum/nitro-contracts@3.1.0', exclude: 'nc/**',
  })
  // A copy at the top of the repo, which packageOf takes for the repo's own file.
  assert.deepEqual(of('@arbitrum/nitro-contracts/src/bridge/Bridge.sol:Bridge'), {
    contract: '@arbitrum/nitro-contracts/src/bridge/Bridge.sol:Bridge', owner: 'nitro-contracts', via: 'package @arbitrum/nitro-contracts', exclude: '@arbitrum/nitro-contracts/**',
  })
  // Inside another package's install: the outermost source package gives the exclude.
  const nested = of('node_modules/@arbitrum/nitro-contracts/node_modules/@offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor', '@offchainlabs/upgrade-executor@1.0.0')!
  assert.deepEqual([nested.owner, nested.exclude], ['nitro-contracts', '@arbitrum/nitro-contracts/**'])
  // An unscoped package, and a nested install of one under an ordinary package.
  assert.equal(of('node_modules/x/node_modules/plain-pkg/P.sol:P', 'plain-pkg@1.0.0')!.exclude, 'x/node_modules/plain-pkg/**')
  // Not another source's: OpenZeppelin, this source's own files, a file named like a package but not in one.
  assert.equal(of('@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy', '@openzeppelin/contracts@4.8.3'), null)
  assert.equal(of('contracts/tokenbridge/ethereum/L1ArbitrumMessenger.sol:L1ArbitrumMessenger'), null)
  assert.equal(of('src/plain-pkg/P.sol:P'), null)
  assert.equal(of('plain-pkg:P'), null, 'a package is a directory')
})

test("foreignOrigin: a git submodule of another source's repo, nested ones included", () => {
  const ue = { path: 'lib/nitro-contracts/lib/upgrade-executor', repo: 'offchainlabs/UPGRADE-EXECUTOR' }
  const other = { path: 'lib/vendor', repo: 'Example/vendor' }
  const deep = { path: 'lib/vendor/lib/nc', repo: 'OffchainLabs/nitro-contracts' }
  const subs = [NC_SUB, ue, other, deep, { path: 'lib/gitlab', repo: null }]
  assert.deepEqual(foreignOrigin('lib/nitro-contracts/src/bridge/Inbox.sol:Inbox', null, subs, OTHERS), {
    contract: 'lib/nitro-contracts/src/bridge/Inbox.sol:Inbox', owner: 'nitro-contracts',
    via: 'git submodule lib/nitro-contracts (OffchainLabs/nitro-contracts)', exclude: 'lib/nitro-contracts/**',
  })
  // Inside nitro-contracts' submodule: the outermost, nitro-contracts', and its exclude.
  assert.equal(foreignOrigin('lib/nitro-contracts/lib/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor', null, subs, OTHERS)!.exclude, 'lib/nitro-contracts/**')
  assert.equal(foreignOrigin('lib/nitro-contracts/lib/forge-std/src/Test.sol:Test', null, subs, OTHERS)!.owner, 'nitro-contracts')
  // Only the repo the submodule clones counts (case-insensitively, as GitHub does), at any depth.
  assert.equal(foreignOrigin('lib/vendor/src/V.sol:V', null, subs, OTHERS), null)
  assert.deepEqual(foreignOrigin('lib/vendor/lib/nc/src/X.sol:X', null, subs, OTHERS)!.exclude, 'lib/vendor/lib/nc/**')
  assert.equal(foreignOrigin('lib/gitlab/X.sol:X', null, subs, OTHERS), null)
  assert.equal(foreignOrigin('lib/nitro-contractsX/X.sol:X', null, subs, OTHERS), null, 'a path prefix, not a string prefix')
  // A source's own repo as a submodule of itself isn't another source's.
  assert.equal(foreignOrigin('lib/nitro-contracts/src/X.sol:X', null, [NC_SUB], OTHERS.filter(o => o.id !== 'nitro-contracts')), null)
})

test('githubRepoOf: the URL forms .gitmodules uses', () => {
  for (const url of [
    'https://github.com/OffchainLabs/nitro-contracts.git', 'https://github.com/OffchainLabs/nitro-contracts', 'https://github.com/OffchainLabs/nitro-contracts/',
    'git@github.com:OffchainLabs/nitro-contracts.git', 'ssh://git@github.com/OffchainLabs/nitro-contracts.git', 'git://github.com/OffchainLabs/nitro-contracts.git',
    ' http://github.com/OffchainLabs/nitro-contracts.git ',
  ]) assert.equal(githubRepoOf(url, null), 'OffchainLabs/nitro-contracts', url)
  assert.equal(githubRepoOf('../nitro-contracts.git', 'OffchainLabs/token-bridge-contracts'), 'OffchainLabs/nitro-contracts')
  assert.equal(githubRepoOf('../nitro-contracts.git', null), null)
  assert.equal(githubRepoOf('https://gitlab.com/OffchainLabs/nitro-contracts.git', null), null)
  assert.equal(githubRepoOf('https://github.com/OffchainLabs/nitro-contracts/tree/main', null), null)
})

test('submodulesOf: every .gitmodules, nested ones included, with relative URLs resolved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-submodules-'))
  try {
    const write = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s) }
    write('.gitmodules', [
      '[submodule "lib/forge-std"]', '\tpath = lib/forge-std', '\turl = https://github.com/foundry-rs/forge-std',
      '# a comment', '[submodule "nitro"]', '\tpath = lib/nitro-contracts', '\turl = git@github.com:OffchainLabs/nitro-contracts.git',
      '[submodule "sibling"]', '\tpath = lib/sibling/', '\turl = ../sibling.git',
      '[submodule "with space"]', '\tpath = "lib/with space"', '\turl = https://github.com/Example/spaced.git',
      '[submodule "pathless"]', '\turl = https://github.com/Example/pathless.git', '',
    ].join('\n'))
    write('lib/nitro-contracts/.gitmodules', '[submodule "precompiles"]\n\tpath = src/precompiles\n\turl = ../nitro-precompile-interfaces.git\n')
    assert.deepEqual(submodulesOf(dir, 'OffchainLabs/token-bridge-contracts'), [
      { path: 'lib/forge-std', repo: 'foundry-rs/forge-std' },
      { path: 'lib/nitro-contracts', repo: 'OffchainLabs/nitro-contracts' },
      { path: 'lib/nitro-contracts/src/precompiles', repo: 'OffchainLabs/nitro-precompile-interfaces' },
      { path: 'lib/sibling', repo: 'OffchainLabs/sibling' },
      { path: 'lib/with space', repo: 'Example/spaced' },
    ])
    fs.rmSync(path.join(dir, '.gitmodules'))
    assert.deepEqual(submodulesOf(dir, 'OffchainLabs/token-bridge-contracts'), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('foreignCodeRefusal names each contract, whose code it is, and the excludes to add; unlistedOwnPackage', () => {
  const found = foreignCode([
    { fqName: 'lib/nitro-contracts/src/bridge/Inbox.sol:Inbox', package: null },
    { fqName: 'contracts/tokenbridge/ethereum/gateway/L1GatewayRouter.sol:L1GatewayRouter', package: null },
    { fqName: '@offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor', package: '@offchainlabs/upgrade-executor@1.1.0-beta.0' },
  ], [NC_SUB], OTHERS)
  assert.deepEqual(found.map(f => f.owner), ['nitro-contracts', 'upgrade-executor'])
  assert.equal(foreignCodeRefusal('token-bridge-contracts', 'tag v1.2.0 (0123456789ab)', 'hardhat-0.8.16-oz4', found), [
    "tag v1.2.0 (0123456789ab): lib/nitro-contracts/src/bridge/Inbox.sol:Inbox is code from nitro-contracts (git submodule lib/nitro-contracts (OffchainLabs/nitro-contracts); " +
      "see config/nitro-contracts/sources.json), and a source never publishes another source's code; nothing published. " +
      'Add "lib/nitro-contracts/**", "@offchainlabs/upgrade-executor/**" to the exclude list of build profile hardhat-0.8.16-oz4 in config/token-bridge-contracts/sources.json (2 contracts, listed below).',
    "  lib/nitro-contracts/src/bridge/Inbox.sol:Inbox: code from nitro-contracts (git submodule lib/nitro-contracts (OffchainLabs/nitro-contracts); see config/nitro-contracts/sources.json); exclude \"lib/nitro-contracts/**\"",
    "  @offchainlabs/upgrade-executor/src/UpgradeExecutor.sol:UpgradeExecutor: code from upgrade-executor (package @offchainlabs/upgrade-executor@1.1.0-beta.0; see config/upgrade-executor/sources.json); exclude \"@offchainlabs/upgrade-executor/**\"",
  ].join('\n'))

  const tb = { directory: 'token-bridge-contracts', npmPackages: ['@arbitrum/token-bridge-contracts'] }
  assert.equal(unlistedOwnPackage(tb, 'tag v1.2.0 (0123456789ab)', JSON.stringify({ name: '@arbitrum/token-bridge-contracts', version: '1.2.0' })), null)
  assert.equal(unlistedOwnPackage(tb, 'x', null), null, 'no package.json')
  assert.equal(unlistedOwnPackage(tb, 'x', '{"version": "1.0.0"}'), null, 'no name')
  assert.equal(unlistedOwnPackage(tb, 'tag v2.0.0 (0123456789ab)', '{"name": "@offchainlabs/token-bridge-contracts"}'),
    'tag v2.0.0 (0123456789ab): package.json names the package @offchainlabs/token-bridge-contracts, which npmPackages in config/token-bridge-contracts/sources.json ' +
    "doesn't list; nothing published. List it there: another source's build that installs it is then refused instead of publishing its code.")
})
