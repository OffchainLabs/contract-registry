import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAddress, keccak256, toFunctionSelector } from 'viem'
import { generateViews, type SourceInputs } from '../src/lib/datarepo.ts'
import { evaluate, unreadSlots } from '../src/lib/testcheck.ts'
import type { Entry, Hex, TagFile } from '../src/lib/types.ts'
import { Registry } from '../src/walker/registry.ts'
import { ExecutionError, type Rpc } from '../src/walker/rpc.ts'
import { EIP1967_BEACON_SLOT as BEACON, EIP1967_IMPLEMENTATION_SLOT as EIP1967, SECONDARY_IMPLEMENTATION_SLOT as SECONDARY, walk, type WalkNode, type WalkResult } from '../src/walker/walk.ts'

const REPO = 'OffchainLabs/nitro-contracts'
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`
const ZERO_WORD = word('0x')
const code = (n: number): Hex => `0x600160020${n.toString(16)}` // distinct, same length

// Code at each address of the fake chain. Proxies (and the admin) are from v1.0.0; logic is v2.0.0.
const C = { rollupProxy: code(1), proxy: code(2), admin: code(3), adminLogic: code(4), userLogic: code(5), bridgeLogic: code(6), legacyLogic: code(7), plain: code(8), unknownProxy: code(9) }
const ROLLUP = addr(1), BRIDGE = addr(2), ADMIN = addr(3), LEGACY = addr(4), PLAIN = addr(5)
const ADMIN_LOGIC = addr(0x11), USER_LOGIC = addr(0x12), BRIDGE_LOGIC = addr(0x13), LEGACY_LOGIC = addr(0x15), STRAY = addr(0x16)

const getter = (signature: string) => ({ signature, selector: toFunctionSelector(signature), kind: 'single' as const })
const fp = (c: Hex) => keccak256(c)
const OZ_TUP = '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy'

function entry(c: Hex, contract: string, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: fp(c), repo: REPO, contracts: [contract], role: 'logic', codeLength: (c.length - 2) / 2,
    maskedRanges: [], cborMetadataLength: 0, getters: [], selectors: [], compiler: null, ref: 'v1.0.0', commit: '1'.repeat(40), ...extra,
  }
}

function registry(overrides: Partial<Record<keyof typeof C, Partial<Entry>>> = {}, others: SourceInputs[] = [], extraFiles: Record<string, string> = {}): Registry {
  const entries = [
    entry(C.rollupProxy, 'src/rollup/RollupProxy.sol:RollupProxy', { role: 'proxy', implementationSlots: [EIP1967, SECONDARY], ...overrides.rollupProxy }),
    entry(C.proxy, OZ_TUP, { role: 'proxy', implementationSlots: [EIP1967], packages: { [OZ_TUP]: '@openzeppelin/contracts@4.7.3' }, ...overrides.proxy }),
    entry(C.admin, '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin', { role: 'proxy-admin', ...overrides.admin }),
    entry(C.adminLogic, 'src/rollup/RollupAdminLogic.sol:RollupAdminLogic', { getters: [getter('bridge()')], ...overrides.adminLogic }),
    entry(C.userLogic, 'src/rollup/RollupUserLogic.sol:RollupUserLogic', { ...overrides.userLogic }),
    entry(C.bridgeLogic, 'src/bridge/Bridge.sol:Bridge', { getters: [getter('legacy()'), getter('plain()'), getter('proxyAdmin()')], ...overrides.bridgeLogic }),
    entry(C.legacyLogic, 'src/bridge/Outbox.sol:Outbox', { ...overrides.legacyLogic }),
    entry(C.plain, 'src/osp/OneStepProofEntry.sol:OneStepProofEntry', { ...overrides.plain }),
  ]
  const tag = (name: string, fps: Hex[]): TagFile => ({ schemaVersion: 1, repo: REPO, tag: name, commit: '2'.repeat(40), prerelease: false, packageVersion: name.slice(1), contracts: Object.fromEntries(fps.map((f, i) => [`src/C${i}.sol:C${i}`, f])) })
  // v2.0.0 changed the proxies' code; the chain still runs the v1.0.0 proxies with v2.0.0 logic.
  const v1 = [C.rollupProxy, C.proxy, C.admin].map(fp)
  const v2 = [C.adminLogic, C.userLogic, C.bridgeLogic, C.legacyLogic, C.plain].map(fp).concat([keccak256('0x01'), keccak256('0x02')])
  const files = generateViews([{ id: 'nitro-contracts', repo: REPO, entries, tags: [tag('v1.0.0', v1), tag('v2.0.0', v2)] }, ...others])
  for (const [rel, content] of Object.entries(extraFiles)) files.set(rel, content)
  return new Registry({ describe: () => 'memory', read: async rel => files.get(rel) ?? null })
}

/** A second source, `other`, whose one logic entry (code F, tag v7.0.0) has the getter `foreign()`. */
const OTHER = 'Example/other'
const F: Hex = '0x6001600299'
const foreign = getter('foreign()')
const other = (): SourceInputs => ({
  id: 'other', repo: OTHER, entries: [entry(F, 'src/F.sol:F', { repo: OTHER, getters: [foreign] })],
  tags: [{ schemaVersion: 1, repo: OTHER, tag: 'v7.0.0', commit: '3'.repeat(40), prerelease: false, packageVersion: '7.0.0', contracts: { 'src/F.sol:F': fp(F) } }],
})

/** A chain served from maps, recording every storage read. */
function chain() {
  const codes: Record<string, Hex> = {
    [ROLLUP]: C.rollupProxy, [BRIDGE]: C.proxy, [ADMIN]: C.admin, [LEGACY]: C.unknownProxy, [PLAIN]: C.plain,
    [ADMIN_LOGIC]: C.adminLogic, [USER_LOGIC]: C.userLogic, [BRIDGE_LOGIC]: C.bridgeLogic, [LEGACY_LOGIC]: C.legacyLogic, [STRAY]: C.userLogic,
  }
  const storage: Record<string, Record<string, string>> = {
    [ROLLUP]: { [EIP1967]: word(ADMIN_LOGIC), [SECONDARY]: word(USER_LOGIC) },
    [BRIDGE]: { [EIP1967]: word(BRIDGE_LOGIC) },
    // A proxy the registry doesn't know (e.g. older than its start): found by probing.
    [LEGACY]: { [EIP1967]: word(LEGACY_LOGIC), [SECONDARY]: word(USER_LOGIC) },
    // Logic code with something in the EIP-1967 slot: the walker must not follow it.
    [PLAIN]: { [EIP1967]: word(STRAY) },
  }
  const calls: Record<string, string> = {
    [ROLLUP + getter('bridge()').selector]: word(BRIDGE),
    [BRIDGE + getter('proxyAdmin()').selector]: word(ADMIN),
    [BRIDGE + getter('legacy()').selector]: word(LEGACY),
    [BRIDGE + getter('plain()').selector]: word(PLAIN),
  }
  const storageReads: string[] = []
  const rpc = {
    requests: 0,
    chainId: async () => 1,
    blockNumber: async () => 100n,
    getCode: async (a: string) => codes[a.toLowerCase()] ?? '0x',
    getStorageAt: async (a: string, slot: string) => { storageReads.push(`${a.toLowerCase()} ${slot}`); return storage[a.toLowerCase()]?.[slot] ?? ZERO_WORD },
    call: async (to: string, data: string) => {
      const r = calls[to.toLowerCase() + data]
      if (r) return r
      throw new ExecutionError('execution reverted')
    },
  }
  return { rpc, storageReads, readsAt: (a: string) => storageReads.filter(r => r.startsWith(a)).map(r => r.split(' ')[1]) }
}

const node = (w: WalkResult, a: string): WalkNode => w.nodes.find(n => n.address.toLowerCase() === a)!
const names = (id: WalkNode['code']) => (id?.status === 'matched' ? `${id.match.contracts[0].split(':').pop()} ${id.match.role}` : id?.status)

test('walker: proxies are followed through the slots their entries list; unknown code is probed', async () => {
  const c = chain()
  const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: registry(), source: 'nitro-contracts', outOfScope: [] })

  const rollup = node(w, ROLLUP)
  assert.equal(names(rollup.code), 'RollupProxy proxy')
  assert.deepEqual([rollup.implementation?.slot, names(rollup.implementation?.code)], [EIP1967, 'RollupAdminLogic logic'])
  assert.deepEqual([rollup.secondaryImplementation?.slot, names(rollup.secondaryImplementation?.code)], [SECONDARY, 'RollupUserLogic logic'])

  // A one-slot proxy: only its listed slot is read.
  const bridge = node(w, BRIDGE)
  assert.equal(names(bridge.implementation?.code), 'Bridge logic')
  assert.equal(bridge.secondaryImplementation, undefined)
  assert.deepEqual(c.readsAt(BRIDGE), [EIP1967])
  const tup = bridge.code?.status === 'matched' ? bridge.code.match : null
  assert.deepEqual([tup?.packages, tup?.implementationSlots, tup?.immutables], [{ [OZ_TUP]: '@openzeppelin/contracts@4.7.3' }, [EIP1967], {}])
  assert.ok(!(bridge.code && 'matches' in bridge.code), 'one match per piece of code, not a list')

  // A proxy admin and plain logic: no slots read, even though PLAIN has one set.
  assert.equal(names(node(w, ADMIN).code), 'ProxyAdmin proxy-admin')
  assert.deepEqual(c.readsAt(ADMIN), [])
  assert.equal(node(w, PLAIN).implementation, undefined)
  assert.deepEqual(c.readsAt(PLAIN), [])

  // Unknown code: both known slots probed, as before proxies were marked.
  const legacy = node(w, LEGACY)
  assert.equal(legacy.code?.status, 'unknown')
  assert.deepEqual([legacy.implementation?.slot, names(legacy.implementation?.code)], [EIP1967, 'Outbox logic'])
  assert.deepEqual([legacy.secondaryImplementation?.slot, names(legacy.secondaryImplementation?.code)], [SECONDARY, 'RollupUserLogic logic'])
  assert.deepEqual(c.readsAt(LEGACY), [EIP1967, SECONDARY])

  // The summary counts only logic: the v1.0.0 proxies and admin don't empty the intersection.
  assert.deepEqual(w.summary.tags, ['v2.0.0'])
  assert.deepEqual(w.summary.untaggedInScope, [])
  assert.equal(w.summary.matchedInScope, 9, 'proxies and the admin are still identified and counted')
  assert.equal(w.summary.unknownInScope, 1)
})

test('test-chain check: proxies must still match the commit; a slot the walk skipped is reported', async () => {
  const c = chain()
  const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: registry(), source: 'nitro-contracts', outOfScope: [] })
  // This commit's build has new proxy code, so the deployed v1.0.0 proxies and admin don't match it.
  const logicOnly = new Set([C.adminLogic, C.userLogic, C.bridgeLogic, C.legacyLogic, C.plain].map(fp))
  const problems = evaluate(w, logicOnly)
  for (const a of [ROLLUP, BRIDGE, ADMIN]) assert.ok(problems.some(p => p.includes(`lands on ${node(w, a).address} whose code doesn't match`)), `${a} flagged`)
  assert.ok(problems.some(p => p.includes(`${node(w, LEGACY).address} whose code doesn't match an entry from this commit's build (unknown)`)))
  assert.equal(problems.length, 4)

  // The guard against proxies missing from contractRoles: PLAIN's EIP-1967 slot wasn't read.
  const unread = await unreadSlots(w, c.rpc)
  assert.equal(unread.length, 1)
  assert.match(unread[0], new RegExp(`at ${node(w, PLAIN).address} holds .* in implementation slot ${EIP1967}, which its entry src/osp/OneStepProofEntry.sol:OneStepProofEntry \\(logic\\) doesn't list`))

  // A proxy whose entry lists too few slots: the walk misses the secondary, and the guard says so.
  const c2 = chain()
  const w2 = await walk({ start: ROLLUP, rpc: c2.rpc as unknown as Rpc, registry: registry({ rollupProxy: { implementationSlots: [EIP1967] } }), source: 'nitro-contracts', outOfScope: [] })
  assert.equal(node(w2, ROLLUP).secondaryImplementation, undefined)
  assert.ok((await unreadSlots(w2, c2.rpc)).some(p => p.includes(`at ${node(w2, ROLLUP).address} holds ${word(USER_LOGIC)} in implementation slot ${SECONDARY}`)))
})

