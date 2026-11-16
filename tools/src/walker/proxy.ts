import { ZERO_ADDRESS } from '../lib/hex.ts'
import type { ByLengthEntry, Hex } from '../lib/types.ts'
import type { Rpc } from './rpc.ts'

/**
 * Following a proxy to its implementations. This is the one place that decides which storage slots
 * are read for a piece of code; `Registry.getVersion` and the walker (in-scope nodes and leaves)
 * both use it.
 */

/**
 * Proxy entries list the slots to read. These two are probed only for code the registry doesn't
 * know (e.g. a chain deployed before the registry's start), so such walks still reach the logic
 * and `Registry.getVersion` can still report it.
 */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
/** AdminFallbackProxy (RollupProxy) secondary, user-logic implementation slot. */
export const SECONDARY_IMPLEMENTATION_SLOT = '0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d'

/** A proxy's first implementation is its `implementation`, the second (AdminFallbackProxy's user logic) its `secondaryImplementation`. */
export type ImplementationRole = 'implementation' | 'secondaryImplementation'
const ROLES: readonly ImplementationRole[] = ['implementation', 'secondaryImplementation']

/** An implementation address read from a proxy's storage. */
export interface ImplementationSlot { role: ImplementationRole; slot: Hex; address: string }

/**
 * The implementations behind the contract at `address`, whose own code matched `entry` (null:
 * code the registry doesn't know). Zero slots are left out.
 *   - A `proxy` entry: the slots it lists, in order.
 *   - Logic and proxy admins: none, and no storage is read.
 *   - Unknown code, in case it is a proxy the registry doesn't have: the EIP-1967 slot and, if that
 *     is set, the secondary slot.
 */
export async function readImplementations(rpc: Pick<Rpc, 'getStorageAt'>, address: string, entry: ByLengthEntry | null, block: string): Promise<ImplementationSlot[]> {
  const read = async (role: ImplementationRole, slot: Hex): Promise<ImplementationSlot | null> => {
    const a = slotAddress(await rpc.getStorageAt(address, slot, block))
    return a ? { role, slot, address: a } : null
  }
  const out: ImplementationSlot[] = []
  if (entry) {
    if (entry.role !== 'proxy') return out
    const slots = (entry.implementationSlots ?? []).map(s => s.toLowerCase() as Hex)
    if (slots.length > ROLES.length) throw new Error(`${address}: its entry lists ${slots.length} implementation slots; this walker reads at most two`)
    for (const [i, slot] of slots.entries()) {
      const r = await read(ROLES[i], slot)
      if (r) out.push(r)
    }
    return out
  }
  const impl = await read('implementation', EIP1967_IMPLEMENTATION_SLOT)
  if (!impl) return out
  const secondary = await read('secondaryImplementation', SECONDARY_IMPLEMENTATION_SLOT)
  return secondary ? [impl, secondary] : [impl]
}

/**
 * Whether `getVersion` reports the code's implementation rather than the code itself: true for a
 * proxy with one implementation slot, and for unknown code (which may be a proxy). Logic, proxy
 * admins and two-slot proxies report themselves.
 */
export function reportsImplementation(entry: ByLengthEntry | null): boolean {
  return entry === null || (entry.role === 'proxy' && entry.implementationSlots?.length === 1)
}

/** The address in a storage word, or null if the word is zero or not an address. */
export function slotAddress(word: string): string | null {
  const h = word.replace(/^0x/, '').padStart(64, '0')
  if (!/^0{24}/.test(h)) return null
  const a = '0x' + h.slice(24)
  return a === ZERO_ADDRESS ? null : a
}
