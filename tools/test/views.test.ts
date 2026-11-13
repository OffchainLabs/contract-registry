import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { entryFromBuild, generateViews, roleOf, SourceData } from '../src/lib/datarepo.ts'
import { loadSourceConfig } from '../src/lib/config.ts'
import { SchemaValidator, validateDataRepo } from '../src/lib/schema.ts'
import { EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT } from '../src/walker/walk.ts'
import type { BuiltContract, Entry, RoleConfig, TagFile } from '../src/lib/types.ts'
import { keccak256, toHex } from 'viem'

const ROOT = path.resolve(import.meta.dirname, '../..')
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const commit = (n: number) => n.toString(16).padStart(40, '0')

function entry(n: number, len: number, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: fp(n), repo: 'OffchainLabs/nitro-contracts', contracts: [`src/X${n}.sol:X${n}`], role: 'logic', codeLength: len,
    maskedRanges: [], cborMetadataLength: 12,
    getters: [{ signature: 'bridge()', selector: '0xe78cea92', kind: 'single' }], selectors: ['0xe78cea92'],
    compiler: { language: 'Solidity', version: '0.8.17+commit.8df45f5f', evmVersion: 'london', optimizer: { enabled: true, runs: 2000 }, viaIR: false, metadata: { bytecodeHash: 'none', appendCBOR: true } },
    ref: 'release-1.0.0', commit: commit(n), ...extra,
  }
}
function tag(name: string, contracts: Record<string, `0x${string}`>): TagFile {
  return { schemaVersion: 1, repo: 'OffchainLabs/nitro-contracts', tag: name, commit: commit(99), prerelease: name.includes('-'), packageVersion: name.slice(1), contracts }
}

test('a fingerprint produced by several tags lists all of them, in release order', () => {
  const views = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts',
    [entry(1, 100), entry(2, 100), entry(3, 200)],
    [tag('v3.10.0', { 'src/X1.sol:X1': fp(1) }), tag('v3.2.0', { 'src/X1.sol:X1': fp(1), 'src/X3.sol:X3': fp(3) }), tag('v3.2.0-beta.0', { 'src/X1.sol:X1': fp(1) })])
  const shard = JSON.parse(views.get('nitro-contracts/by-length/100.json')!)
  assert.deepEqual(shard.entries.map((e: any) => [e.fingerprint, e.tags]), [[fp(1), ['v3.2.0-beta.0', 'v3.2.0', 'v3.10.0']], [fp(2), []]])
  assert.deepEqual(JSON.parse(views.get('nitro-contracts/index.json')!).codeLengths, [100, 200])
})

test('generation is deterministic regardless of input order', () => {
  const es = [entry(1, 100), entry(2, 100), entry(3, 200)]
  const ts = [tag('v1.0.0', { 'src/X1.sol:X1': fp(1) }), tag('v1.1.0', { 'src/X2.sol:X2': fp(2) })]
  const a = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', es, ts)
  const b = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', [...es].reverse(), [...ts].reverse())
  assert.deepEqual([...a], [...b])
})

test('schemas accept generated files and manual entries, and reject a manual entry without a label', () => {
  const v = new SchemaValidator(ROOT)
  assert.deepEqual(v.validate('entry', entry(1, 100)), [])
  const manual = entry(5, 100, { ref: null, commit: null, compiler: null, label: 'Arbitrum One Bridge (patched v3.0.0)', notes: 'one-off build' })
  assert.deepEqual(v.validate('entry', manual), [])
  const { label, ...unlabelled } = manual
  assert.notDeepEqual(v.validate('entry', unlabelled), [])
  // Only a manual entry (one with a label) may lack a ref or a commit, and it may have either.
  assert.deepEqual(v.validate('entry', { ...manual, commit: commit(5) }), [], 'a one-off built from a known commit')
  assert.notDeepEqual(v.validate('entry', { ...entry(1, 100), ref: null }), [])
  assert.notDeepEqual(v.validate('entry', { ...entry(1, 100), commit: null }), [])
  const { ref, ...noRef } = entry(1, 100)
  assert.notDeepEqual(v.validate('entry', noRef), [], 'ref is required, even if null')
  assert.notDeepEqual(v.validate('entry', { ...entry(1, 100), firstCommit: commit(1) }), [], 'the old field is rejected')
  assert.notDeepEqual(v.validate('entry', { ...entry(1, 100), surprise: 1 }), [], 'unknown fields are rejected')
  const views = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', [entry(1, 100), manual], [tag('v1.0.0', { 'src/X1.sol:X1': fp(1) })])
  assert.deepEqual(v.validate('by-length', JSON.parse(views.get('nitro-contracts/by-length/100.json')!)), [])
  assert.deepEqual(v.validate('index', JSON.parse(views.get('nitro-contracts/index.json')!)), [])
})