test('walker: an entry listing more slots than it can report fails the walk', async () => {
  const c = chain()
  const reg = registry({ proxy: { implementationSlots: [EIP1967, SECONDARY, `0x${'ab'.repeat(32)}`] } })
  await assert.rejects(walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: reg, source: 'nitro-contracts', outOfScope: [] }), /lists 3 implementation slots; this walker reads at most two/)
})

test("walker: unknown code is probed with the walk's own source's getters; a match reports its entry's repo", async () => {
  // The other source's entry has a getter nitro-contracts' entries don't, which the unknown proxy at LEGACY answers.
  const FOREIGN = addr(0x20)
  const reg = registry({}, [other()])
  const run = (source: string) => {
    const c = chain()
    const call = c.rpc.call
    c.rpc.call = async (to: string, data: string) => (to.toLowerCase() + data === LEGACY + foreign.selector ? word(FOREIGN) : call(to, data))
    return walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: reg, source, outOfScope: [] })
  }

  const own = await run('nitro-contracts')
  assert.ok(!own.nodes.some(n => n.address.toLowerCase() === FOREIGN), "another source's getter isn't called")
  assert.deepEqual([own.source, own.repo], ['nitro-contracts', REPO])

  const theirs = await run('other')
  assert.deepEqual(node(theirs, FOREIGN).edges.map(e => e.getter), ['foreign()'])
  assert.deepEqual([theirs.source, theirs.repo], ['other', OTHER])
  const rollup = node(theirs, ROLLUP).code
  assert.equal(rollup?.status === 'matched' && rollup.match.repo, REPO, "a match's repo is its entry's, not the walk's")

  await assert.rejects(run('missing'), /the registry has no source missing \(it has nitro-contracts, other\)/)
})

