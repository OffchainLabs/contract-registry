import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256 } from 'viem'
import { generateViews } from '../src/lib/datarepo.ts'
import { decodeImmutables, fingerprintOf } from '../src/lib/fingerprint.ts'
import { hexToBytes } from '../src/lib/hex.ts'
import { rangeConflicts } from '../src/lib/ranges.ts'
import type { Entry, Hex, TagFile } from '../src/lib/types.ts'
import { Registry, versionOf } from '../src/walker/registry.ts'
import { EIP1967_IMPLEMENTATION_SLOT as EIP1967, SECONDARY_IMPLEMENTATION_SLOT as SECONDARY } from '../src/walker/walk.ts'

const REPO = 'OffchainLabs/nitro-contracts'
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`
const code = (n: number): Hex => `0x600160020${n.toString(16)}` // distinct, same length
const BRANCH_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

function entry(c: Hex, contract: string, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: keccak256(c), repo: REPO, contracts: [contract], role: 'logic', codeLength: (c.length - 2) / 2,
    maskedRanges: [], cborMetadataLength: 0, getters: [], selectors: [], compiler: null, firstCommit: '1'.repeat(40), firstBranch: 'main', ...extra,
  }
}

/** A registry snapshot in memory, with tags given as tag -> fingerprints. */
function registryOf(entries: Entry[], tags: Record<string, Hex[]>): Registry {
  const tagFiles = Object.entries(tags).map(([tag, fps]): TagFile => ({
    schemaVersion: 1, repo: REPO, tag, commit: '2'.repeat(40), prerelease: tag.includes('-'), packageVersion: tag.slice(1),
    contracts: Object.fromEntries(fps.map((f, i) => [`src/C${i}.sol:C${i}`, f])),
  }))
  const files = generateViews(REPO, 'nitro-contracts', entries, tagFiles)
  return new Registry({ describe: () => 'memory', read: async rel => files.get(rel) ?? null }, 'nitro-contracts')
}

test('lookup: the entry the code matches, or null; decodeImmutables reads its immutables', async () => {
  // Two entries of one length that mask the same bytes: a uint256 immutable and a library address.
  const maskedRanges = [
    { name: 'maxDataSize', type: 'uint256', offsets: [1], length: 32 },
    { name: '<library address>', type: 'address', offsets: [34], length: 20 },
  ]
  const build = (tail: string): Hex => `0x60${'00'.repeat(32)}73${'00'.repeat(20)}${tail}`
  const spec = { codeLength: 55, maskedRanges, cborMetadataLength: 0 }
  const mk = (tail: string, contract: string): Entry => ({ ...entry(build(tail), contract, { maskedRanges }), fingerprint: fingerprintOf(hexToBytes(build(tail)), spec) })
  const entries = [mk('5b', 'src/bridge/SequencerInbox.sol:SequencerInbox'), mk('5c', 'src/bridge/Inbox.sol:Inbox')]
  assert.deepEqual(rangeConflicts(entries, []), [], 'the registry invariant holds')
  const reg = registryOf(entries, {})

  const deployed = hexToBytes(`0x60${(117964).toString(16).padStart(64, '0')}73${'ab'.repeat(20)}5c`)
  const e = await reg.lookup(deployed)
  assert.equal(e?.fingerprint, entries[1].fingerprint)
  assert.deepEqual(decodeImmutables(deployed, e!), { maxDataSize: '117964' }, 'the library address is masked but not reported')
  assert.equal(await reg.lookup(hexToBytes(`0x60${'00'.repeat(53)}5d`)), null, 'same length, no entry')
  assert.equal(await reg.lookup(hexToBytes('0x5b')), null, 'a length with no shard')
})

// --- getVersion -------------------------------------------------------------------------------

const C = {
  logic: code(1), tup: code(2), rollupProxy: code(3), admin: code(4), pre: code(5), branchOnly: code(6), manual: code(7), unknown: code(8),
}
const A = {
  logic: addr(1), tup: addr(2), rollup: addr(3), admin: addr(4), pre: addr(5), branchOnly: addr(6), manual: addr(7), unknown: addr(8),
  account: addr(9), tupUnknownImpl: addr(10), tupZeroSlot: addr(11), tupNoCodeImpl: addr(12), rollupLogic: addr(13), unknownImpl: addr(14), tupPreImpl: addr(15),
}
const OZ_TUP = '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy'

function versionRegistry(): Registry {
  const entries = [
    entry(C.logic, 'src/bridge/Bridge.sol:Bridge'),
    entry(C.tup, OZ_TUP, { role: 'proxy', implementationSlots: [EIP1967] }),
    entry(C.rollupProxy, 'src/rollup/RollupProxy.sol:RollupProxy', { role: 'proxy', implementationSlots: [EIP1967, SECONDARY] }),
    entry(C.admin, '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin', { role: 'proxy-admin' }),
    entry(C.pre, 'src/bridge/Outbox.sol:Outbox'),
    entry(C.branchOnly, 'src/bridge/Inbox.sol:Inbox', { firstCommit: BRANCH_COMMIT, firstBranch: 'develop' }),
    entry(C.manual, 'src/bridge/Bridge.sol:Bridge', { firstCommit: null, firstBranch: null, label: 'Arbitrum One Bridge (patched v3.0.0)' }),
  ]
  const fp = (c: Hex) => keccak256(c)
  return registryOf(entries, {
    // Bridge is in a prerelease, then two releases; the proxies and admin are from an older release.
    'v3.2.0-beta.0': [fp(C.logic)], 'v3.2.0': [fp(C.logic)], 'v3.3.0': [fp(C.logic)],
    'v3.1.0': [fp(C.tup), fp(C.rollupProxy), fp(C.admin)],
    // Outbox is only in prereleases.
    'v3.4.0-beta.0': [fp(C.pre)], 'v3.4.0-rc.1': [fp(C.pre)],
  })
}

function versionChain() {
  const codes: Record<string, Hex> = {
    [A.logic]: C.logic, [A.tup]: C.tup, [A.rollup]: C.rollupProxy, [A.admin]: C.admin, [A.pre]: C.pre, [A.branchOnly]: C.branchOnly,
    [A.manual]: C.manual, [A.unknown]: C.unknown, [A.tupUnknownImpl]: C.tup, [A.tupZeroSlot]: C.tup, [A.tupNoCodeImpl]: C.tup,
    [A.rollupLogic]: C.logic, [A.unknownImpl]: C.unknown, [A.tupPreImpl]: C.tup,
  }
  const storage: Record<string, Record<string, string>> = {
    [A.tup]: { [EIP1967]: word(A.logic) },
    [A.rollup]: { [EIP1967]: word(A.rollupLogic), [SECONDARY]: word(A.rollupLogic) },
    [A.tupUnknownImpl]: { [EIP1967]: word(A.unknownImpl) },
    [A.tupNoCodeImpl]: { [EIP1967]: word(A.account) },
    [A.tupPreImpl]: { [EIP1967]: word(A.pre) },
  }
  const storageReads: string[] = []
  const rpc = {
    getCode: async (a: string, _block: string) => codes[a.toLowerCase()] ?? '0x',
    getStorageAt: async (a: string, slot: string, _block: string) => { storageReads.push(`${a.toLowerCase()} ${slot}`); return storage[a.toLowerCase()]?.[slot] ?? word('0x') },
  }
  return { rpc, storageReads }
}

test('getVersion: logic and proxy admins report their own release; a one-slot proxy reports its implementation', async () => {
  const reg = versionRegistry()
  const { rpc, storageReads } = versionChain()
  assert.equal(await reg.getVersion(rpc, A.logic), 'v3.2.0', 'the first release, skipping the earlier prerelease')
  assert.equal(await reg.getVersion(rpc, A.admin), 'v3.1.0', 'a proxy admin reports itself')
  assert.equal(await reg.getVersion(rpc, A.tup), 'v3.2.0', "a one-slot proxy (v3.1.0) reports its implementation's version")
  assert.equal(await reg.getVersion(rpc, A.tupPreImpl), 'v3.4.0-beta.0', "the implementation's prerelease")
  assert.deepEqual(storageReads, [`${A.tup} ${EIP1967}`, `${A.tupPreImpl} ${EIP1967}`], 'only one-slot proxies read a slot')
})

test('getVersion: RollupProxy (two slots) reports itself, even when its logic is newer', async () => {
  const { rpc, storageReads } = versionChain()
  assert.equal(await versionRegistry().getVersion(rpc, A.rollup), 'v3.1.0')
  assert.deepEqual(storageReads, [])
})

test('getVersion: unknown code, an account, and an unknown, zero or codeless implementation give null', async () => {
  const reg = versionRegistry()
  const { rpc } = versionChain()
  assert.equal(await reg.getVersion(rpc, A.unknown), null, 'unknown code')
  assert.equal(await reg.getVersion(rpc, A.account), null, 'no code')
  assert.equal(await reg.getVersion(rpc, A.tupUnknownImpl), null, 'an implementation the registry does not know')
  assert.equal(await reg.getVersion(rpc, A.tupZeroSlot), null, 'a zero implementation slot')
  assert.equal(await reg.getVersion(rpc, A.tupNoCodeImpl), null, 'an implementation with no code')
})

test('getVersion: prerelease-only code gives its first prerelease; a branch-only build gives branch@commit', async () => {
  const reg = versionRegistry()
  const { rpc } = versionChain()
  assert.equal(await reg.getVersion(rpc, A.pre), 'v3.4.0-beta.0')
  assert.equal(await reg.getVersion(rpc, A.branchOnly), `develop@${BRANCH_COMMIT.slice(0, 12)}`)
  // Not in the pseudocode: a manual entry has no tag or commit, so it gives its label.
  assert.equal(await reg.getVersion(rpc, A.manual), 'Arbitrum One Bridge (patched v3.0.0)')
})

test('versionOf: release, then prerelease, then branch@commit', () => {
  const base = { ...entry(C.logic, 'src/X.sol:X'), firstCommit: BRANCH_COMMIT, firstBranch: 'develop' }
  assert.equal(versionOf({ ...base, tags: ['v3.2.0-beta.0', 'v3.2.0', 'v3.2.1'] }), 'v3.2.0')
  assert.equal(versionOf({ ...base, tags: ['v3.1.0-qol', 'v3.2.0-rc.1'] }), 'v3.1.0-qol', 'a tag with a suffix is a prerelease')
  assert.equal(versionOf({ ...base, tags: [] }), 'develop@abcdef012345')
})