test('entries and tag files are write-once; nested branch paths are cleaned up on delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'))
  const d = new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts')
  d.writeEntry(entry(1, 100))
  assert.throws(() => d.writeEntry(entry(1, 100)), /write-once/)
  d.writeTag(tag('v1.0.0', {}))
  assert.throws(() => d.writeTag(tag('v1.0.0', {})), /write-once/)
  d.writeBranch({ schemaVersion: 1, repo: 'OffchainLabs/nitro-contracts', branch: 'hotfix/x', commit: commit(1), contracts: {} })
  assert.ok(fs.existsSync(path.join(dir, 'nitro-contracts/branches/hotfix/x.json')))
  d.deleteBranch('hotfix/x')
  assert.ok(!fs.existsSync(path.join(dir, 'nitro-contracts/branches/hotfix')))
  fs.rmSync(dir, { recursive: true })
})

const TUP = '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy'
const ADMIN = '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin'
const OZ = '@openzeppelin/contracts@4.7.3'

test('schemas: a proxy entry needs its slots, other roles have none; packages name package contracts', () => {
  const v = new SchemaValidator(ROOT)
  const proxy = entry(1, 100, { contracts: [TUP], packages: { [TUP]: OZ }, role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] })
  assert.deepEqual(v.validate('entry', proxy), [])
  assert.deepEqual(v.validate('entry', entry(2, 100, { contracts: [ADMIN], packages: { [ADMIN]: OZ }, role: 'proxy-admin' })), [])
  const { implementationSlots, ...noSlots } = proxy
  assert.notDeepEqual(v.validate('entry', noSlots), [], 'a proxy without slots')
  assert.notDeepEqual(v.validate('entry', { ...proxy, implementationSlots: [] }), [], 'an empty slot list')
  assert.notDeepEqual(v.validate('entry', { ...proxy, role: 'logic' }), [], 'slots on logic')
  assert.notDeepEqual(v.validate('entry', { ...proxy, role: 'proxy-admin' }), [], 'slots on a proxy admin')
  assert.notDeepEqual(v.validate('entry', { ...proxy, implementationSlots: [EIP1967_IMPLEMENTATION_SLOT.toUpperCase().replace('0X', '0x')] }), [], 'slots are lowercase hex')
  const { role, ...noRole } = entry(3, 100)
  assert.notDeepEqual(v.validate('entry', noRole), [], 'role is required')
  assert.notDeepEqual(v.validate('entry', { ...proxy, packages: {} }), [], 'packages is absent, not empty, when there are none')
  assert.notDeepEqual(v.validate('entry', { ...proxy, packages: { [TUP]: '4.7.3' } }), [], 'a package value names the package')
  // by-length shards carry the new fields through.
  const views = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', [proxy], [tag('v1.0.0', { [TUP]: fp(1) })])
  const shard = JSON.parse(views.get('nitro-contracts/by-length/100.json')!)
  assert.deepEqual(v.validate('by-length', shard), [])
  assert.deepEqual([shard.entries[0].role, shard.entries[0].implementationSlots, shard.entries[0].packages], ['proxy', [EIP1967_IMPLEMENTATION_SLOT], { [TUP]: OZ }])
  // packages can only name the entry's own contracts (checked outside the schema).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'))
  for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
  new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts').writeEntry({ ...proxy, packages: { [ADMIN]: OZ } })
  assert.deepEqual(validateDataRepo(dir, [{ directory: 'nitro-contracts', repo: 'OffchainLabs/nitro-contracts' }]), [`nitro-contracts/entries/${fp(1)}.json: packages names ${ADMIN}, which isn't in contracts`])
  fs.rmSync(dir, { recursive: true })
})

