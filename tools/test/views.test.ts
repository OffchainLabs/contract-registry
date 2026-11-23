import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describeRole, entryFromBuild, generateViews, proxySlotProblem, roleOf, SourceData, type SourceInputs } from '../src/lib/datarepo.ts'
import { loadSourceConfig } from '../src/lib/config.ts'
import { kindOf, SchemaValidator, validateDataRepo } from '../src/lib/schema.ts'
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT } from '../src/walker/get-version.ts'
import type { BuiltContract, ByLengthEntry, Entry, RoleConfig, TagFile } from '../src/lib/types.ts'
import { keccak256, toFunctionSelector, toHex } from 'viem'

const ROOT = path.resolve(import.meta.dirname, '../..')
const NITRO = 'OffchainLabs/nitro-contracts'
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const commit = (n: number) => n.toString(16).padStart(40, '0')
const getter = (signature: string) => ({ signature, selector: toFunctionSelector(signature), kind: 'single' as const })

function entry(n: number, len: number, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: fp(n), repo: NITRO, contracts: [`src/X${n}.sol:X${n}`], role: 'logic', codeLength: len,
    maskedRanges: [], cborMetadataLength: 12,
    getters: [{ signature: 'bridge()', selector: '0xe78cea92', kind: 'single' }], selectors: ['0xe78cea92'],
    compiler: { language: 'Solidity', version: '0.8.17+commit.8df45f5f', evmVersion: 'london', optimizer: { enabled: true, runs: 2000 }, viaIR: false, metadata: { bytecodeHash: 'none', appendCBOR: true } },
    ref: 'release-1.0.0', commit: commit(n), ...extra,
  }
}
function tag(name: string, contracts: Record<string, `0x${string}`>, repo = NITRO): TagFile {
  return { schemaVersion: 1, repo, tag: name, commit: commit(99), prerelease: name.includes('-'), packageVersion: name.slice(1), contracts }
}
const nitro = (entries: Entry[], tags: TagFile[]): SourceInputs[] => [{ id: 'nitro-contracts', repo: NITRO, entries, tags }]

test('a fingerprint produced by several tags lists all of them, in release order', () => {
  const views = generateViews(nitro(
    [entry(1, 100), entry(2, 100), entry(3, 200)],
    [tag('v3.10.0', { 'src/X1.sol:X1': fp(1) }), tag('v3.2.0', { 'src/X1.sol:X1': fp(1), 'src/X3.sol:X3': fp(3) }), tag('v3.2.0-beta.0', { 'src/X1.sol:X1': fp(1) })]))
  assert.deepEqual([...views.keys()], ['registry/by-length/100.json', 'registry/by-length/200.json', 'registry/index.json'])
  const shard = JSON.parse(views.get('registry/by-length/100.json')!)
  assert.deepEqual(shard.entries.map((e: any) => [e.fingerprint, e.tags]), [[fp(1), ['v3.2.0-beta.0', 'v3.2.0', 'v3.10.0']], [fp(2), []]])
  assert.deepEqual(Object.keys(shard), ['schemaVersion', 'codeLength', 'entries'], 'no top-level repo: each entry has its own')
  assert.equal(shard.schemaVersion, 1)
  assert.deepEqual(JSON.parse(views.get('registry/index.json')!), {
    schemaVersion: 1, codeLengths: [100, 200], sources: { 'nitro-contracts': { repo: NITRO, getters: [getter('bridge()')] } },
  })
})