test("walker: the source defaults to the start's logic: its implementation's match, else its own code's", async () => {
  const PROXY_TO_F = addr(0x21), F_LOGIC = addr(0x22), NOTHING = addr(0x23)
  const run = (reg: Registry, start: string) => {
    const c = chain()
    const { getCode, getStorageAt } = c.rpc
    c.rpc.getCode = async (a: string) => ({ [PROXY_TO_F]: C.proxy, [F_LOGIC]: F, [NOTHING]: C.unknownProxy } as Record<string, Hex>)[a.toLowerCase()] ?? getCode(a)
    c.rpc.getStorageAt = async (a: string, slot: string) => (a.toLowerCase() === PROXY_TO_F && slot === EIP1967 ? word(F_LOGIC) : getStorageAt(a, slot))
    return walk({ start, rpc: c.rpc as unknown as Rpc, registry: reg, outOfScope: [] })
  }
  const two = registry({}, [other()])
  assert.equal((await run(two, ROLLUP)).source, 'nitro-contracts', 'a known proxy with nitro-contracts logic')
  assert.equal((await run(two, PLAIN)).source, 'nitro-contracts', 'logic: its own code')
  assert.equal((await run(two, LEGACY)).source, 'nitro-contracts', 'unknown code: the implementation at its EIP-1967 slot')
  const w = await run(two, PROXY_TO_F)
  assert.deepEqual([w.source, w.repo], ['other', OTHER], "a nitro-contracts proxy in front of the other source's logic belongs to the other source")
  assert.deepEqual(w.summary.tags, ['v7.0.0'])
  await assert.rejects(run(two, NOTHING), /can't tell which source the walk belongs to: nothing at 0x0{38}23, its code or an implementation behind it, matches an entry; pass the source \(one of nitro-contracts, other\)/)
  await assert.rejects(run(two, addr(0x24)), /0x0{38}24 has no code; pass the source/)
  assert.equal((await run(registry(), NOTHING)).source, 'nitro-contracts', 'nothing matches, but the registry has only one source')
})

test("walker: the out-of-scope list defaults to the source's list in the registry", async () => {
  const list = JSON.stringify({ schemaVersion: 1, repo: REPO, getters: { 'legacy()': 'test' } })
  const w = await walk({ start: ROLLUP, rpc: chain().rpc as unknown as Rpc, registry: registry({}, [], { 'config/nitro-contracts/out-of-scope-getters.json': list }) })
  assert.deepEqual([w.source, w.outOfScope, node(w, LEGACY).inScope], ['nitro-contracts', ['legacy()'], false])
  await assert.rejects(walk({ start: ROLLUP, rpc: chain().rpc as unknown as Rpc, registry: registry() }), /no out-of-scope list for nitro-contracts \(config\/nitro-contracts\/out-of-scope-getters\.json\); pass one/)
})

test('walker: out-of-scope leaves are identified, implementations included, but never expanded', async () => {
  const c = chain()
  const called: string[] = []
  const call = c.rpc.call
  c.rpc.call = async (to: string, data: string) => { called.push(to.toLowerCase()); return call(to, data) }
  const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: registry(), source: 'nitro-contracts', outOfScope: ['bridge()'] })

  // BRIDGE, a known proxy, is a leaf: its code and implementation are identified.
  const bridge = node(w, BRIDGE)
  assert.deepEqual([bridge.inScope, bridge.name, bridge.labels], [false, 'Bridge', ['RollupProxy.bridge()']])
  assert.deepEqual([names(bridge.code), bridge.implementation?.slot, names(bridge.implementation?.code)], [`${OZ_TUP.split(':').pop()} proxy`, EIP1967, 'Bridge logic'])
  const impl = bridge.implementation?.code
  assert.equal(impl?.status === 'matched' && impl.match.version, 'v2.0.0', 'each match carries its own version')
  // ... and not expanded: no getter called on it, so nothing behind it is reached.
  assert.ok(!called.includes(BRIDGE))
  assert.deepEqual(w.nodes.map(n => n.address.toLowerCase()), [ROLLUP, BRIDGE])
  assert.deepEqual(w.summary, { tags: ['v2.0.0'], matchedInScope: 3, unknownInScope: 0, untaggedInScope: [], otherRepoInScope: [] }, 'leaves are not counted')

  // An unknown leaf behind a proxy is probed like any unknown code, but gets no closest entry.
  const w2 = await walk({ start: ROLLUP, rpc: chain().rpc as unknown as Rpc, registry: registry(), source: 'nitro-contracts', outOfScope: ['legacy()'] })
  const legacy = node(w2, LEGACY)
  assert.deepEqual([legacy.inScope, names(legacy.code), names(legacy.implementation?.code), names(legacy.secondaryImplementation?.code)], [false, 'unknown', 'Outbox logic', 'RollupUserLogic logic'])
  assert.deepEqual(legacy.code?.status === 'unknown' && [legacy.code.closest, legacy.code.answeredGetters], [null, []])
  assert.ok(!w2.warnings.some(x => x.kind === 'unknown-code'), 'unknown code on a leaf is not a warning')
})

