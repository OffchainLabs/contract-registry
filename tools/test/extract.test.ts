import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { extractContract, packageOf, type ArtifactRef, type BuildInfo } from '../src/lib/extract.ts'

// solc 0.8.17 with bytecode_hash = 'none' appends {"solc": 0x000811} plus its length.
const CBOR_NONE = 'a164736f6c6343000811000a'
// What every library without external functions compiles to: PUSH20 <self> ADDRESS EQ ... REVERT.
const LIBRARY_STUB = '73' + '00'.repeat(20) + '3014608060405260006000fdfe' + CBOR_NONE
// A library with one external function (the dispatcher is longer than the stub).
const LIBRARY_EXTERNAL = '73' + '00'.repeat(20) + '30146080604052600436106100355760003560e01c80635b34b96614603a575b600080fd5b' + CBOR_NONE

function artifact(source: string, name: string, contractKind: 'library' | 'contract', code: string, methods: Record<string, string>): ArtifactRef {
  const buildInfo: BuildInfo = {
    file: 'test.json',
    solcLongVersion: '0.8.17+commit.8df45f5f',
    input: { language: 'Solidity', settings: { optimizer: { enabled: true, runs: 2000 }, evmVersion: 'london', metadata: { bytecodeHash: 'none' } }, sources: {} },
    output: {
      contracts: { [source]: { [name]: { abi: Object.keys(methods).map(sig => ({ type: 'function', name: sig.split('(')[0], inputs: [], outputs: [], stateMutability: 'pure' })), evm: { deployedBytecode: { object: code, immutableReferences: {}, linkReferences: {} }, methodIdentifiers: methods } } } },
      sources: { [source]: { id: 0, ast: { nodeType: 'SourceUnit', id: 1, nodes: [{ nodeType: 'ContractDefinition', id: 2, name, contractKind }] } } },
    },
  }
  return { fqName: `${source}:${name}`, buildInfo, source, name }
}

test('libraries with no external functions are skipped; libraries with one are kept and masked', () => {
  assert.equal(extractContract(artifact('src/libraries/MerkleLib.sol', 'MerkleLib', 'library', LIBRARY_STUB, {})), null)
  const kept = extractContract(artifact('src/bridge/DelayBuffer.sol', 'DelayBuffer', 'library', LIBRARY_EXTERNAL, { 'BASIS()': '5b34b966' }))
  assert.ok(kept)
  assert.deepEqual(kept.selectors, ['0x5b34b966'])
  assert.deepEqual(kept.maskedRanges.map(r => [r.name, r.offsets]), [['<library address>', [1]]])
  // The same stub as a contract (not a library) is kept: only libraries are known never to be deployed.
  assert.ok(extractContract(artifact('src/X.sol', 'X', 'contract', LIBRARY_STUB, {})))
})

test('packageOf: Hardhat and Foundry package sources, scoped and not; repo files get null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pkg-'))
  const write = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s) }
  write('node_modules/@openzeppelin/contracts/package.json', JSON.stringify({ name: '@openzeppelin/contracts', version: '4.7.3' }))
  write('node_modules/@openzeppelin/contracts-upgradeable/package.json', JSON.stringify({ name: '@openzeppelin/contracts-upgradeable', version: '4.7.3' }))
  write('node_modules/solady/package.json', JSON.stringify({ name: 'solady', version: '0.0.182' }))
  write('node_modules/oz-v5/package.json', JSON.stringify({ name: '@openzeppelin/contracts', version: '5.0.2' })) // an npm alias
  write('node_modules/a/node_modules/@b/c/package.json', JSON.stringify({ name: '@b/c', version: '2.0.0' }))
  write('node_modules/noversion/package.json', JSON.stringify({ name: 'noversion' }))
  write('src/bridge/Bridge.sol', '')
  write('lib/forge-std/src/Test.sol', '')

  // Hardhat names package sources by import name, resolved from the project's node_modules.
  assert.equal(packageOf(dir, '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol'), '@openzeppelin/contracts@4.7.3')
  assert.equal(packageOf(dir, '@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol'), '@openzeppelin/contracts-upgradeable@4.7.3')
  assert.equal(packageOf(dir, 'solady/src/utils/MinHeapLib.sol'), 'solady@0.0.182')
  assert.equal(packageOf(dir, 'oz-v5/proxy/Proxy.sol'), '@openzeppelin/contracts@5.0.2', 'the package name, not the alias')
  // Foundry names them by path, possibly nested.
  assert.equal(packageOf(dir, 'node_modules/@openzeppelin/contracts/utils/Address.sol'), '@openzeppelin/contracts@4.7.3')
  assert.equal(packageOf(dir, 'node_modules/a/node_modules/@b/c/X.sol'), '@b/c@2.0.0')
  // The repo's own files, submodules included.
  assert.equal(packageOf(dir, 'src/bridge/Bridge.sol'), null)
  assert.equal(packageOf(dir, 'lib/forge-std/src/Test.sol'), null)
  // Neither: an error, not a guess.
  assert.throws(() => packageOf(dir, 'src/Missing.sol'), /no installed package at node_modules\/src/)
  assert.throws(() => packageOf(dir, '@missing/pkg/X.sol'), /no installed package at node_modules\/@missing\/pkg/)
  assert.throws(() => packageOf(dir, 'noversion/X.sol'), /has no version/)
  fs.rmSync(dir, { recursive: true })
})