test('combined views: one shard per length across sources, tags from the entry\'s own source, getters per source', () => {
  const TB = 'OffchainLabs/token-bridge-contracts'
  const tb: SourceInputs = {
    id: 'token-bridge-contracts', repo: TB,
    entries: [entry(3, 100, { repo: TB, getters: [getter('router()')] })],
    // A tag named like one of nitro-contracts', and a build that reproduces nitro-contracts' code (fp 1).
    tags: [tag('v1.0.0', { 'contracts/R.sol:R': fp(3), '@x/X1.sol:X1': fp(1) }, TB)],
    branches: [{ schemaVersion: 1, repo: TB, branch: 'release-x', commit: commit(7), contracts: { 'lib/X4.sol:X4': fp(4) } }],
  }
  const nc: SourceInputs = {
    id: 'nitro-contracts', repo: NITRO,
    entries: [entry(1, 100), entry(2, 100, { getters: [getter('rollup()')] }), entry(4, 300, { getters: [getter('inbox()')] })],
    tags: [tag('v3.2.0', { 'src/X1.sol:X1': fp(1), 'src/X2.sol:X2': fp(2) })],
  }
  const views = generateViews([tb, nc])
  assert.deepEqual([...views], [...generateViews([nc, tb])], 'source order does not matter')
  const shard = JSON.parse(views.get('registry/by-length/100.json')!)
  assert.deepEqual(shard.entries.map((e: any) => [e.fingerprint, e.repo, e.tags]), [
    [fp(1), NITRO, ['v3.2.0']], // not the token bridge's v1.0.0, though its build produced the code
    [fp(2), NITRO, ['v3.2.0']],
    [fp(3), TB, ['v1.0.0']],
  ])
  const index = JSON.parse(views.get('registry/index.json')!)
  assert.deepEqual(index.codeLengths, [100, 300])
  assert.deepEqual(Object.keys(index.sources), ['nitro-contracts', 'token-bridge-contracts'])
  assert.deepEqual(index.sources['nitro-contracts'].getters.map((g: any) => g.signature), ['bridge()', 'inbox()', 'rollup()'])
  // Its own entries' getters, and those of the entries its tag (fp 1) and branch (fp 4) files reference.
  assert.deepEqual(index.sources['token-bridge-contracts'], { repo: TB, getters: [getter('bridge()'), getter('inbox()'), getter('router()')] })
  const v = new SchemaValidator(ROOT)
  assert.deepEqual(v.validate('by-length', shard), [])
  assert.deepEqual(v.validate('index', index), [])
})

test('by-length entries get version, isSingleImplementationProxy and fingerprintMask from their files', () => {
  const BRANCH_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
  const manual = { ref: null, commit: null, label: 'Arbitrum One Bridge (patched v3.0.0)' }
  const lib = { name: '<library address>', type: 'address', offsets: [1], length: 20 }
  const imm = { name: 'maxDataSize', type: 'uint256', offsets: [72, 40], length: 32 }
  const es = [
    entry(1, 100), // a release after a prerelease: the release
    entry(2, 100), // prereleases only: the first
    entry(3, 100, { ref: 'release-3.5.0', commit: BRANCH_COMMIT }), // built only as a branch head
    entry(4, 100, manual), // a manual entry: its label
    entry(5, 100, { ...manual, ref: 'hotfix-3.0.1', commit: BRANCH_COMMIT }), // a manual entry with a ref: still its label
    entry(6, 100, manual), // a manual entry a tag contains: the tag
    entry(7, 100, { contracts: [TUP], role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] }),
    entry(8, 100, { contracts: [BEACON_PROXY], role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT }),
    entry(9, 100, { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT] }), // RollupProxy
    entry(10, 100, { contracts: [ADMIN], role: 'proxy-admin' }),
    // Masks: a library's own address and an immutable at two offsets, out of order, with and without CBOR metadata.
    entry(11, 200, { maskedRanges: [imm, lib], cborMetadataLength: 12 }),
    entry(12, 200, { maskedRanges: [imm, lib], cborMetadataLength: 0 }),
    entry(13, 300, { cborMetadataLength: 0 }),
  ]
  const views = generateViews(nitro(es, [
    tag('v3.2.0-beta.0', { 'src/X1.sol:X1': fp(1) }), tag('v3.2.0', { 'src/X1.sol:X1': fp(1) }), tag('v3.10.0', { 'src/X1.sol:X1': fp(1) }),
    tag('v3.4.0-rc.1', { 'src/X2.sol:X2': fp(2) }), tag('v3.4.0-beta.0', { 'src/X2.sol:X2': fp(2) }),
    tag('v3.0.0', { 'src/X6.sol:X6': fp(6) }),
    tag('v1.0.0', { [TUP]: fp(7), [BEACON_PROXY]: fp(8), 'src/X9.sol:X9': fp(9), [ADMIN]: fp(10) }),
  ]))
  const rows = [100, 200, 300].flatMap(len => JSON.parse(views.get(`registry/by-length/${len}.json`)!).entries as ByLengthEntry[])
  const of = (n: number) => rows.find(e => e.fingerprint === fp(n))!
  assert.deepEqual(es.map((_, i) => of(i + 1).version), [
    'v3.2.0', 'v3.4.0-beta.0', 'release-3.5.0@abcdef012345', 'Arbitrum One Bridge (patched v3.0.0)', 'Arbitrum One Bridge (patched v3.0.0)', 'v3.0.0',
    'v1.0.0', 'v1.0.0', 'v1.0.0', 'v1.0.0', `release-1.0.0@${commit(11).slice(0, 12)}`, `release-1.0.0@${commit(12).slice(0, 12)}`, `release-1.0.0@${commit(13).slice(0, 12)}`,
  ])
  assert.deepEqual(es.map((_, i) => of(i + 1).isSingleImplementationProxy), [false, false, false, false, false, false, true, true, false, false, false, false, false])
  assert.deepEqual(of(1).fingerprintMask, [[88, 12]], 'the CBOR metadata: the last cborMetadataLength bytes')
  assert.deepEqual(of(11).fingerprintMask, [[1, 20], [40, 32], [72, 32], [188, 12]], 'every offset of every range, sorted by offset, then the CBOR metadata')
  assert.deepEqual(of(12).fingerprintMask, [[1, 20], [40, 32], [72, 32]], 'cborMetadataLength 0: no CBOR range')
  assert.deepEqual(of(13).fingerprintMask, [], 'nothing masked')
  // The derived fields follow the entry's own fields; maskedRanges and cborMetadataLength stay.
  const keys = Object.keys(of(11))
  assert.deepEqual(keys.slice(keys.indexOf('commit') + 1), ['tags', 'version', 'isSingleImplementationProxy', 'fingerprintMask'])
  assert.deepEqual([of(11).maskedRanges, of(11).cborMetadataLength], [[imm, lib], 12])
  const v = new SchemaValidator(ROOT)
  for (const len of [100, 200, 300]) assert.deepEqual(v.validate('by-length', JSON.parse(views.get(`registry/by-length/${len}.json`)!)), [])
  // The schema requires them, and a mask item is an [offset, length] pair.
  const shard = JSON.parse(views.get('registry/by-length/200.json')!)
  for (const field of ['version', 'isSingleImplementationProxy', 'fingerprintMask']) {
    const { [field]: _, ...without } = shard.entries[0]
    assert.notDeepEqual(v.validate('by-length', { ...shard, entries: [without] }), [], `without ${field}`)
  }
  assert.notDeepEqual(v.validate('by-length', { ...shard, entries: [{ ...shard.entries[0], fingerprintMask: [[1, 20, 3]] }] }), [], 'a triple')
  assert.notDeepEqual(v.validate('by-length', { ...shard, entries: [{ ...shard.entries[0], fingerprintMask: [[1, 0]] }] }), [], 'a zero length')
})