test("walker: the summary intersects the walk's own repo's logic; other repos' code is listed apart", async () => {
  const FOREIGN = addr(0x20)
  const c = chain()
  const call = c.rpc.call
  c.rpc.call = async (to: string, data: string) => (to.toLowerCase() + data === PLAIN + foreign.selector ? word(FOREIGN) : call(to, data))
  const getCode = c.rpc.getCode
  c.rpc.getCode = async (a: string) => (a.toLowerCase() === FOREIGN ? F : getCode(a))
  const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: registry({ plain: { getters: [foreign] } }, [other()]), source: 'nitro-contracts', outOfScope: [] })
  const f = node(w, FOREIGN)
  assert.equal(f.inScope && f.code?.status === 'matched' && f.code.match.repo, OTHER)
  assert.deepEqual(w.summary.tags, ['v2.0.0'], "the other repo's v7.0.0 logic doesn't empty the intersection")
  assert.deepEqual(w.summary.otherRepoInScope, [{ address: f.address, repo: OTHER, version: 'v7.0.0' }])
  assert.equal(w.summary.matchedInScope, 10, 'still counted as matched')
})

test('walker: warnings and their via lists come out in one order, whatever the RPC timing', async () => {
  // ADMIN, LEGACY and PLAIN are expanded concurrently. Getters that revert give getter-reverted
  // warnings on ROLLUP and LEGACY (both through RollupUserLogic), LEGACY (Outbox) and PLAIN;
  // LEGACY and PLAIN both reach SHARED, whose unknown code gives an unknown-code warning.
  const SHARED = addr(0x30)
  const shared = getter('shared()')
  const reg = registry({
    userLogic: { getters: [getter('b()'), getter('a()')] },
    legacyLogic: { getters: [getter('c()'), shared] },
    plain: { getters: [shared, getter('d()')] },
  })
  const run = async (slow: string | null) => {
    // Everything about the slow address answers late, so the other node finishes first.
    const c = chain()
    const late = (a: string) => new Promise(r => setTimeout(r, a.toLowerCase() === slow ? 15 : Math.random() * 3))
    const { call, getCode, getStorageAt } = c.rpc
    c.rpc.call = async (to: string, data: string) => { await late(to); return [LEGACY, PLAIN].includes(to.toLowerCase()) && data === shared.selector ? word(SHARED) : call(to, data) }
    c.rpc.getCode = async (a: string) => { await late(a); return a.toLowerCase() === SHARED ? C.unknownProxy : getCode(a) }
    c.rpc.getStorageAt = async (a: string, slot: string) => { await late(a); return getStorageAt(a, slot) }
    const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: reg, source: 'nitro-contracts', outOfScope: [] })
    return JSON.stringify({ ...w, stats: null })
  }
  const runs = [await run(LEGACY), await run(PLAIN), await run(null), await run(null)]
  assert.equal(new Set(runs).size, 1, 'every run gives the same output')
  const w = JSON.parse(runs[0]) as WalkResult
  const at = (a: string) => node(w, a).address
  assert.deepEqual(w.warnings.map(x => [x.kind, 'address' in x ? x.address : x.getter, 'getter' in x ? x.getter : 'role' in x ? x.role : '']), [
    ['unknown-code', at(LEGACY), 'code'], ['unknown-code', at(SHARED), 'code'],
    ['getter-reverted', at(ROLLUP), 'a()'], ['getter-reverted', at(ROLLUP), 'b()'],
    ['getter-reverted', at(LEGACY), 'a()'], ['getter-reverted', at(LEGACY), 'b()'], ['getter-reverted', at(LEGACY), 'c()'],
    ['getter-reverted', at(PLAIN), 'd()'],
  ], 'by kind, then in node order (depth, then address)')
  const via = w.warnings[1].kind === 'unknown-code' ? w.warnings[1].via : []
  assert.deepEqual(via.map(e => [e.from, e.getter]), [[at(LEGACY), 'shared()'], [at(PLAIN), 'shared()']])
})

