import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { keccak256 } from 'viem'
import { generateViews, type SourceInputs } from '../src/lib/datarepo.ts'
import { decodeImmutables, fingerprintOf } from '../src/lib/fingerprint.ts'
import { hexToBytes } from '../src/lib/hex.ts'
import { rangeConflicts } from '../src/lib/ranges.ts'
import type { Entry, Hex, TagFile } from '../src/lib/types.ts'
import { HttpSource, Registry, resolveRemote, versionOf } from '../src/walker/registry.ts'
import { ExecutionError, RpcError } from '../src/walker/rpc.ts'
import { EIP1967_BEACON_SLOT as BEACON, EIP1967_IMPLEMENTATION_SLOT as EIP1967, SECONDARY_IMPLEMENTATION_SLOT as SECONDARY } from '../src/walker/walk.ts'

const REPO = 'OffchainLabs/nitro-contracts'
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`
const code = (n: number): Hex => `0x600160020${n.toString(16)}` // distinct, same length
const BRANCH_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

function entry(c: Hex, contract: string, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: keccak256(c), repo: REPO, contracts: [contract], role: 'logic', codeLength: (c.length - 2) / 2,
    maskedRanges: [], cborMetadataLength: 0, getters: [], selectors: [], compiler: null, ref: 'v1.0.0', commit: '1'.repeat(40), ...extra,
  }
}

const tagFilesOf = (repo: string, tags: Record<string, Hex[]>) => Object.entries(tags).map(([tag, fps]): TagFile => ({
  schemaVersion: 1, repo, tag, commit: '2'.repeat(40), prerelease: tag.includes('-'), packageVersion: tag.slice(1),
  contracts: Object.fromEntries(fps.map((f, i) => [`src/C${i}.sol:C${i}`, f])),
}))

/** A registry snapshot in memory, with tags given as tag -> fingerprints, and `others` as further sources. `reads` records every file read. */
function registryOf(entries: Entry[], tags: Record<string, Hex[]>, others: SourceInputs[] = [], reads: string[] = []): Registry {
  const files = generateViews([{ id: 'nitro-contracts', repo: REPO, entries, tags: tagFilesOf(REPO, tags) }, ...others])
  return new Registry({ describe: () => 'memory', read: async rel => { reads.push(rel); return files.get(rel) ?? null } })
}

/** What getVersion reports for nitro-contracts code. */
const v = (version: string, repo = REPO) => ({ version, repo })

test('lookup reads the index first: a length it does not list fetches no shard; a missing index throws', async () => {
  const reads: string[] = []
  const reg = registryOf([entry(code(1), 'src/X.sol:X')], {}, [], reads)
  assert.equal(await reg.lookup(hexToBytes('0x5b')), null)
  assert.deepEqual(reads, ['registry/index.json'], 'no by-length fetch for an absent length')
  assert.ok(await reg.lookup(hexToBytes(code(1))))
  assert.deepEqual(reads, ['registry/index.json', 'registry/by-length/5.json'], 'the index is read once')

  // An old snapshot (layout v1: no registry/index.json) fails loudly instead of answering null.
  const old = new Registry({ describe: () => 'old', read: async rel => (rel === 'nitro-contracts/by-length/5.json' ? '{}' : null) })
  await assert.rejects(old.lookup(hexToBytes(code(1))), /^Error: old is not a layout-v2 registry snapshot: it has no registry\/index\.json$/)
  await assert.rejects(old.getVersion({ getCode: async () => code(1), getStorageAt: async () => word('0x'), call: async () => '0x' }, addr(1)), /not a layout-v2 registry snapshot/)
  // So does an index in another format, or one that lists a length whose shard is missing.
  const v1 = new Registry({ describe: () => 'v1', read: async rel => (rel === 'registry/index.json' ? '{"schemaVersion":1,"codeLengths":[5]}' : null) })
  await assert.rejects(v1.lookup(hexToBytes(code(1))), /registry\/index\.json has schemaVersion 1; this client reads 2/)
  const torn = new Registry({ describe: () => 'torn', read: async rel => (rel === 'registry/index.json' ? '{"schemaVersion":2,"codeLengths":[5],"sources":{}}' : null) })
  await assert.rejects(torn.lookup(hexToBytes(code(1))), /lists code length 5, but registry\/by-length\/5\.json is missing/)
})

test('a failed read is not cached: the next call reads again (index, shard, all)', async () => {
  const files = generateViews([{ id: 'nitro-contracts', repo: REPO, entries: [entry(code(1), 'src/X.sol:X')], tags: [] }])
  const failOnce = new Set(['registry/index.json', 'registry/by-length/5.json'])
  const reads: string[] = []
  const reg = new Registry({
    describe: () => 'flaky',
    read: async rel => {
      reads.push(rel)
      if (failOnce.delete(rel)) throw new TypeError('fetch failed')
      return files.get(rel) ?? null
    },
  })
  await assert.rejects(reg.lookup(hexToBytes(code(1))), /fetch failed/, 'the index read fails')
  await assert.rejects(reg.lookup(hexToBytes(code(1))), /fetch failed/, 'the index is read again; now the shard read fails')
  assert.ok(await reg.lookup(hexToBytes(code(1))), 'and the shard is read again')
  assert.deepEqual(reads, ['registry/index.json', 'registry/index.json', 'registry/by-length/5.json', 'registry/by-length/5.json'])
  assert.ok(await reg.lookup(hexToBytes(code(1))))
  assert.equal(reads.length, 4, 'successful reads stay cached')

  // all() fails with a shard, and then reads it again.
  failOnce.add('registry/by-length/5.json')
  const fresh = new Registry({ describe: () => 'flaky', read: async rel => { if (failOnce.delete(rel)) throw new TypeError('fetch failed'); return files.get(rel) ?? null } })
  await assert.rejects(fresh.all(), /fetch failed/)
  assert.equal((await fresh.all()).length, 1)
})

test('HttpSource retries a fetch that throws (a dropped connection), as it does HTTP 5xx', async () => {
  let requests = 0
  const server = http.createServer((req, res) => {
    if (++requests === 1) { req.socket.destroy(); return }
    res.end(req.url === '/snap/registry/index.json' ? '{"ok":true}' : '')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address() as AddressInfo
    assert.equal(await new HttpSource(`http://127.0.0.1:${port}/snap`).read('registry/index.json'), '{"ok":true}')
    assert.equal(requests, 2)
  } finally {
    server.close()
  }
})

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
  // Proxies whose own code the registry doesn't know.
  unknownTup: addr(16), unknownRollup: addr(17), unknownTupUnknownImpl: addr(18), unknownTupNoCodeImpl: addr(19),
}
const OZ_TUP = '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy'

