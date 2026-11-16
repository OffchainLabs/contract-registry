import { ZERO_ADDRESS } from '../lib/hex.ts'
import type { Entry, Hex } from '../lib/types.ts'
import { ExecutionError, type Rpc } from './rpc.ts'

/**
 * Following a proxy to its implementations. This is the one place that decides which storage slots
 * are read for a piece of code, and when a beacon is asked for its implementation;
 * `Registry.getVersion` and the walker (in-scope nodes and leaves) both use it.
 */

/**
 * Proxy entries list the slots to read. These three are probed only for code the registry doesn't
 * know (e.g. a chain deployed before the registry's start), so such walks still reach the logic
 * and `Registry.getVersion` can still report it.
 */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
/** AdminFallbackProxy (RollupProxy) secondary, user-logic implementation slot. */
export const SECONDARY_IMPLEMENTATION_SLOT = '0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d'
/** EIP-1967's beacon slot, where OpenZeppelin's `BeaconProxy` keeps its beacon's address. */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

/** `implementation()`, which a beacon answers with the address of the logic its proxies run. */
const IMPLEMENTATION_SELECTOR = '0x5c60da1b'

/** A proxy's first implementation is its `implementation`, the second (AdminFallbackProxy's user logic) its `secondaryImplementation`. */
export type ImplementationRole = 'implementation' | 'secondaryImplementation'
const ROLES: readonly ImplementationRole[] = ['implementation', 'secondaryImplementation']

/** An implementation address read from a proxy's storage, or from its beacon. */
export interface ImplementationSlot {
  role: ImplementationRole
  /** The slot read: an implementation slot, or for a beacon proxy its beacon slot. */
  slot: Hex
  /** Beacon proxies: the beacon's address, read from `slot`. Its `implementation()` gave `address`. */
  beacon?: string
  address: string
}

/** The fields of an entry that say whether and how to follow it. */
export type ProxyFields = Pick<Entry, 'role' | 'implementationSlots' | 'beaconSlot'>

/**
 * The implementations behind the contract at `address`, whose own code matched `entry` (null:
 * code the registry doesn't know). Zero slots are left out, as is a beacon whose
 * `implementation()` reverts or returns no address.
 *   - A `proxy` entry with `implementationSlots`: those slots, in order.
 *   - A `proxy` entry with a `beaconSlot`: the beacon in that slot, and its `implementation()`.
 *   - Logic and proxy admins: none, and no storage is read.
 *   - Unknown code, in case it is a proxy the registry doesn't have: the EIP-1967 and secondary
 *     slots; if both are zero, the beacon slot and its beacon's implementation. So a set secondary
 *     slot (a two-slot proxy, which `getVersion` gives null) wins over the beacon slot, whatever
 *     the EIP-1967 slot holds.
 */
export async function readImplementations(rpc: Pick<Rpc, 'getStorageAt' | 'call'>, address: string, entry: ProxyFields | null, block: string): Promise<ImplementationSlot[]> {
  const read = async (role: ImplementationRole, slot: Hex): Promise<ImplementationSlot | null> => {
    const a = slotAddress(await rpc.getStorageAt(address, slot, block))
    return a ? { role, slot, address: a } : null
  }
  const viaBeacon = async (slot: Hex): Promise<ImplementationSlot[]> => {
    const beacon = slotAddress(await rpc.getStorageAt(address, slot, block))
    const impl = beacon && await beaconImplementation(rpc, beacon, block)
    return impl ? [{ role: 'implementation', slot, beacon: beacon!, address: impl }] : []
  }
  const out: ImplementationSlot[] = []
  if (entry) {
    if (entry.role !== 'proxy') return out
    if (entry.beaconSlot !== undefined) {
      if (entry.implementationSlots !== undefined) throw new Error(`${address}: its entry lists both implementation slots and a beacon slot; a proxy has one or the other`)
      return viaBeacon(entry.beaconSlot.toLowerCase() as Hex)
    }
    const slots = (entry.implementationSlots ?? []).map(s => s.toLowerCase() as Hex)
    if (slots.length > ROLES.length) throw new Error(`${address}: its entry lists ${slots.length} implementation slots; this walker reads at most two`)
    for (const [i, slot] of slots.entries()) {
      const r = await read(ROLES[i], slot)
      if (r) out.push(r)
    }
    return out
  }
  // Unknown code: a two-slot proxy if its secondary slot is set, else a one-slot proxy if its
  // EIP-1967 slot is, else maybe a beacon proxy. The beacon slot is read only if both are zero.
  const impl = await read('implementation', EIP1967_IMPLEMENTATION_SLOT)
  const secondary = await read('secondaryImplementation', SECONDARY_IMPLEMENTATION_SLOT)
  if (impl || secondary) return [impl, secondary].filter(i => i !== null)
  return viaBeacon(EIP1967_BEACON_SLOT)
}

/**
 * Whether `getVersion` reports the code's implementation rather than the code itself: true for a
 * proxy with one implementation slot, for a beacon proxy, and for unknown code (which may be a
 * proxy). Logic, proxy admins and two-slot proxies report themselves.
 */
export function reportsImplementation(entry: ProxyFields | null): boolean {
  return entry === null || (entry.role === 'proxy' && (entry.beaconSlot !== undefined || entry.implementationSlots?.length === 1))
}

/**
 * The address a beacon's `implementation()` returns, or null if the call reverts or returns no
 * address (the zero address, too short, or not an address). An RPC failure throws.
 */
async function beaconImplementation(rpc: Pick<Rpc, 'call'>, beacon: string, block: string): Promise<string | null> {
  let ret: string
  try {
    ret = await rpc.call(beacon, IMPLEMENTATION_SELECTOR, block)
  } catch (e) {
    if (e instanceof ExecutionError) return null
    throw e
  }
  const h = ret.replace(/^0x/, '')
  return h.length < 64 ? null : slotAddress('0x' + h.slice(0, 64))
}

/** The address in a storage word, or null if the word is zero or not an address. */
export function slotAddress(word: string): string | null {
  const h = word.replace(/^0x/, '').padStart(64, '0')
  if (!/^0{24}/.test(h)) return null
  const a = '0x' + h.slice(24)
  return a === ZERO_ADDRESS ? null : a
}
