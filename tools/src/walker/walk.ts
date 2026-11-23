import { getAddress, keccak256 } from 'viem'
import { hexToBytes, ZERO_ADDRESS } from '../lib/hex.ts'
import { decodeImmutables, type ImmutableValue } from '../lib/fingerprint.ts'
import { outOfScopePath } from '../lib/layout.ts'
import type { ByLengthEntry, ContractRole, Getter, Hex } from '../lib/types.ts'
import { readImplementations, type ImplementationRole } from './proxy.ts'
import type { Registry } from './registry.ts'
import { ExecutionError, Rpc } from './rpc.ts'
import { codeSelectors } from './selectors.ts'

export interface WalkOptions {
  start: string
  rpc: Rpc
  registry: Registry
  /**
   * The source the walk belongs to, by id (e.g. `nitro-contracts`): unknown code is probed with
   * that source's getters from the registry's index, and the summary intersects that source's
   * logic. Default: the source of the start contract's logic, which is the first piece that
   * matches an entry of: its implementation, its secondary implementation, its own code. If none
   * does, and the registry has one source, that one; otherwise the walk throws, asking for it.
   */
  source?: string
  /**
   * Getters whose targets are labelled leaves, never expanded. Default: the source's list in the
   * registry. A key is a signature (`owner()`), out of scope on every contract, or
   * `<ContractName>.<signature>` (`L1WethGateway.l2Weth()`), out of scope only on nodes where a
   * matched piece (the code, or an implementation) has a contract of that name. Unknown code only
   * sees the first kind.
   */
  outOfScope?: Iterable<string>
  /** Max items read from a `list` getter. */
  listCap?: number
  /** Block to read at; defaults to the latest block when the walk starts. */
  blockNumber?: bigint
  log?: (s: string) => void
}

export interface MatchedEntry {
  /** The matched entry's repo (`owner/repo`). */
  repo: string
  contracts: string[]
  /** Contracts compiled from a dependency package: fully qualified name -> `<package>@<version>`. */
  packages?: Record<string, string>
  role: ContractRole
  /** Proxies: the slots read for the node's `implementation` and `secondaryImplementation`. */
  implementationSlots?: Hex[]
  /** Beacon proxies: the slot holding the beacon, whose `implementation()` is the node's `implementation`. */
  beaconSlot?: Hex
  fingerprint: Hex
  /** This code's own version (its entry's `version`), of `repo`. */
  version: string
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
  repo: string
  contracts: string[]
  tags: string[]
  ref: string | null
  commit: string | null
  sharedSelectors: number
  entrySelectors: number
  /** Shared selectors over the union of the entry's and the code's known selectors. */
  score: number
}

/**
 * What a piece of code is. `matched` names the one entry it matches (the registry guarantees at
 * most one). `closest` and `answeredGetters` are only filled in on in-scope nodes.
 */
export type CodeId =
  | { status: 'matched'; codeLength: number; match: MatchedEntry }
  | { status: 'unknown'; codeLength: number; codeHash: Hex; answeredGetters: string[]; closest: ClosestEntry | null }
  | { status: 'no-code' }

export interface Edge { from: string; getter: string; index: number | null; inScope: boolean }

export interface WalkNode {
  address: string
  name: string
  kind: 'account' | 'contract'
  /**
   * True for the start node and every node reached through an in-scope edge: these are expanded
   * (their getters called). Other contracts are leaves: identified like any node, code and
   * implementations, but never expanded.
   */
  inScope: boolean
  depth: number
  edges: Edge[]
  /** Out-of-scope leaves: the edges that reached them, e.g. `RollupProxy.stakeToken()`. */
  labels: string[]
  code?: CodeId
  /**
   * For a proxy: the address in its first implementation slot and that code's identity. Read from
   * the slots its entry lists, or, for unknown code, probed at the EIP-1967 slot. For a beacon
   * proxy: what its beacon's `implementation()` returns, the beacon read from the slot its entry
   * lists or, for unknown code whose EIP-1967 slot is zero, from the beacon slot.
   */
  implementation?: Implementation
  /** The address in the second slot (AdminFallbackProxy's user-logic implementation). */
  secondaryImplementation?: Implementation
  /** Getters that returned the zero address. */
  unset: { getter: string; index: number | null; inScope: boolean }[]
}