function versionRegistry(): Registry {
  const entries = [
    entry(C.logic, 'src/bridge/Bridge.sol:Bridge'),
    entry(C.tup, OZ_TUP, { role: 'proxy', implementationSlots: [EIP1967] }),
    entry(C.rollupProxy, 'src/rollup/RollupProxy.sol:RollupProxy', { role: 'proxy', implementationSlots: [EIP1967, SECONDARY] }),
    entry(C.admin, '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin', { role: 'proxy-admin' }),
    entry(C.pre, 'src/bridge/Outbox.sol:Outbox'),
    entry(C.branchOnly, 'src/bridge/Inbox.sol:Inbox', { ref: 'release-3.5.0', commit: BRANCH_COMMIT }),
    entry(C.manual, 'src/bridge/Bridge.sol:Bridge', { ref: null, commit: null, label: 'Arbitrum One Bridge (patched v3.0.0)' }),
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
    [A.unknownTup]: C.unknown, [A.unknownRollup]: C.unknown, [A.unknownTupUnknownImpl]: C.unknown, [A.unknownTupNoCodeImpl]: C.unknown,
  }
  const storage: Record<string, Record<string, string>> = {
    [A.tup]: { [EIP1967]: word(A.logic) },
    [A.rollup]: { [EIP1967]: word(A.rollupLogic), [SECONDARY]: word(A.rollupLogic) },
    [A.tupUnknownImpl]: { [EIP1967]: word(A.unknownImpl) },
    [A.tupNoCodeImpl]: { [EIP1967]: word(A.account) },
    [A.tupPreImpl]: { [EIP1967]: word(A.pre) },
    [A.unknownTup]: { [EIP1967]: word(A.logic) },
    // Its EIP-1967 slot holds known logic (as an old RollupProxy's holds RollupAdminLogic), which it must not report.
    [A.unknownRollup]: { [EIP1967]: word(A.logic), [SECONDARY]: word(A.rollupLogic) },
    [A.unknownTupUnknownImpl]: { [EIP1967]: word(A.unknownImpl) },
    [A.unknownTupNoCodeImpl]: { [EIP1967]: word(A.account) },
  }
  const storageReads: string[] = []
  const rpc = {
    getCode: async (a: string, _block: string) => codes[a.toLowerCase()] ?? '0x',
    getStorageAt: async (a: string, slot: string, _block: string) => { storageReads.push(`${a.toLowerCase()} ${slot}`); return storage[a.toLowerCase()]?.[slot] ?? word('0x') },
    call: async (to: string): Promise<string> => { throw new Error(`unexpected eth_call to ${to}`) },
  }
  return { rpc, storageReads }
}