test('entryFromBuild: packages per contract, role from contractRoles', () => {
  const built = (fqName: string, pkg: string | null): BuiltContract => ({
    fqName, package: pkg, fingerprint: fp(7), codeLength: 100, maskedRanges: [], cborMetadataLength: 12, getters: [], selectors: [], compiler: entry(7, 100).compiler!,
  })
  const roles: Record<string, RoleConfig> = {
    [TUP]: { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] },
    'src/MyProxy.sol:MyProxy': { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] },
    [ADMIN]: { role: 'proxy-admin' },
  }
  // One fingerprint from a package and from the repo's own code: only the package one is listed.
  const mixed = entryFromBuild('OffchainLabs/nitro-contracts', [built(TUP, OZ), built('src/MyProxy.sol:MyProxy', null)], { ref: 'v1.0.0', commit: commit(1) }, roles)
  assert.deepEqual(mixed.packages, { [TUP]: OZ })
  assert.deepEqual([mixed.role, mixed.implementationSlots], ['proxy', [EIP1967_IMPLEMENTATION_SLOT]])
  assert.deepEqual(Object.keys(mixed).slice(0, 7), ['schemaVersion', 'fingerprint', 'repo', 'contracts', 'packages', 'role', 'implementationSlots'])
  // From two packages.
  const two = entryFromBuild('OffchainLabs/nitro-contracts', [built('@a/x/X.sol:X', '@a/x@1.0.0'), built('b/Y.sol:Y', 'b@2.0.0')], { ref: 'v1.0.0', commit: commit(1) }, roles)
  assert.deepEqual(two.packages, { '@a/x/X.sol:X': '@a/x@1.0.0', 'b/Y.sol:Y': 'b@2.0.0' })
  // Repo code only: no packages field; unlisted contracts are logic.
  const own = entryFromBuild('OffchainLabs/nitro-contracts', [built('src/A.sol:A', null)], { ref: 'v1.0.0', commit: commit(1) }, roles)
  assert.ok(!('packages' in own) && !('implementationSlots' in own))
  assert.equal(own.role, 'logic')
  assert.deepEqual(roleOf(roles, [ADMIN]), { role: 'proxy-admin' })
  assert.deepEqual(roleOf({ [TUP]: { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT.toUpperCase().replace('0X', '0x') as `0x${string}`] } }, [TUP]).implementationSlots, [EIP1967_IMPLEMENTATION_SLOT])
  // Same code, different configured roles: a config error, not a guess.
  assert.throws(() => roleOf(roles, [TUP, 'src/A.sol:A']), /different roles in contractRoles/)
  assert.throws(() => roleOf({ ...roles, 'src/P2.sol:P2': { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT] } }, [TUP, 'src/P2.sol:P2']), /different roles/)
})

test('nitro-contracts config: proxies use the walker\'s slots, ProxyAdmin is an admin, and the file is valid', () => {
  const cfg = loadSourceConfig(ROOT, 'nitro-contracts')
  assert.deepEqual(new SchemaValidator(ROOT).validate('sources', cfg), [])
  const slots = (name: string) => { const r = cfg.contractRoles[name]; return r.role === 'proxy' ? r.implementationSlots : r.role }
  assert.deepEqual(slots(TUP), [EIP1967_IMPLEMENTATION_SLOT])
  assert.deepEqual(slots('@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy'), [EIP1967_IMPLEMENTATION_SLOT])
  assert.deepEqual(slots('src/rollup/RollupProxy.sol:RollupProxy'), [EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT])
  assert.deepEqual(slots('src/libraries/AdminFallbackProxy.sol:AdminFallbackProxy'), [EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT])
  assert.equal(slots(ADMIN), 'proxy-admin')
  assert.equal(Object.keys(cfg.contractRoles).length, 5)
  // The slots are what EIP-1967 and AdminFallbackProxy define.
  assert.equal(EIP1967_IMPLEMENTATION_SLOT, slotOf('eip1967.proxy.implementation'))
  assert.equal(SECONDARY_IMPLEMENTATION_SLOT, slotOf('eip1967.proxy.implementation.secondary'))
})

function slotOf(label: string): string {
  return '0x' + (BigInt(keccak256(toHex(label))) - 1n).toString(16).padStart(64, '0')
}