/**
 * The code behind a proxy. `slot` is the slot read: an implementation slot, or for a beacon proxy
 * the beacon slot, whose `beacon` gave `address` from its `implementation()`.
 */
export interface Implementation { slot: Hex; beacon?: string; address: string; code: CodeId }

export type Warning =
  | { kind: 'unknown-code'; address: string; role: 'code' | ImplementationRole; via: Edge[] }
  | { kind: 'no-implementation-code'; address: string; implementation: string }
  | { kind: 'getter-reverted'; address: string; getter: string; index: number | null; entry: Hex }
  | { kind: 'conflicting-getter'; getter: string; values: { value: string; nodes: string[] }[] }

/** In-scope code matched to an entry of another repo than the walk's. */
export interface OtherRepoCode { address: string; repo: string; version: string }

export interface WalkSummary {
  /**
   * Intersection of the tag sets of all matched in-scope logic code of the walk's repo: the
   * releases the deployment is consistent with. Proxies and proxy admins are left out (they are
   * still identified in the nodes): upgrades replace implementations, never proxies, so after an
   * upgrade to a release that changed proxy code they would empty the intersection. So is code of
   * other repos, whose tags are another repo's releases (see `otherRepoInScope`).
   */
  tags: string[]
  /** Matched in-scope code of every role and repo, proxies included. */
  matchedInScope: number
  unknownInScope: number
  /** Matched in-scope logic code of the walk's repo whose tag set is empty (unreleased builds); these empty the intersection. */
  untaggedInScope: string[]
  /** Matched in-scope code of any role from another repo, with its own version: listed here, never in `tags`. */
  otherRepoInScope: OtherRepoCode[]
}

export interface WalkResult {
  schemaVersion: 1
  /** The walk's source, by id, and its repo. */
  source: string
  repo: string
  registry: string
  chainId: number
  blockNumber: string
  start: string
  outOfScope: string[]
  /** By depth, then in-scope first, then by address. */
  nodes: WalkNode[]
  /** By kind (unknown code, implementations with no code, reverted getters, conflicting getters), then in node order. */
  warnings: Warning[]
  summary: WalkSummary
  stats: { rpcRequests: number; ms: number }
}

interface GetterToCall extends Getter { fromEntry: Hex | null }

/** One piece of a contract: its own code, or the code behind one of its implementation slots. */
interface Piece { role: 'code' | ImplementationRole; id: CodeId; entry: ByLengthEntry | null; code: Uint8Array }