test('getVersion: logic and proxy admins report their own release; a one-slot proxy reports its implementation', async () => {
  const reg = versionRegistry()
  const { rpc, storageReads } = versionChain()
  assert.deepEqual(await reg.getVersion(rpc, A.logic), v('v3.2.0'), 'the first release, skipping the earlier prerelease')
  assert.deepEqual(await reg.getVersion(rpc, A.admin), v('v3.1.0'), 'a proxy admin reports itself')
  assert.deepEqual(await reg.getVersion(rpc, A.tup), v('v3.2.0'), "a one-slot proxy (v3.1.0) reports its implementation's version")
  assert.deepEqual(await reg.getVersion(rpc, A.tupPreImpl), v('v3.4.0-beta.0'), "the implementation's prerelease")
  assert.deepEqual(storageReads, [`${A.tup} ${EIP1967}`, `${A.tupPreImpl} ${EIP1967}`], 'only one-slot proxies read a slot')
})

test('getVersion: RollupProxy (two slots) reports itself, even when its logic is newer', async () => {
  const { rpc, storageReads } = versionChain()
  assert.deepEqual(await versionRegistry().getVersion(rpc, A.rollup), v('v3.1.0'))
  assert.deepEqual(storageReads, [])
})

test('getVersion: unknown code reports the implementation at its EIP-1967 slot, unless its secondary slot is set', async () => {
  const reg = versionRegistry()
  const { rpc, storageReads } = versionChain()
  assert.deepEqual(await reg.getVersion(rpc, A.unknownTup), v('v3.2.0'), "an unknown proxy reports its known implementation's version")
  assert.deepEqual(storageReads.splice(0), [`${A.unknownTup} ${EIP1967}`, `${A.unknownTup} ${SECONDARY}`], 'probed as the walker probes it')
  assert.equal(await reg.getVersion(rpc, A.unknownRollup), null, 'an unknown two-slot proxy has no version of its own, not its admin logic\'s')
  assert.equal(await reg.getVersion(rpc, A.unknown), null, 'unknown code with neither slot set')
  assert.deepEqual(storageReads.splice(0).filter(r => r.startsWith(A.unknown + ' ')), [`${A.unknown} ${EIP1967}`, `${A.unknown} ${BEACON}`], 'a zero EIP-1967 slot is followed by the beacon slot, not the secondary')
  assert.equal(await reg.getVersion(rpc, A.unknownTupUnknownImpl), null, 'an unknown proxy whose implementation is unknown')
  assert.equal(await reg.getVersion(rpc, A.unknownTupNoCodeImpl), null, 'an unknown proxy whose implementation has no code')
})

test('getVersion: an account, and a known proxy with an unknown, zero or codeless implementation give null', async () => {
  const reg = versionRegistry()
  const { rpc } = versionChain()
  assert.equal(await reg.getVersion(rpc, A.account), null, 'no code')
  assert.equal(await reg.getVersion(rpc, A.tupUnknownImpl), null, 'an implementation the registry does not know')
  assert.equal(await reg.getVersion(rpc, A.tupZeroSlot), null, 'a zero implementation slot')
  assert.equal(await reg.getVersion(rpc, A.tupNoCodeImpl), null, 'an implementation with no code')
})

