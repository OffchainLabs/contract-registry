import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toFunctionSelector } from 'viem'
import { generateViews } from '../src/lib/datarepo.ts'
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
    maskedRanges: [], cborMetadataLength: 0, getters: [], selectors: [], compiler: null, firstCommit: '1'.repeat(40), firstBranch: 'main', ...extra,
  }
}

function registry(overrides: Partial<Record<keyof typeof C, Partial<Entry>>> = {}): Registry {
  const entries = [
    entry(C.rollupProxy, 'src/rollup/RollupProxy.sol:RollupProxy', { role: 'proxy', implementationSlots: [EIP1967, SECONDARY], ...overrides.rollupProxy }),
    entry(C.proxy, OZ_TUP, { role: 'proxy', implementationSlots: [EIP1967], packages: { [OZ_TUP]: '@openzeppelin/contracts@4.7.3' }, ...overrides.proxy }),
    entry(C.admin, '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin', { role: 'proxy-admin', ...overrides.admin }),
    entry(C.adminLogic, 'src/rollup/RollupAdminLogic.sol:RollupAdminLogic', { getters: [getter('bridge()')] }),
    entry(C.userLogic, 'src/rollup/RollupUserLogic.sol:RollupUserLogic'),
    entry(C.bridgeLogic, 'src/bridge/Bridge.sol:Bridge', { getters: [getter('legacy()'), getter('plain()'), getter('proxyAdmin()')] }),
    entry(C.legacyLogic, 'src/bridge/Outbox.sol:Outbox'),
    entry(C.plain, 'src/osp/OneStepProofEntry.sol:OneStepProofEntry'),
  ]
  const tag = (name: string, fps: Hex[]): TagFile => ({ schemaVersion: 1, repo: REPO, tag: name, commit: '2'.repeat(40), prerelease: false, packageVersion: name.slice(1), contracts: Object.fromEntries(fps.map((f, i) => [`src/C${i}.sol:C${i}`, f])) })
  // v2.0.0 changed the proxies' code; the chain still runs the v1.0.0 proxies with v2.0.0 logic.
  const v1 = [C.rollupProxy, C.proxy, C.admin].map(fp)
  const v2 = [C.adminLogic, C.userLogic, C.bridgeLogic, C.legacyLogic, C.plain].map(fp).concat([keccak256('0x01'), keccak256('0x02')])
  const files = generateViews(REPO, 'nitro-contracts', entries, [tag('v1.0.0', v1), tag('v2.0.0', v2)])
  return new Registry({ describe: () => 'memory', read: async rel => files.get(rel) ?? null }, 'nitro-contracts')
}

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
  const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: registry(), repo: REPO, outOfScope: [] })

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
  const w = await walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: registry(), repo: REPO, outOfScope: [] })
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
  const w2 = await walk({ start: ROLLUP, rpc: c2.rpc as unknown as Rpc, registry: registry({ rollupProxy: { implementationSlots: [EIP1967] } }), repo: REPO, outOfScope: [] })
  assert.equal(node(w2, ROLLUP).secondaryImplementation, undefined)
  assert.ok((await unreadSlots(w2, c2.rpc)).some(p => p.includes(`at ${node(w2, ROLLUP).address} holds ${word(USER_LOGIC)} in implementation slot ${SECONDARY}`)))
})

test('walker: an entry listing more slots than it can report fails the walk', async () => {
  const c = chain()
  const reg = registry({ proxy: { implementationSlots: [EIP1967, SECONDARY, `0x${'ab'.repeat(32)}`] } })
  await assert.rejects(walk({ start: ROLLUP, rpc: c.rpc as unknown as Rpc, registry: reg, repo: REPO, outOfScope: [] }), /lists 3 implementation slots; this walker reads at most two/)
})