// --- Beacon proxies, and per-contract out-of-scope keys ----------------------------------------

const TB = 'OffchainLabs/token-bridge-contracts', OZ = 'Example/oz'
const tbCode = (n: number): Hex => `0x60016003${n.toString(16).padStart(2, '0')}` // distinct from code(n), same length
const T = { beaconProxy: tbCode(1), beacon: tbCode(2), token: tbCode(3), l2Gateway: tbCode(4), l1Gateway: tbCode(5), weth: tbCode(6), unknown: tbCode(7) }
const GW = addr(0x40), TOKEN = addr(0x41), BCN = addr(0x42), TOKEN_LOGIC = addr(0x43), CLONE = addr(0x44), WETH = addr(0x45)
const L1GW = addr(0x46), L1GW_LOGIC = addr(0x47), U = addr(0x48), FAR = addr(0x49), FAR2 = addr(0x4a), BROKEN = addr(0x4b), BAD_BCN = addr(0x4c)

/**
 * A token bridge: an L2WethGateway (GW) whose getters reach a beacon proxy (TOKEN, OZ's
 * BeaconProxy, owned by a second source), unknown code whose beacon slot is set (CLONE), the beacon
 * (BCN), aeWETH, an unknown proxy in front of an L1WethGateway (L1GW, whose l2Weth() is an address
 * on another chain), unknown code (U) that answers l2Weth(), and a beacon proxy whose beacon's
 * implementation() reverts (BROKEN).
 */