test('getVersion: prerelease-only code gives its first prerelease; code in no tag gives ref@commit; a manual entry its label', async () => {
  const reg = versionRegistry()
  const { rpc } = versionChain()
  assert.deepEqual(await reg.getVersion(rpc, A.pre), v('v3.4.0-beta.0'))
  assert.deepEqual(await reg.getVersion(rpc, A.branchOnly), v(`release-3.5.0@${BRANCH_COMMIT.slice(0, 12)}`))
  assert.deepEqual(await reg.getVersion(rpc, A.manual), v('Arbitrum One Bridge (patched v3.0.0)'))
})

test("getVersion: a proxy reports its implementation's repo, which can be another source's", async () => {
  // An Orbit chain's upgrade executor: a nitro-contracts proxy in front of upgrade-executor logic.
  const UE = 'OffchainLabs/upgrade-executor'
  const ueLogic = code(9)
  const ue: SourceInputs = { id: 'upgrade-executor', repo: UE, entries: [entry(ueLogic, 'src/UpgradeExecutor.sol:UpgradeExecutor', { repo: UE })], tags: tagFilesOf(UE, { 'v1.1.0': [keccak256(ueLogic)] }) }
  const reg = registryOf([entry(C.tup, OZ_TUP, { role: 'proxy', implementationSlots: [EIP1967] })], { 'v3.2.0': [keccak256(C.tup)] }, [ue])
  const [proxy, unknownProxy, logic] = [addr(1), addr(2), addr(3)]
  const codes: Record<string, Hex> = { [proxy]: C.tup, [unknownProxy]: C.unknown, [logic]: ueLogic }
  const rpc = {
    getCode: async (a: string) => codes[a] ?? '0x',
    getStorageAt: async (a: string, slot: string) => (a !== logic && slot === EIP1967 ? word(logic) : word('0x')),
    call: async (): Promise<string> => '0x',
  }
  assert.deepEqual(await reg.getVersion(rpc, proxy), v('v1.1.0', UE), "the implementation's version and repo, not the proxy's v3.2.0")
  assert.deepEqual(await reg.getVersion(rpc, unknownProxy), v('v1.1.0', UE), 'likewise behind an unknown proxy')
  assert.deepEqual(await reg.getVersion(rpc, logic), v('v1.1.0', UE))
  assert.equal((await reg.lookup(hexToBytes(C.tup)))?.repo, REPO, "the proxy's own entry is still nitro-contracts'")
})

// --- Beacon proxies ------------------------------------------------------------------------------

const BEACON_PROXY = '@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy'

/**
 * A registry with a beacon proxy entry (v1.0.0), logic (v1.2.0, and an unreleased v1.1.0-beta.0
 * before it) and a beacon (proxy admin), and a chain of beacon proxies. `calls` records every
 * eth_call as `<to> <data>`.
 */