test('a single-implementation proxy must list the EIP-1967 slot getVersion reads; other entries may list any', () => {
  const OTHER = `0x${'ab'.repeat(32)}` as const
  const proxy = (extra: Partial<Entry>) => entry(1, 100, { contracts: [TUP], role: 'proxy', ...extra })
  assert.equal(proxySlotProblem(proxy({ implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] })), null)
  assert.equal(proxySlotProblem(proxy({ beaconSlot: EIP1967_BEACON_SLOT })), null)
  assert.equal(proxySlotProblem(proxy({ implementationSlots: [OTHER, SECONDARY_IMPLEMENTATION_SLOT] })), null, 'getVersion reads no slot of a known two-slot proxy')
  assert.equal(proxySlotProblem(entry(1, 100)), null)
  assert.equal(proxySlotProblem(proxy({ implementationSlots: [OTHER] })),
    `${TUP} is a proxy that forwards to one implementation, but its implementation slot is ${OTHER}, not EIP-1967's ${EIP1967_IMPLEMENTATION_SLOT}. ` +
    "getVersion reads only EIP-1967's slots for such a proxy, so it would not find this one's implementation. List EIP-1967's implementation slot in contractRoles, or make getVersion read this slot.")
  assert.match(proxySlotProblem(proxy({ beaconSlot: OTHER }))!, new RegExp(`its beacon slot is ${OTHER}, not EIP-1967's ${EIP1967_BEACON_SLOT}\\.`))
  assert.match(proxySlotProblem(proxy({ beaconSlot: EIP1967_IMPLEMENTATION_SLOT }))!, /its beacon slot is 0x3608/, "a beacon proxy's slot must be the beacon slot")
  assert.match(proxySlotProblem(proxy({ implementationSlots: [EIP1967_BEACON_SLOT] }))!, /its implementation slot is 0xa3f0/)
})