function tokenBridge() {
  const tbEntry = (c: Hex, contract: string, extra: Partial<Entry> = {}) => entry(c, contract, { repo: TB, ...extra })
  const entries = [
    tbEntry(T.l2Gateway, 'contracts/tokenbridge/arbitrum/gateway/L2WethGateway.sol:L2WethGateway', { getters: ['token()', 'clone()', 'beacon()', 'l2Weth()', 'l1Gateway()', 'unknown()', 'broken()'].map(getter) }),
    tbEntry(T.token, 'contracts/tokenbridge/arbitrum/StandardArbERC20.sol:StandardArbERC20', { getters: [getter('gateway()')] }),
    tbEntry(T.l1Gateway, 'contracts/tokenbridge/ethereum/gateway/L1WethGateway.sol:L1WethGateway', { getters: [getter('l2Weth()')] }),
    tbEntry(T.weth, 'contracts/tokenbridge/libraries/aeWETH.sol:aeWETH'),
    tbEntry(T.beacon, '@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon', { role: 'proxy-admin' }),
  ]
  const beaconProxy = entry(T.beaconProxy, '@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy', { repo: OZ, role: 'proxy', beaconSlot: BEACON })
  const tagOf = (repo: string, name: string, es: Entry[]): TagFile => ({ schemaVersion: 1, repo, tag: name, commit: '4'.repeat(40), prerelease: false, packageVersion: name.slice(1), contracts: Object.fromEntries(es.map(e => [e.contracts[0], e.fingerprint])) })
  const files = generateViews([
    { id: 'token-bridge-contracts', repo: TB, entries, tags: [tagOf(TB, 'v1.0.0', entries)] },
    { id: 'oz', repo: OZ, entries: [beaconProxy], tags: [tagOf(OZ, 'v4.0.0', [beaconProxy])] },
  ])
  const reg = new Registry({ describe: () => 'memory', read: async rel => files.get(rel) ?? null })

  const codes: Record<string, Hex> = {
    [GW]: T.l2Gateway, [TOKEN]: T.beaconProxy, [BCN]: T.beacon, [TOKEN_LOGIC]: T.token, [CLONE]: T.unknown, [WETH]: T.weth,
    [L1GW]: T.unknown, [L1GW_LOGIC]: T.l1Gateway, [U]: T.unknown, [BROKEN]: T.beaconProxy, [BAD_BCN]: T.beacon,
  }
  const storage: Record<string, Record<string, string>> = {
    [TOKEN]: { [BEACON]: word(BCN) },
    [CLONE]: { [BEACON]: word(BCN) },
    [L1GW]: { [EIP1967]: word(L1GW_LOGIC) },
    [BROKEN]: { [BEACON]: word(BAD_BCN) },
    // Logic with something in its beacon slot: the walker must not follow it.
    [WETH]: { [BEACON]: word(BCN) },
  }
  const sel = (s: string) => getter(s).selector
  const calls: Record<string, string> = {
    [GW + sel('token()')]: word(TOKEN), [GW + sel('clone()')]: word(CLONE), [GW + sel('beacon()')]: word(BCN), [GW + sel('l2Weth()')]: word(WETH),
    [GW + sel('l1Gateway()')]: word(L1GW), [GW + sel('unknown()')]: word(U), [GW + sel('broken()')]: word(BROKEN),
    [TOKEN + sel('gateway()')]: word(GW), [CLONE + sel('gateway()')]: word(GW),
    [BCN + sel('implementation()')]: word(TOKEN_LOGIC),
    [L1GW + sel('l2Weth()')]: word(FAR), [U + sel('l2Weth()')]: word(FAR2),
  }
  const storageReads: string[] = []
  const rpc = {
    requests: 0,
    chainId: async () => 42161,
    blockNumber: async () => 100n,
    getCode: async (a: string) => codes[a.toLowerCase()] ?? '0x',
    getStorageAt: async (a: string, slot: string) => { storageReads.push(`${a.toLowerCase()} ${slot}`); return storage[a.toLowerCase()]?.[slot] ?? ZERO_WORD },
    call: async (to: string, data: string) => {
      const r = calls[to.toLowerCase() + data]
      if (r) return r
      throw new ExecutionError('execution reverted')
    },
  }
  const run = (opts: { start?: string; source?: string | null; outOfScope?: string[] } = {}) =>
    walk({ start: opts.start ?? GW, rpc: rpc as unknown as Rpc, registry: reg, source: opts.source === null ? undefined : (opts.source ?? 'token-bridge-contracts'), outOfScope: opts.outOfScope ?? [] })
  return { reg, rpc, run, readsAt: (a: string) => storageReads.filter(r => r.startsWith(a)).map(r => r.split(' ')[1]) }
}