function beaconFixture() {
  const BC = { proxy: code(1), logic: code(2), beacon: code(3), unknown: code(4), tup: code(5) }
  const reg = registryOf([
    entry(BC.proxy, BEACON_PROXY, { role: 'proxy', beaconSlot: BEACON }),
    entry(BC.logic, 'contracts/tokenbridge/arbitrum/StandardArbERC20.sol:StandardArbERC20'),
    entry(BC.beacon, '@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon', { role: 'proxy-admin' }),
    entry(BC.tup, OZ_TUP, { role: 'proxy', implementationSlots: [EIP1967] }),
  ], { 'v1.0.0': [keccak256(BC.proxy), keccak256(BC.beacon), keccak256(BC.tup)], 'v1.1.0-beta.0': [keccak256(BC.logic)], 'v1.2.0': [keccak256(BC.logic)] })
  const B = {
    proxy: addr(1), logic: addr(2), beacon: addr(3), unknownLogic: addr(4), account: addr(5),
    // Beacon proxies whose beacon slot is zero, or holds a beacon that reverts, has no code, returns
    // zero, returns an unknown implementation, returns one with no code, or returns too few bytes.
    zeroSlot: addr(0x10), reverting: addr(0x11), noCodeBeacon: addr(0x12), zeroBeacon: addr(0x13), unknownImpl: addr(0x14), noCodeImpl: addr(0x15), short: addr(0x16),
    // Unknown code with only the beacon slot set; with both slots set; behind an RPC that fails.
    unknownBeaconProxy: addr(0x20), unknownBoth: addr(0x21), flaky: addr(0x22),
    beaconReverting: addr(0x30), beaconZero: addr(0x31), beaconUnknown: addr(0x32), beaconNoCodeImpl: addr(0x33), beaconShort: addr(0x34), beaconFlaky: addr(0x35),
  }
  const codes: Record<string, Hex> = {
    [B.logic]: BC.logic, [B.beacon]: BC.beacon, [B.unknownLogic]: BC.unknown,
    [B.beaconReverting]: BC.beacon, [B.beaconZero]: BC.beacon, [B.beaconUnknown]: BC.beacon, [B.beaconNoCodeImpl]: BC.beacon, [B.beaconShort]: BC.beacon, [B.beaconFlaky]: BC.beacon,
    [B.unknownBeaconProxy]: BC.unknown, [B.unknownBoth]: BC.unknown, [B.flaky]: BC.proxy,
  }
  for (const a of [B.proxy, B.zeroSlot, B.reverting, B.noCodeBeacon, B.zeroBeacon, B.unknownImpl, B.noCodeImpl, B.short]) codes[a] = BC.proxy
  const beaconOf: Record<string, string> = {
    [B.proxy]: B.beacon, [B.reverting]: B.beaconReverting, [B.noCodeBeacon]: B.account, [B.zeroBeacon]: B.beaconZero, [B.unknownImpl]: B.beaconUnknown,
    [B.noCodeImpl]: B.beaconNoCodeImpl, [B.short]: B.beaconShort, [B.unknownBeaconProxy]: B.beacon, [B.unknownBoth]: B.beacon, [B.flaky]: B.beaconFlaky,
  }
  const implementationOf: Record<string, string> = { [B.beacon]: word(B.logic), [B.beaconZero]: word('0x'), [B.beaconUnknown]: word(B.unknownLogic), [B.beaconNoCodeImpl]: word(B.account), [B.beaconShort]: '0x' + B.logic.slice(2) }
  const storageReads: string[] = [], calls: string[] = []
  const rpc = {
    getCode: async (a: string) => codes[a.toLowerCase()] ?? '0x',
    getStorageAt: async (a: string, slot: string) => {
      storageReads.push(`${a.toLowerCase()} ${slot}`)
      if (slot === BEACON && beaconOf[a.toLowerCase()]) return word(beaconOf[a.toLowerCase()])
      if (slot === EIP1967 && a.toLowerCase() === B.unknownBoth) return word(B.logic)
      return word('0x')
    },
    call: async (to: string, data: string) => {
      calls.push(`${to.toLowerCase()} ${data}`)
      if (to.toLowerCase() === B.beaconReverting) throw new ExecutionError('execution reverted')
      if (to.toLowerCase() === B.beaconFlaky) throw new RpcError('eth_call failed after 7 attempts: HTTP 503')
      return implementationOf[to.toLowerCase()] ?? '0x' // an account answers with no data
    },
  }
  return { reg, B, rpc, storageReads, calls }
}

test("getVersion: a beacon proxy reports its beacon's implementation, not its own version", async () => {
  const { reg, B, rpc, storageReads, calls } = beaconFixture()
  assert.equal(versionOf((await reg.lookup(hexToBytes(code(1))))!), 'v1.0.0', "the proxy's own entry")
  assert.deepEqual(await reg.getVersion(rpc, B.proxy), v('v1.2.0'), "the implementation's first release")
  assert.deepEqual(storageReads, [`${B.proxy} ${BEACON}`], 'only the beacon slot its entry lists')
  assert.deepEqual(calls, [`${B.beacon} 0x5c60da1b`], "then the beacon's implementation()")
  assert.deepEqual(await reg.getVersion(rpc, B.beacon), v('v1.0.0'), 'the beacon itself is a proxy admin, and reports itself')
})

test('getVersion: a beacon proxy gives null for a zero slot, a reverting or codeless beacon, and a zero, unknown or codeless implementation', async () => {
  const { reg, B, rpc, calls } = beaconFixture()
  assert.equal(await reg.getVersion(rpc, B.zeroSlot), null, 'zero beacon slot')
  assert.equal(await reg.getVersion(rpc, B.reverting), null, 'implementation() reverts')
  assert.equal(await reg.getVersion(rpc, B.noCodeBeacon), null, 'the beacon has no code (the call returns no data)')
  assert.equal(await reg.getVersion(rpc, B.zeroBeacon), null, 'implementation() returns zero')
  assert.equal(await reg.getVersion(rpc, B.short), null, 'implementation() returns fewer than 32 bytes')
  assert.equal(await reg.getVersion(rpc, B.unknownImpl), null, 'an implementation the registry does not know')
  assert.equal(await reg.getVersion(rpc, B.noCodeImpl), null, 'an implementation with no code')
  assert.ok(!calls.some(c => c.startsWith(B.beacon + ' ')), 'a zero slot calls nothing')
  await assert.rejects(reg.getVersion(rpc, B.flaky), /HTTP 503/, 'an RPC failure is not a revert: it throws')
})