test('generation is deterministic regardless of input order', () => {
  const es = [entry(1, 100), entry(2, 100), entry(3, 200)]
  const ts = [tag('v1.0.0', { 'src/X1.sol:X1': fp(1) }), tag('v1.1.0', { 'src/X2.sol:X2': fp(2) })]
  const a = generateViews(nitro(es, ts))
  const b = generateViews(nitro([...es].reverse(), [...ts].reverse()))
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
  const views = generateViews(nitro([entry(1, 100), manual], [tag('v1.0.0', { 'src/X1.sol:X1': fp(1) })]))
  const shard = JSON.parse(views.get('registry/by-length/100.json')!)
  const index = JSON.parse(views.get('registry/index.json')!)
  assert.deepEqual(v.validate('by-length', shard), [])
  assert.deepEqual(v.validate('index', index), [])
  // The views are schemaVersion 1, and a by-length entry has the fields worked out for it.
  assert.notDeepEqual(v.validate('by-length', { ...shard, schemaVersion: 2 }), [])
  assert.notDeepEqual(v.validate('index', { ...index, schemaVersion: 2 }), [])
  const { version: _, ...noVersion } = shard.entries[0]
  assert.notDeepEqual(v.validate('by-length', { ...shard, entries: [noVersion] }), [], 'no version')
  assert.notDeepEqual(v.validate('by-length', { ...shard, repo: NITRO }), [], 'no top-level repo')
  assert.notDeepEqual(v.validate('index', { schemaVersion: 1, repo: NITRO, codeLengths: [100], getters: [] }), [], 'getters per source, not top-level')
  assert.notDeepEqual(v.validate('index', { ...index, sources: { 'by-length': index.sources['nitro-contracts'] } }), [], 'a reserved source id')
})

test('a source id cannot be a name the generated views use', () => {
  const v = new SchemaValidator(ROOT)
  const cfg = loadSourceConfig(ROOT, 'nitro-contracts')
  assert.deepEqual(v.validate('sources', cfg), [])
  assert.notDeepEqual(v.validate('sources', { ...cfg, directory: 'by-length' }), [])
  assert.notDeepEqual(v.validate('sources', { ...cfg, directory: 'index.json' }), [])
  assert.deepEqual(v.validate('sources', { ...cfg, directory: 'by-length-2' }), [])
})

test('file kinds follow the layout', () => {
  const kinds = Object.fromEntries([
    'config/nitro-contracts/sources.json', 'config/nitro-contracts/out-of-scope-getters.json',
    `registry/nitro-contracts/entries/${fp(1)}.json`, 'registry/nitro-contracts/tags/v3.2.0.json', 'registry/nitro-contracts/branches/hotfix/x.json',
    'registry/by-length/100.json', 'registry/index.json',
    // Not in the layout: views in a source's directory, data outside registry/, a misnamed shard.
    'registry/nitro-contracts/by-length/100.json', 'registry/nitro-contracts/index.json', 'nitro-contracts/entries/x.json', 'registry/by-length/x.json',
  ].map(p => [p, kindOf(p)]))
  assert.deepEqual(Object.values(kinds), ['sources', 'out-of-scope', 'entry', 'tag', 'branch', 'by-length', 'index', null, null, null, null])
})

test('entries and tag files are write-once; nested branch paths are cleaned up on delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'))
  const d = new SourceData(dir, 'nitro-contracts', NITRO)
  d.writeEntry(entry(1, 100))
  assert.ok(fs.existsSync(path.join(dir, `registry/nitro-contracts/entries/${fp(1)}.json`)))
  assert.throws(() => d.writeEntry(entry(1, 100)), /write-once/)
  d.writeTag(tag('v1.0.0', {}))
  assert.throws(() => d.writeTag(tag('v1.0.0', {})), /write-once/)
  d.writeBranch({ schemaVersion: 1, repo: NITRO, branch: 'hotfix/x', commit: commit(1), contracts: {} })
  assert.ok(fs.existsSync(path.join(dir, 'registry/nitro-contracts/branches/hotfix/x.json')))
  d.deleteBranch('hotfix/x')
  assert.ok(!fs.existsSync(path.join(dir, 'registry/nitro-contracts/branches/hotfix')))
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
  const views = generateViews(nitro([proxy], [tag('v1.0.0', { [TUP]: fp(1) })]))
  const shard = JSON.parse(views.get('registry/by-length/100.json')!)
  assert.deepEqual(v.validate('by-length', shard), [])
  assert.deepEqual([shard.entries[0].role, shard.entries[0].implementationSlots, shard.entries[0].packages], ['proxy', [EIP1967_IMPLEMENTATION_SLOT], { [TUP]: OZ }])
  // packages can only name the entry's own contracts (checked outside the schema).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'))
  for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
  new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts').writeEntry({ ...proxy, packages: { [ADMIN]: OZ } })
  assert.deepEqual(validateDataRepo(dir, [{ directory: 'nitro-contracts', repo: 'OffchainLabs/nitro-contracts' }]), [`registry/nitro-contracts/entries/${fp(1)}.json: packages names ${ADMIN}, which isn't in contracts`])
  fs.rmSync(dir, { recursive: true })
})