test("walker: a beacon proxy's implementation is its beacon's implementation(); unknown code is probed at the beacon slot", async () => {
  const tb = tokenBridge()
  const w = await tb.run()

  const token = node(w, TOKEN)
  assert.equal(names(token.code), 'BeaconProxy proxy')
  assert.equal(token.code?.status === 'matched' && token.code.match.beaconSlot, BEACON)
  assert.deepEqual(token.implementation && { ...token.implementation, code: names(token.implementation.code) }, {
    slot: BEACON, beacon: node(w, BCN).address, address: getAddress(TOKEN_LOGIC), code: 'StandardArbERC20 logic',
  })
  assert.deepEqual(Object.keys(token.implementation!), ['slot', 'beacon', 'address', 'code'])
  assert.equal(token.secondaryImplementation, undefined)
  assert.equal(token.name, 'StandardArbERC20')
  assert.deepEqual(tb.readsAt(TOKEN), [BEACON], 'only the slot its entry lists')
  // Getters come from both pieces: StandardArbERC20's gateway() was called on the proxy.
  assert.ok(node(w, GW).edges.some(e => e.from === token.address && e.getter === 'gateway()' && e.inScope))

  // Unknown code with a zero EIP-1967 slot: the beacon slot is probed and followed.
  const clone = node(w, CLONE)
  assert.equal(clone.code?.status, 'unknown')
  assert.deepEqual([clone.implementation?.slot, clone.implementation?.beacon, names(clone.implementation?.code)], [BEACON, node(w, BCN).address, 'StandardArbERC20 logic'])
  assert.deepEqual(tb.readsAt(CLONE), [EIP1967, BEACON])
  // Unknown code with a set EIP-1967 slot: as before, no beacon read.
  assert.deepEqual(tb.readsAt(L1GW), [EIP1967, SECONDARY])
  assert.equal(node(w, L1GW).implementation?.beacon, undefined)

  // The beacon is a proxy admin, and logic isn't probed: no slots read on either.
  assert.equal(names(node(w, BCN).code), 'UpgradeableBeacon proxy-admin')
  assert.deepEqual([tb.readsAt(BCN), tb.readsAt(WETH)], [[], []])
  assert.equal(node(w, WETH).implementation, undefined)

  // A beacon whose implementation() reverts: no implementation.
  const broken = node(w, BROKEN)
  assert.deepEqual([names(broken.code), broken.implementation, broken.name], ['BeaconProxy proxy', undefined, 'BeaconProxy'])

  // The proxy's own code is another source's; its logic is the walk's.
  assert.deepEqual(w.summary.tags, ['v1.0.0'])
  assert.deepEqual(w.summary.otherRepoInScope.map(o => [o.address, o.repo, o.version]), [[token.address, OZ, 'v4.0.0'], [broken.address, OZ, 'v4.0.0']])

  // The test-chain guard: the beacon slot is probed too; a slot the entry lists is not reported.
  const unread = await unreadSlots(w, tb.rpc)
  assert.equal(unread.length, 1, unread.join('\n'))
  assert.match(unread[0], new RegExp(`^aeWETH at ${node(w, WETH).address} holds ${word(BCN)} in beacon slot ${BEACON}, which its entry contracts/tokenbridge/libraries/aeWETH.sol:aeWETH \\(logic\\) doesn't list`))
})

