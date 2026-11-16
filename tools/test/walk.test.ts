import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toFunctionSelector } from 'viem'
import { generateViews, type SourceInputs } from '../src/lib/datarepo.ts'
import { evaluate, unreadSlots } from '../src/lib/testcheck.ts'
import type { Entry, Hex, TagFile } from '../src/lib/types.ts'
import { Registry } from '../src/walker/registry.ts'
import { ExecutionError, type Rpc } from '../src/walker/rpc.ts'
import { EIP1967_IMPLEMENTATION_SLOT as EIP1967, SECONDARY_IMPLEMENTATION_SLOT as SECONDARY, walk, type WalkNode, type WalkResult } from '../src/walker/walk.ts'

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