const BEACON_PROXY = '@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy'

test('schemas: a beacon proxy has a beaconSlot instead of implementationSlots, never both', () => {
  const v = new SchemaValidator(ROOT)
  const beacon = entry(1, 100, { contracts: [BEACON_PROXY], packages: { [BEACON_PROXY]: OZ }, role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT })
  assert.deepEqual(v.validate('entry', beacon), [])
  assert.notDeepEqual(v.validate('entry', { ...beacon, implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] }), [], 'both')
  assert.notDeepEqual(v.validate('entry', { ...beacon, role: 'logic' }), [], 'a beacon slot on logic')
  assert.notDeepEqual(v.validate('entry', { ...beacon, role: 'proxy-admin' }), [], 'a beacon slot on a proxy admin')
  assert.notDeepEqual(v.validate('entry', { ...beacon, beaconSlot: EIP1967_BEACON_SLOT.toUpperCase().replace('0X', '0x') }), [], 'lowercase hex')
  assert.notDeepEqual(v.validate('entry', { ...beacon, beaconSlot: [EIP1967_BEACON_SLOT] }), [], 'one slot, not a list')
  const shard = JSON.parse(generateViews(nitro([beacon], [tag('v1.0.0', { [BEACON_PROXY]: fp(1) })])).get('registry/by-length/100.json')!)
  assert.deepEqual(v.validate('by-length', shard), [])
  assert.deepEqual([shard.entries[0].role, shard.entries[0].beaconSlot, 'implementationSlots' in shard.entries[0]], ['proxy', EIP1967_BEACON_SLOT, false])
  // contractRoles: either kind of proxy, never both.
  const cfg = { ...loadSourceConfig(ROOT, 'nitro-contracts') }
  const withRole = (r: unknown) => ({ ...cfg, contractRoles: { [BEACON_PROXY]: r } })
  assert.deepEqual(v.validate('sources', withRole({ role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT })), [])
  assert.notDeepEqual(v.validate('sources', withRole({ role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT, implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] })), [], 'both')
  assert.notDeepEqual(v.validate('sources', withRole({ role: 'proxy-admin', beaconSlot: EIP1967_BEACON_SLOT })), [], 'a beacon slot on a proxy admin')
  assert.notDeepEqual(v.validate('sources', withRole({ role: 'proxy' })), [], 'a proxy with neither')
})