/** Walks a chain's contracts from one starting address (spec §5.6). Read-only RPC calls only. */
export async function walk(opts: WalkOptions): Promise<WalkResult> {
  const t0 = Date.now()
  const { rpc, registry } = opts
  const listCap = opts.listCap ?? 64
  const log = opts.log ?? (() => {})
  const chainId = await rpc.chainId()
  const blockNumber = opts.blockNumber ?? (await rpc.blockNumber())
  const block = '0x' + blockNumber.toString(16)
  const index = registry.index

  const nodes = new Map<string, WalkNode>()
  const reverted: Extract<Warning, { kind: 'getter-reverted' }>[] = []
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
    return { id: { status: 'matched', codeLength: code.length, match: matchedEntry(e, code) }, entry: e }
  }

  // A contract's code and, for a proxy (or unknown code with a slot set), the code behind its
  // implementation slots. Done once per address, for in-scope nodes and leaves alike.
  const identified = new Map<string, Promise<Piece[]>>()
  const identifyContract = (node: WalkNode, code: Uint8Array): Promise<Piece[]> => {
    let p = identified.get(node.address)
    if (!p) {
      p = (async () => {
        const own = await identify(code)
        node.code = own.id
        const pieces: Piece[] = [{ role: 'code', ...own, code }]
        for (const impl of await readImplementations(rpc, node.address, own.entry, block)) {
          const implCode = await getCode(impl.address)
          const r = await identify(implCode)
          node[impl.role] = { slot: impl.slot, ...(impl.beacon ? { beacon: checksum(impl.beacon) } : {}), address: checksum(impl.address), code: r.id }
          pieces.push({ role: impl.role, ...r, code: implCode })
        }
        return pieces
      })()
      identified.set(node.address, p)
    }
    return p
  }

  const start = nodeFor(opts.start, 0)
  start.inScope = true

  // The walk's source: given, or that of the start's logic (its implementations first, then its own code).
  let source = opts.source
  if (source === undefined) {
    const startCode = await getCode(start.address)
    const pieces = startCode.length ? await identifyContract(start, startCode) : []
    const logic = [...pieces.slice(1), ...pieces.slice(0, 1)].find(p => p.entry)?.entry
    const ids = Object.keys(index.sources)
    if (logic) {
      source = ids.find(id => index.sources[id].repo === logic.repo)
      if (source === undefined) throw new Error(`the start's logic matches an entry of ${logic.repo}, which no source in the registry's index has`)
    } else if (ids.length === 1) {
      source = ids[0]
    } else {
      throw new Error(`can't tell which source the walk belongs to: ${startCode.length ? `nothing at ${start.address}, its code or an implementation behind it, matches an entry` : `${start.address} has no code`}; pass the source (one of ${ids.join(', ') || 'none'})`)
    }
    log(`source ${source}`)
  }
  const sourceIndex = index.sources[source]
  if (!sourceIndex) throw new Error(`the registry has no source ${source} (it has ${Object.keys(index.sources).join(', ') || 'none'})`)
  let outOfScopeList = opts.outOfScope
  if (outOfScopeList === undefined) {
    const getters = await registry.outOfScope(source)
    if (!getters) throw new Error(`the registry has no out-of-scope list for ${source} (${outOfScopePath(source)}); pass one`)
    outOfScopeList = Object.keys(getters)
  }
  const outOfScope = new Set(outOfScopeList)

  const visited = new Set<string>()
  const expanded = new Set<string>()
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
      const pieces = await identifyContract(node, code)
      if (!node.inScope) {
        // Out-of-scope leaf: identified, not expanded. No getters, and no closest entry (that
        // would fetch every shard).
        node.name = nodeName(node)
        return
      }
      if (expanded.has(node.address)) return
      expanded.add(node.address)
      log(`expand ${node.address}`)
      for (const p of pieces) if (p.id.status === 'unknown') p.id.closest = await closestEntry(registry, p.code)
      node.name = nodeName(node)

      // Getters to call: every getter of every matched piece, plus every getter the registry
      // knows for the walk's source if any piece is unknown (reverts from those are expected).
      const toCall = new Map<string, GetterToCall>()
      for (const { entry } of pieces) if (entry) for (const g of entry.getters) if (!toCall.has(g.signature)) toCall.set(g.signature, { ...g, fromEntry: entry.fingerprint })
      const unknownPieces = pieces.filter(p => p.id.status === 'unknown')
      if (unknownPieces.length) for (const g of sourceIndex.getters) if (!toCall.has(g.signature)) toCall.set(g.signature, { ...g, fromEntry: null })

      const isOutOfScope = scopeOf(outOfScope, pieces)
      const answered: string[] = []
      const results = await Promise.all([...toCall.values()].map(async g => ({ g, values: await callGetter(rpc, node.address, g, block, listCap) })))
      for (const { g, values } of results.sort((a, b) => a.g.signature.localeCompare(b.g.signature))) {
        const inScope = !isOutOfScope(g.signature)
        if (values.reverted && g.fromEntry) reverted.push({ kind: 'getter-reverted', address: node.address, getter: g.signature, index: values.revertedAt, entry: g.fromEntry })
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
        p.id.answeredGetters = answered.filter(s => !isOutOfScope(s))
      }
    }))
    frontier = [...new Map(next.map(n => [n.address, n])).values()]
  }

  // Everything below reads the sorted nodes, so the output doesn't depend on RPC timing.
  const sortedNodes = [...nodes.values()].sort((a, b) => a.depth - b.depth || (b.inScope ? 1 : 0) - (a.inScope ? 1 : 0) || a.address.localeCompare(b.address))
  for (const n of sortedNodes) {
    n.edges.sort((a, b) => a.from.localeCompare(b.from) || a.getter.localeCompare(b.getter) || (a.index ?? -1) - (b.index ?? -1))
    n.labels = [...new Set(n.labels)].sort()
    n.unset.sort((a, b) => a.getter.localeCompare(b.getter))
  }
  const pieceIds = (n: WalkNode) => [['code', n.address, n.code], ['implementation', n.implementation?.address, n.implementation?.code], ['secondaryImplementation', n.secondaryImplementation?.address, n.secondaryImplementation?.code]] as const

  // Warnings: unknown code behind in-scope edges, implementations with no code, reverted getters,
  // conflicting getters; each kind in node order.
  const unknownCode: Warning[] = [], noImplementationCode: Warning[] = []
  for (const n of sortedNodes) {
    if (!n.inScope) continue
    const via = n.edges.filter(e => e.inScope)
    for (const [role, where, id] of pieceIds(n)) {
      if (id?.status === 'unknown') unknownCode.push({ kind: 'unknown-code', address: n.address, role, via })
      if (id?.status === 'no-code' && role !== 'code') noImplementationCode.push({ kind: 'no-implementation-code', address: n.address, implementation: where! })
    }
  }
  const position = new Map(sortedNodes.map((n, i) => [n.address, i]))
  reverted.sort((a, b) => position.get(a.address)! - position.get(b.address)! || a.getter.localeCompare(b.getter) || (a.index ?? -1) - (b.index ?? -1))
  const conflicting: Warning[] = []
  for (const [getter, m] of [...zeroArgResults].sort(([a], [b]) => a.localeCompare(b))) {
    if (m.size > 1) conflicting.push({ kind: 'conflicting-getter', getter, values: [...m].map(([value, from]) => ({ value, nodes: [...from].sort() })).sort((a, b) => a.value.localeCompare(b.value)) })
  }

  // Deployment summary: intersection of the tag sets of all matched in-scope logic code of the walk's repo.
  let tags = null as Set<string> | null
  let matched = 0, unknown = 0
  const untagged: string[] = []
  const otherRepo: OtherRepoCode[] = []
  for (const n of sortedNodes) {
    if (!n.inScope) continue
    for (const [, where, id] of pieceIds(n)) {
      if (!id) continue
      if (id.status === 'unknown') unknown++
      if (id.status !== 'matched') continue
      matched++
      if (id.match.repo !== sourceIndex.repo) { otherRepo.push({ address: where!, repo: id.match.repo, version: id.match.version }); continue }
      if (id.match.role !== 'logic') continue // a proxy or proxy admin
      const t = new Set(id.match.tags)
      if (!t.size) untagged.push(where!)
      tags = tags === null ? t : new Set([...tags].filter(x => t.has(x)))
    }
  }

  return {
    schemaVersion: 1,
    source,
    repo: sourceIndex.repo,
    registry: registry.source.describe(),
    chainId,
    blockNumber: blockNumber.toString(),
    start: checksum(opts.start),
    outOfScope: [...outOfScope].sort(),
    nodes: sortedNodes,
    warnings: [...unknownCode, ...noImplementationCode, ...reverted, ...conflicting],
    summary: { tags: [...(tags ?? [])].sort(), matchedInScope: matched, unknownInScope: unknown, untaggedInScope: untagged, otherRepoInScope: otherRepo },
    stats: { rpcRequests: rpc.requests, ms: Date.now() - t0 },
  }
}