test("getVersion: unknown code with a zero EIP-1967 slot reports the implementation of the beacon in its beacon slot", async () => {
  const { reg, B, rpc, storageReads, calls } = beaconFixture()
  assert.deepEqual(await reg.getVersion(rpc, B.unknownBeaconProxy), v('v1.2.0'))
  assert.deepEqual(storageReads.splice(0), [`${B.unknownBeaconProxy} ${EIP1967}`, `${B.unknownBeaconProxy} ${BEACON}`])
  assert.deepEqual(calls.splice(0), [`${B.beacon} 0x5c60da1b`])
  // A set EIP-1967 slot wins: the beacon slot isn't read.
  assert.deepEqual(await reg.getVersion(rpc, B.unknownBoth), v('v1.2.0'))
  assert.deepEqual(storageReads.splice(0), [`${B.unknownBoth} ${EIP1967}`, `${B.unknownBoth} ${SECONDARY}`])
  assert.deepEqual(calls, [])
})

test('versionOf: release, then prerelease, then a manual entry\'s label, then ref@commit', () => {
  const base = { ...entry(C.logic, 'src/X.sol:X'), ref: 'release-3.3.0', commit: BRANCH_COMMIT }
  assert.equal(versionOf({ ...base, tags: ['v3.2.0-beta.0', 'v3.2.0', 'v3.2.1'] }), 'v3.2.0')
  assert.equal(versionOf({ ...base, tags: ['v3.1.0-qol', 'v3.2.0-rc.1'] }), 'v3.1.0-qol', 'a tag with a suffix is a prerelease')
  assert.equal(versionOf({ ...base, tags: [] }), 'release-3.3.0@abcdef012345', 'built only as a release branch head')
  assert.equal(versionOf({ ...base, ref: 'hotfix-3.2.1', tags: [] }), 'hotfix-3.2.1@abcdef012345', 'built only as a hotfix branch head')
  // Manual entries: the label when there's no tag, with or without a ref and commit; a tag still wins.
  const manual = { ...base, ref: null, commit: null, label: 'Arbitrum One Bridge (patched v3.0.0)' }
  assert.equal(versionOf({ ...manual, tags: [] }), 'Arbitrum One Bridge (patched v3.0.0)')
  assert.equal(versionOf({ ...base, label: 'patched one-off', tags: [] }), 'patched one-off')
  assert.equal(versionOf({ ...manual, tags: ['v3.0.0'] }), 'v3.0.0')
})

test('resolveRemote: an annotated tag gives its commit, not the tag object; names match exactly; a branch wins over a tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-remote-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    const commit = (m: string) => { git('commit', '-q', '--allow-empty', '-m', m); return git('rev-parse', 'HEAD') }
    const c1 = commit('one')
    git('tag', '-a', 'v1.0.0', '-m', 'an annotated tag')
    git('branch', 'feature/main') // sorts before refs/heads/main
    git('branch', 'both')
    const c2 = commit('two')
    git('tag', 'v1.0.1') // lightweight
    git('tag', 'both')
    const c3 = commit('three')

    assert.notEqual(git('rev-parse', 'v1.0.0'), c1, 'the tag object is not the commit')
    assert.equal(resolveRemote(dir, 'v1.0.0'), c1)
    assert.equal(resolveRemote(dir, 'v1.0.1'), c2)
    assert.equal(resolveRemote(dir, 'main'), c3, 'not refs/heads/feature/main')
    assert.equal(resolveRemote(dir, 'feature/main'), c1)
    assert.equal(resolveRemote(dir, 'both'), c1, 'the branch, not the tag')
    assert.throws(() => resolveRemote(dir, 'v9.9.9'), /can't resolve v9\.9\.9/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