test("walker: a beacon proxy belongs to the source of its beacon's implementation", async () => {
  const w = await tokenBridge().run({ start: TOKEN, source: null })
  assert.deepEqual([w.source, w.repo], ['token-bridge-contracts', TB], "the proxy's own code is the oz source's")
})

test('walker: Contract.getter() keys apply only on nodes with a matched piece of that contract; getter() keys everywhere', async () => {
  const tb = tokenBridge()
  const inScope = (w: WalkResult, a: string) => node(w, a).inScope
  const answered = (w: WalkResult, a: string) => { const c = node(w, a).code; return c?.status === 'unknown' ? c.answeredGetters : null }

  // L1WethGateway.l2Weth(): out of scope on L1GW, an unknown proxy whose implementation is an
  // L1WethGateway; still in scope on the L2WethGateway, and on unknown code (U), which only sees
  // signature keys.
  const w = await tb.run({ outOfScope: ['L1WethGateway.l2Weth()'] })
  assert.deepEqual([inScope(w, FAR), node(w, FAR).labels], [false, ['L1WethGateway.l2Weth()']])
  assert.deepEqual(node(w, FAR).edges.map(e => [e.from, e.getter, e.inScope]), [[node(w, L1GW).address, 'l2Weth()', false]])
  assert.deepEqual([inScope(w, WETH), inScope(w, FAR2)], [true, true])
  assert.deepEqual([answered(w, L1GW), answered(w, U)], [[], ['l2Weth()']], 'answered in-scope getters, on that node')
  assert.deepEqual(w.outOfScope, ['L1WethGateway.l2Weth()'])

  // l2Weth(): out of scope everywhere.
  const all = await tb.run({ outOfScope: ['l2Weth()'] })
  assert.deepEqual([inScope(all, WETH), inScope(all, FAR), inScope(all, FAR2)], [false, false, false])
  assert.deepEqual(node(all, FAR2).labels, [`unknown@${node(all, U).address}.l2Weth()`])

  // A key on the proxy's own code (BeaconProxy) applies to that proxy only; a key on its
  // implementation (StandardArbERC20) to every node in front of one, unknown code included.
  const byCode = await tb.run({ outOfScope: ['BeaconProxy.gateway()'] })
  assert.deepEqual(node(byCode, GW).edges.filter(e => e.getter === 'gateway()').map(e => [e.from, e.inScope]), [[node(byCode, TOKEN).address, false], [node(byCode, CLONE).address, true]])
  const byImpl = await tb.run({ outOfScope: ['StandardArbERC20.gateway()'] })
  assert.deepEqual(node(byImpl, GW).edges.filter(e => e.getter === 'gateway()').map(e => [e.from, e.inScope]), [[node(byImpl, TOKEN).address, false], [node(byImpl, CLONE).address, false]])
  assert.ok(node(byImpl, GW).inScope, 'still the start')
  // A name no piece has changes nothing.
  const none = await tb.run({ outOfScope: ['L2WethGateway.gateway()', 'aeWETH.l2Weth()'] })
  assert.ok([WETH, FAR, FAR2].every(a => inScope(none, a)))
})
