import { getAddress, keccak256 } from 'viem'
import { hexToBytes, ZERO_ADDRESS } from '../lib/hex.ts'
import { decodeImmutables, type ImmutableValue } from '../lib/fingerprint.ts'
import type { ByLengthEntry, ContractRole, Getter, Hex } from '../lib/types.ts'
import { ExecutionError, Rpc } from './rpc.ts'
import { codeSelectors } from './selectors.ts'
import type { Registry } from './registry.ts'

/**
 * Proxy entries list the slots to read. These two are probed only for code the registry doesn't
 * know (e.g. a chain deployed before the registry's start), so such walks still reach the logic.
 */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
/** AdminFallbackProxy (RollupProxy) secondary, user-logic implementation slot. */
export const SECONDARY_IMPLEMENTATION_SLOT = '0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d'

export interface WalkOptions {
  start: string
  rpc: Rpc
  registry: Registry
  /** `owner/repo` the registry directory belongs to, for output. */
  repo: string
  /** Getter signatures whose targets are labelled leaves, never expanded. */
  outOfScope: Iterable<string>
  /** Max items read from a `list` getter. */
  listCap?: number
  /** Block to read at; defaults to the latest block when the walk starts. */
  blockNumber?: bigint
  log?: (s: string) => void
}

export interface MatchedEntry {
  repo: string
  contracts: string[]
  /** Contracts compiled from a dependency package: fully qualified name -> `<package>@<version>`. */
  packages?: Record<string, string>
  role: ContractRole
  /** Proxies: the slots read for the node's `implementation` and `secondaryImplementation`. */
  implementationSlots?: Hex[]
  fingerprint: Hex
  tags: string[]
  /** The ref (tag or branch) and commit the entry was first built from; null on a manual entry. */
  ref: string | null
  commit: string | null
  label?: string
  /** The matched code's Solidity immutables by name (linked-library and library addresses left out). */
  immutables: Record<string, ImmutableValue>
}

export interface ClosestEntry {
  fingerprint: Hex
  contracts: string[]
  tags: string[]
  ref: string | null
  commit: string | null
  sharedSelectors: number
  entrySelectors: number
  /** Shared selectors over the union of the entry's and the code's known selectors. */
  score: number
}

/** What a piece of code is. `matched` names the one entry it matches (the registry guarantees at most one). */
export type CodeId =
  | { status: 'matched'; codeLength: number; match: MatchedEntry }
  | { status: 'unknown'; codeLength: number; codeHash: Hex; answeredGetters: string[]; closest: ClosestEntry | null }
  | { status: 'no-code' }
  | { status: 'not-identified'; codeLength: number; codeHash: Hex }

export interface Edge { from: string; getter: string; index: number | null; inScope: boolean }

export interface WalkNode {
  address: string
  name: string
  kind: 'account' | 'contract'
  /** True for the start node and every node reached through an in-scope edge (these are expanded). */
  inScope: boolean
  depth: number
  edges: Edge[]
  /** Out-of-scope leaves: the edges that reached them, e.g. `RollupProxy.stakeToken()`. */
  labels: string[]
  code?: CodeId
  /**
   * For a proxy: the address in its first implementation slot and that code's identity. Read from
   * the slots its entry lists, or, for unknown code, probed at the EIP-1967 slot.
   */
  implementation?: Implementation
  /** The address in the second slot (AdminFallbackProxy's user-logic implementation). */
  secondaryImplementation?: Implementation
  /** Getters that returned the zero address. */
  unset: { getter: string; index: number | null; inScope: boolean }[]
}

export interface Implementation { slot: Hex; address: string; code: CodeId }

export type Warning =
  | { kind: 'unknown-code'; address: string; role: 'code' | 'implementation' | 'secondaryImplementation'; via: Edge[] }
  | { kind: 'conflicting-getter'; getter: string; values: { value: string; nodes: string[] }[] }
  | { kind: 'getter-reverted'; address: string; getter: string; index: number | null; entry: Hex }
  | { kind: 'no-implementation-code'; address: string; implementation: string }