test('schemas: out-of-scope keys are a getter signature, or a contract name and a getter signature', () => {
  const v = new SchemaValidator(ROOT)
  const list = (...keys: string[]) => ({ schemaVersion: 1, repo: NITRO, getters: Object.fromEntries(keys.map(k => [k, 'reason'])) })
  assert.deepEqual(v.validate('out-of-scope', list('owner()', 'allowedDelayedInboxList(uint256)', 'L1WethGateway.l2Weth()', 'C.list(uint256)', '$x._y()')), [])
  for (const bad of ['l2Weth', 'A.B.l2Weth()', '.l2Weth()', 'L1WethGateway.', 'src/G.sol:G.l2Weth()', 'G.l2Weth(address)', '1G.l2Weth()']) {
    assert.notDeepEqual(v.validate('out-of-scope', list(bad)), [], bad)
  }
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

test('roleOf: a beacon proxy role carries its beacon slot, and differs from every slot role', () => {
  const CLONABLE = 'contracts/tokenbridge/libraries/ClonableBeaconProxy.sol:ClonableBeaconProxy'
  const beacon = { role: 'proxy' as const, beaconSlot: EIP1967_BEACON_SLOT as `0x${string}` }
  const roles: Record<string, RoleConfig> = { [BEACON_PROXY]: beacon, [CLONABLE]: beacon, [TUP]: { role: 'proxy', implementationSlots: [EIP1967_IMPLEMENTATION_SLOT] } }
  // OZ's BeaconProxy and the token bridge's ClonableBeaconProxy can compile to one fingerprint.
  assert.deepEqual(roleOf(roles, [BEACON_PROXY, CLONABLE]), { role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT })
  assert.deepEqual(roleOf({ [BEACON_PROXY]: { role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT.toUpperCase().replace('0X', '0x') as `0x${string}` } }, [BEACON_PROXY]), { role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT })
  // A beacon role mixed with a slot role for one fingerprint is a config error, even for the same slot value.
  assert.throws(() => roleOf(roles, [BEACON_PROXY, TUP]), /different roles in contractRoles.*BeaconProxy: proxy \[beacon 0xa3f0ad74.*TransparentUpgradeableProxy: proxy \[0x360894a1/)
  assert.throws(() => roleOf({ ...roles, [TUP]: { role: 'proxy', implementationSlots: [EIP1967_BEACON_SLOT] } }, [BEACON_PROXY, TUP]), /different roles/)
  assert.throws(() => roleOf({ ...roles, [CLONABLE]: { role: 'proxy-admin' } }, [BEACON_PROXY, CLONABLE]), /different roles/)
  assert.throws(() => roleOf(roles, [BEACON_PROXY, 'src/A.sol:A']), /different roles/, 'beacon vs logic')
  // How roles read, and compare (publish's check of code another source owns compares these).
  assert.equal(describeRole(beacon), `proxy [beacon ${EIP1967_BEACON_SLOT}]`)
  assert.equal(describeRole({ role: 'proxy', beaconSlot: EIP1967_BEACON_SLOT.toUpperCase().replace('0X', '0x') as `0x${string}` }), describeRole(beacon), 'case does not matter')
  assert.notEqual(describeRole({ role: 'proxy', implementationSlots: [EIP1967_BEACON_SLOT] }), describeRole(beacon))
  // The entry: beaconSlot right after role, no implementationSlots.
  const built: BuiltContract = { fqName: CLONABLE, package: null, fingerprint: fp(7), codeLength: 100, maskedRanges: [], cborMetadataLength: 12, getters: [], selectors: [], compiler: entry(7, 100).compiler! }
  const e = entryFromBuild('OffchainLabs/token-bridge-contracts', [built], { ref: 'v1.0.1-beta.0', commit: commit(1) }, roles)
  assert.deepEqual(Object.keys(e).slice(0, 7), ['schemaVersion', 'fingerprint', 'repo', 'contracts', 'role', 'beaconSlot', 'codeLength'])
  assert.ok(!('implementationSlots' in e))
  assert.deepEqual(new SchemaValidator(ROOT).validate('entry', e), [])
})

test('nitro-contracts config: proxies use the walker\'s slots, ProxyAdmin is an admin, and the file is valid', () => {
  const cfg = loadSourceConfig(ROOT, 'nitro-contracts')
  assert.deepEqual(new SchemaValidator(ROOT).validate('sources', cfg), [])
  const slots = (name: string) => { const r = cfg.contractRoles[name]; return r.role !== 'proxy' ? r.role : 'beaconSlot' in r ? `beacon ${r.beaconSlot}` : r.implementationSlots }
  assert.deepEqual(slots(TUP), [EIP1967_IMPLEMENTATION_SLOT])
  assert.deepEqual(slots('@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy'), [EIP1967_IMPLEMENTATION_SLOT])
  assert.deepEqual(slots('src/rollup/RollupProxy.sol:RollupProxy'), [EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT])
  assert.deepEqual(slots('src/libraries/AdminFallbackProxy.sol:AdminFallbackProxy'), [EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT])
  assert.equal(slots(ADMIN), 'proxy-admin')
  // Built by v3.0.0-v3.1.1 (RollupAdminLogic imports it), not by v3.2.0: it upgrades the
  // BeaconProxies that use it and stays through upgrades, like ProxyAdmin.
  assert.equal(slots('@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon'), 'proxy-admin')
  assert.equal(Object.keys(cfg.contractRoles).length, 6)
  // The slots are what EIP-1967 and AdminFallbackProxy define.
  assert.equal(EIP1967_IMPLEMENTATION_SLOT, slotOf('eip1967.proxy.implementation'))
  assert.equal(SECONDARY_IMPLEMENTATION_SLOT, slotOf('eip1967.proxy.implementation.secondary'))
  assert.equal(EIP1967_BEACON_SLOT, slotOf('eip1967.proxy.beacon'))
})

function slotOf(label: string): string {
  return '0x' + (BigInt(keccak256(toHex(label))) - 1n).toString(16).padStart(64, '0')
}