/**
 * Whether a getter is out of scope on a node: its signature is in the list (every contract), or
 * `<Name>.<signature>` is, where `Name` is a contract (its short name) of an entry one of the
 * node's pieces matches. Unknown pieces add no names, so unknown code only sees signatures.
 */
function scopeOf(outOfScope: Set<string>, pieces: Piece[]): (signature: string) => boolean {
  const names = new Set(pieces.flatMap(p => p.entry?.contracts.map(c => c.split(':').pop()!) ?? []))
  return signature => outOfScope.has(signature) || [...names].some(n => outOfScope.has(`${n}.${signature}`))
}

function matchedEntry(e: ByLengthEntry, code: Uint8Array): MatchedEntry {
  return {
    repo: e.repo, contracts: e.contracts, ...(e.packages ? { packages: e.packages } : {}),
    role: e.role, ...(e.implementationSlots ? { implementationSlots: e.implementationSlots } : {}), ...(e.beaconSlot ? { beaconSlot: e.beaconSlot } : {}),
    fingerprint: e.fingerprint, version: e.version, tags: e.tags, ref: e.ref, commit: e.commit,
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
    fingerprint: best.e.fingerprint, repo: best.e.repo, contracts: best.e.contracts, tags: best.e.tags, ref: best.e.ref, commit: best.e.commit,
    sharedSelectors: best.shared, entrySelectors: best.e.selectors.length, score: Math.round(best.score * 1000) / 1000,
  }
}

function checksum(a: string): string {
  return getAddress(a.toLowerCase())
}
