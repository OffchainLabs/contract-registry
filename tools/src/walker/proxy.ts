import type { Entry, Hex } from '../lib/types.ts'
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT, beaconImplementation, slotAddress } from './get-version.ts'
import type { Rpc } from './rpc.ts'

/**
 * Following a proxy to its implementations, for the walker: the slots and beacon calls it reads
 * for each piece of code (in-scope nodes and leaves). A walk reads the slots a proxy's entry lists,
 * and probes the standard slots for code the registry doesn't know (e.g. a chain deployed before
 * the registry's start), so it still reaches the logic. The slots, and reading an address from a
 * slot or a beacon, come from `get-version.ts`.
 */

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
    const impl = await beaconImplementation(rpc, beacon, block)
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