export interface WalkResult {
  schemaVersion: 1
  repo: string
  registry: string
  chainId: number
  blockNumber: string
  start: string
  outOfScope: string[]
  nodes: WalkNode[]
  warnings: Warning[]
  summary: {
    /**
     * Intersection of the tag sets of all matched in-scope logic code: the releases the deployment
     * is consistent with. Proxies and proxy admins are left out (they are still identified in the
     * nodes): upgrades replace implementations, never proxies, so after an upgrade to a release
     * that changed proxy code they would empty the intersection.
     */
    tags: string[]
    /** Matched in-scope code of every role, proxies included. */
    matchedInScope: number
    unknownInScope: number
    /** Matched in-scope logic code whose tag set is empty (unreleased builds); these empty the intersection. */
    untaggedInScope: string[]
  }
  stats: { rpcRequests: number; ms: number }
}

interface GetterToCall extends Getter { fromEntry: Hex | null }

/** Walks a chain's contracts from one starting address (spec §5.6). Read-only RPC calls only. */
export async function walk(opts: WalkOptions): Promise<WalkResult> {
  const t0 = Date.now()
  const { rpc, registry } = opts
  const listCap = opts.listCap ?? 64
  const outOfScope = new Set(opts.outOfScope)
  const log = opts.log ?? (() => {})
  const chainId = await rpc.chainId()
  const blockNumber = opts.blockNumber ?? (await rpc.blockNumber())
  const block = '0x' + blockNumber.toString(16)
  const index = await registry.index()

  const nodes = new Map<string, WalkNode>()
  const warnings: Warning[] = []
  const codeCache = new Map<string, Promise<Uint8Array>>()
  const getCode = (a: string) => {
    let p = codeCache.get(a)
    if (!p) { p = rpc.getCode(a, block).then(h => hexToBytes(h)); codeCache.set(a, p) }
    return p
  }
  const zeroArgResults = new Map<string, Map<string, Set<string>>>()

  const nodeFor = (address: string, depth: number): WalkNode => {
    const a = checksum(address)
    let n = nodes.get(a)
    if (!n) {
      n = { address: a, name: '', kind: 'contract', inScope: false, depth, edges: [], labels: [], unset: [] }
      nodes.set(a, n)
    }
    n.depth = Math.min(n.depth, depth)
    return n
  }

  const identify = async (code: Uint8Array): Promise<{ id: CodeId; entry: ByLengthEntry | null }> => {
    if (code.length === 0) return { id: { status: 'no-code' }, entry: null }
    const e = await registry.lookup(code)
    if (!e) return { id: { status: 'unknown', codeLength: code.length, codeHash: keccak256(code), answeredGetters: [], closest: null }, entry: null }
    return { id: { status: 'matched', codeLength: code.length, match: matchedEntry(opts.repo, e, code) }, entry: e }
  }

  const visited = new Set<string>()
  const expanded = new Set<string>()
  const start = nodeFor(opts.start, 0)
  start.inScope = true
  let frontier: WalkNode[] = [start]

  while (frontier.length) {
    const next: WalkNode[] = []
    await Promise.all(frontier.map(async node => {
      const code = await getCode(node.address)
      if (!visited.has(node.address)) {
        visited.add(node.address)
        if (code.length === 0) { node.kind = 'account'; return }
        node.kind = 'contract'
      }
      if (node.kind === 'account') return
      if (!node.inScope) {
        // Out-of-scope leaf: marked as a contract, not identified or expanded.
        node.code ??= { status: 'not-identified', codeLength: code.length, codeHash: keccak256(code) }
        return
      }
      if (expanded.has(node.address)) return
      expanded.add(node.address)
      log(`expand ${node.address}`)

      // Identify the code at the address, and the implementation(s) if it's a proxy.
      const own = await identify(code)
      node.code = own.id
      const pieces: { role: 'code' | 'implementation' | 'secondaryImplementation'; id: CodeId; entry: ByLengthEntry | null; code: Uint8Array }[] = [{ role: 'code', ...own, code }]
      const readImplementation = async (role: 'implementation' | 'secondaryImplementation', slot: Hex): Promise<boolean> => {
        const impl = slotAddress(await rpc.getStorageAt(node.address, slot, block))
        if (!impl) return false
        const implCode = await getCode(impl)
        const r = await identify(implCode)
        node[role] = { slot, address: checksum(impl), code: r.id }
        pieces.push({ role, ...r, code: implCode })
        if (!implCode.length) warnings.push({ kind: 'no-implementation-code', address: node.address, implementation: checksum(impl) })
        return true
      }
      if (own.entry) {
        // Known code: read exactly the slots a proxy entry lists (none for logic or a proxy admin).
        const slots = own.entry.role === 'proxy' ? (own.entry.implementationSlots ?? []).map(s => s.toLowerCase() as Hex) : []
        if (slots.length > 2) throw new Error(`${node.address}: its entry lists ${slots.length} implementation slots; this walker reads at most two`)
        if (slots[0]) await readImplementation('implementation', slots[0])
        if (slots[1]) await readImplementation('secondaryImplementation', slots[1])
      } else if (await readImplementation('implementation', EIP1967_IMPLEMENTATION_SLOT)) {
        // Unknown code: probe the known slots, in case it's a proxy the registry doesn't have.
        await readImplementation('secondaryImplementation', SECONDARY_IMPLEMENTATION_SLOT)
      }
      for (const p of pieces) if (p.id.status === 'unknown') p.id.closest = await closestEntry(registry, p.code)
      node.name = nodeName(node)

      // Getters to call: every getter of every matched piece, plus every getter the registry
      // knows for this repo if any piece is unknown (reverts from those are expected).
      const toCall = new Map<string, GetterToCall>()
      for (const { entry } of pieces) if (entry) for (const g of entry.getters) if (!toCall.has(g.signature)) toCall.set(g.signature, { ...g, fromEntry: entry.fingerprint })
      const unknownPieces = pieces.filter(p => p.id.status === 'unknown')
      if (unknownPieces.length) for (const g of index.getters) if (!toCall.has(g.signature)) toCall.set(g.signature, { ...g, fromEntry: null })

      const answered: string[] = []
      const results = await Promise.all([...toCall.values()].map(async g => ({ g, values: await callGetter(rpc, node.address, g, block, listCap) })))
      for (const { g, values } of results.sort((a, b) => a.g.signature.localeCompare(b.g.signature))) {
        const inScope = !outOfScope.has(g.signature)
        if (values.reverted && g.fromEntry) warnings.push({ kind: 'getter-reverted', address: node.address, getter: g.signature, index: values.revertedAt, entry: g.fromEntry })
        if (!values.reverted || values.items.length) answered.push(g.signature)
        for (const { index: i, value } of values.items) {
          if (value === null) { node.unset.push({ getter: g.signature, index: i, inScope }); continue }
          const target = nodeFor(value, node.depth + 1)
          target.edges.push({ from: node.address, getter: g.signature, index: i, inScope })
          if (inScope) {
            if (g.kind === 'single') {
              const m = zeroArgResults.get(g.signature) ?? new Map<string, Set<string>>()
              m.set(target.address, (m.get(target.address) ?? new Set()).add(node.address))
              zeroArgResults.set(g.signature, m)
            }
            if (!target.inScope) { target.inScope = true; next.push(target) }
          } else {
            target.labels.push(`${node.name}.${g.signature}${i === null ? '' : `[${i}]`}`)
            if (!visited.has(target.address)) next.push(target)
          }
        }
      }

      for (const p of unknownPieces) {
        if (p.id.status !== 'unknown') continue
        p.id.answeredGetters = answered.filter(s => !outOfScope.has(s))
      }
    }))
    frontier = [...new Map(next.map(n => [n.address, n])).values()]
  }

  // Unknown code behind in-scope edges.
  for (const n of nodes.values()) {
    if (!n.inScope) continue
    const via = n.edges.filter(e => e.inScope)
    if (n.code?.status === 'unknown') warnings.push({ kind: 'unknown-code', address: n.address, role: 'code', via })
    if (n.implementation?.code.status === 'unknown') warnings.push({ kind: 'unknown-code', address: n.address, role: 'implementation', via })
    if (n.secondaryImplementation?.code.status === 'unknown') warnings.push({ kind: 'unknown-code', address: n.address, role: 'secondaryImplementation', via })
  }
  for (const [getter, m] of [...zeroArgResults].sort()) {
    if (m.size > 1) warnings.push({ kind: 'conflicting-getter', getter, values: [...m].map(([value, from]) => ({ value, nodes: [...from].sort() })).sort((a, b) => a.value.localeCompare(b.value)) })
  }

  // Deployment summary: intersection of the tag sets of all matched in-scope logic code.
  let tags = null as Set<string> | null
  let matched = 0, unknown = 0
  const untagged: string[] = []
  for (const n of nodes.values()) {
    if (!n.inScope) continue
    for (const [where, id] of [[n.address, n.code], [n.implementation?.address, n.implementation?.code], [n.secondaryImplementation?.address, n.secondaryImplementation?.code]] as const) {
      if (!id) continue
      if (id.status === 'unknown') unknown++
      if (id.status !== 'matched') continue
      matched++
      if (id.match.role !== 'logic') continue // a proxy or proxy admin
      const t = new Set(id.match.tags)
      if (!t.size) untagged.push(where!)
      tags = tags === null ? t : new Set([...tags].filter(x => t.has(x)))
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => a.depth - b.depth || (b.inScope ? 1 : 0) - (a.inScope ? 1 : 0) || a.address.localeCompare(b.address))
  for (const n of sortedNodes) {
    n.edges.sort((a, b) => a.from.localeCompare(b.from) || a.getter.localeCompare(b.getter) || (a.index ?? -1) - (b.index ?? -1))
    n.labels = [...new Set(n.labels)].sort()
    n.unset.sort((a, b) => a.getter.localeCompare(b.getter))
  }
  return {
    schemaVersion: 1,
    repo: opts.repo,
    registry: registry.source.describe(),
    chainId,
    blockNumber: blockNumber.toString(),
    start: checksum(opts.start),
    outOfScope: [...outOfScope].sort(),
    nodes: sortedNodes,
    warnings,
    summary: { tags: [...(tags ?? [])].sort(), matchedInScope: matched, unknownInScope: unknown, untaggedInScope: untagged },
    stats: { rpcRequests: rpc.requests, ms: Date.now() - t0 },
  }
}

function matchedEntry(repo: string, e: ByLengthEntry, code: Uint8Array): MatchedEntry {
  return {
    repo, contracts: e.contracts, ...(e.packages ? { packages: e.packages } : {}),
    role: e.role, ...(e.implementationSlots ? { implementationSlots: e.implementationSlots } : {}),
    fingerprint: e.fingerprint, tags: e.tags, ref: e.ref, commit: e.commit,
    ...(e.label ? { label: e.label } : {}), immutables: decodeImmutables(code, e),
  }
}

/** The matched entry's contract name; when several contracts compile to its code, up to two of them. */
function shortName(id: CodeId | undefined): string | null {
  if (id?.status !== 'matched') return null
  const names = [...new Set(id.match.contracts.map(c => c.split(':').pop()!))]
  return names.length === 1 ? names[0] : names.slice(0, 2).join('|') + (names.length > 2 ? '|…' : '')
}

/** Readable node name: the implementation's contract for a one-implementation proxy, else the code's. */
function nodeName(n: WalkNode): string {
  const logic = n.implementation && !n.secondaryImplementation ? n.implementation.code : n.code
  const known = shortName(logic)
  if (known) return known
  // Unknown: hint with the closest entry of the code, else of an implementation.
  for (const id of [logic, n.implementation?.code, n.secondaryImplementation?.code]) {
    if (id?.status === 'unknown' && id.closest) return `unknown(~${id.closest.contracts[0].split(':').pop()})`
  }
  return `unknown@${n.address}`
}

function slotAddress(word: string): string | null {
  const h = word.replace(/^0x/, '').padStart(64, '0')
  if (!/^0{24}/.test(h)) return null
  const a = '0x' + h.slice(24)
  return a === ZERO_ADDRESS ? null : a
}

interface GetterValues { items: { index: number | null; value: string | null }[]; reverted: boolean; revertedAt: number | null }

async function callGetter(rpc: Rpc, address: string, g: Getter, block: string, cap: number): Promise<GetterValues> {
  const decode = (ret: string): string | null | undefined => {
    const h = ret.replace(/^0x/, '')
    if (h.length < 64 || !/^0{24}/.test(h)) return undefined // not an address
    const a = '0x' + h.slice(24, 64)
    return a === ZERO_ADDRESS ? null : a
  }
  if (g.kind === 'single') {
    try {
      const v = decode(await rpc.call(address, g.selector, block))
      return v === undefined ? { items: [], reverted: false, revertedAt: null } : { items: [{ index: null, value: v }], reverted: false, revertedAt: null }
    } catch (e) {
      if (e instanceof ExecutionError) return { items: [], reverted: true, revertedAt: null }
      throw e
    }
  }
  // list: call with 0, 1, ... until a revert or zero, up to the cap.
  const items: GetterValues['items'] = []
  for (let i = 0; i < cap; i++) {
    let v: string | null | undefined
    try {
      v = decode(await rpc.call(address, g.selector + i.toString(16).padStart(64, '0'), block))
    } catch (e) {
      if (e instanceof ExecutionError) return { items, reverted: i === 0, revertedAt: i === 0 ? 0 : null }
      throw e
    }
    if (v === undefined) break
    if (v === null) { if (i === 0) items.push({ index: 0, value: null }); break }
    items.push({ index: i, value: v })
  }
  return { items, reverted: false, revertedAt: null }
}

async function closestEntry(registry: Registry, code: Uint8Array): Promise<ClosestEntry | null> {
  if (!code.length) return null
  const all = await registry.all()
  const universe = new Set<string>(all.flatMap(e => e.selectors))
  const mine = [...codeSelectors(code)].filter(s => universe.has(s as Hex))
  if (!mine.length) return null
  const mineSet = new Set(mine)
  let best: { e: ByLengthEntry; shared: number; score: number } | null = null
  for (const e of all) {
    if (!e.selectors.length) continue
    const shared = e.selectors.filter(s => mineSet.has(s)).length
    if (!shared) continue
    const score = shared / new Set([...e.selectors, ...mine]).size
    // Ties (e.g. the provers all expose one selector) go to the entry closest in code length.
    const closer = best && Math.abs(e.codeLength - code.length) < Math.abs(best.e.codeLength - code.length)
    if (!best || score > best.score || (score === best.score && closer)) best = { e, shared, score }
  }
  if (!best) return null
  return {
    fingerprint: best.e.fingerprint, contracts: best.e.contracts, tags: best.e.tags, ref: best.e.ref, commit: best.e.commit,
    sharedSelectors: best.shared, entrySelectors: best.e.selectors.length, score: Math.round(best.score * 1000) / 1000,
  }
}

function checksum(a: string): string {
  return getAddress(a.toLowerCase())
}
