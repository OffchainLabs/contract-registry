/**
 * getVersion and lookup: which release of an Offchain Labs contract repo the contract at an
 * address was built from, using the registry's static files and three read-only RPC methods.
 *
 * This is the reference implementation of the pseudocode in the README ("How `getVersion`
 * works"). It imports nothing from the rest of this repo, only viem, so you can copy this one
 * file into another project. You supply:
 *   - an RPC (`VersionRpc`): `getCode`, `getStorageAt` and `call`, read at one block;
 *   - a registry snapshot (`RegistryFiles`): its `registry/index.json`, parsed (check that its
 *     `schemaVersion` is 1), and a way to read its other files. Read every file from one commit.
 *
 *   const base = 'https://raw.githubusercontent.com/OffchainLabs/contract-registry/<commit>'
 *   const read = async (path: string) => {
 *     const res = await fetch(`${base}/${path}`)
 *     if (res.status === 404) return null
 *     if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
 *     return res.text()
 *   }
 *   const index = JSON.parse((await read('registry/index.json'))!)
 *   await getVersion(rpc, { index, read }, '0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0')
 *   // { version: 'v3.0.0', repo: 'OffchainLabs/nitro-contracts' }
 */
import { hexToBytes, keccak256, type Hex } from 'viem'

/** EIP-1967's implementation slot: the address of the logic a proxy forwards to. */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
/** AdminFallbackProxy's (RollupProxy's) second, user-logic implementation slot. */
export const SECONDARY_IMPLEMENTATION_SLOT = '0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d'
/** EIP-1967's beacon slot, where OpenZeppelin's `BeaconProxy` keeps its beacon's address. */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

/** `implementation()`, which a beacon answers with the address of the logic its proxies run. */
const IMPLEMENTATION_SELECTOR = '0x5c60da1b'

/** The RPC methods getVersion uses. `block` is a block number in hex, or a tag such as `latest`. */
export interface VersionRpc {
  /** eth_getCode: the code at `address`, as hex (`0x` if none). */
  getCode(address: string, block: string): Promise<string>
  /** eth_getStorageAt: the 32-byte word in storage slot `slot` of `address`, as hex. */
  getStorageAt(address: string, slot: string, block: string): Promise<string>
  /**
   * eth_call: what calling `to` with `data` returns, as hex. Only used to ask a beacon for its
   * `implementation()`. When the call reverts, it must throw an `ExecutionError`; any other error
   * (the RPC failing) is passed on, never taken for a revert.
   */
  call(to: string, data: string, block: string): Promise<string>
}

/** What `VersionRpc.call` throws when the call itself reverts, as opposed to the RPC failing. */
export class ExecutionError extends Error {}

/** One snapshot of the registry: every file read from the same commit. */
export interface RegistryFiles {
  /** `registry/index.json`, parsed: the code lengths that have a `registry/by-length/` file. */
  index: { codeLengths: number[] }
  /** The text of the file at `path`, such as `registry/by-length/5171.json`, or null if there is none. */
  read(path: string): Promise<string | null>
}

/** The fields of a `registry/by-length/` entry that lookup and getVersion use (it has more). */
export interface VersionEntry {
  fingerprint: string
  /** `[offset, length]` pairs: the bytes zeroed before hashing (immutables, CBOR metadata). */
  fingerprintMask: [offset: number, length: number][]
  version: string
  /** The source repo, `owner/repo`. Tag names overlap across repos, so a version alone is ambiguous. */
  repo: string
  /** A proxy with one implementation slot, or a beacon proxy: it reports its implementation's version. */
  isSingleImplementationProxy: boolean
}

/** What getVersion reports: an entry's `version`, and the repo it is a version of. */
export interface ContractVersion {
  version: string
  repo: string
}

/**
 * The version and repo of the code at `address`, or null. A single-implementation proxy reports
 * its implementation instead, and so does unknown code, which may be a proxy the registry doesn't
 * have; either way the implementation is the address in EIP-1967's implementation slot or, if that
 * is zero, what the beacon in EIP-1967's beacon slot returns. Unknown code whose secondary slot is
 * set is a two-slot proxy (an old RollupProxy), with no version of its own: null.
 */
export async function getVersion(rpc: VersionRpc, registry: RegistryFiles, address: string, block = 'latest'): Promise<ContractVersion | null> {
  const slot = async (s: string) => slotAddress(await rpc.getStorageAt(address, s, block))
  const codeAt = async (a: string) => hexToBytes(await rpc.getCode(a, block) as Hex)
  const entry = await lookup(registry, await codeAt(address))
  if (entry && !entry.isSingleImplementationProxy) return { version: entry.version, repo: entry.repo }
  if (!entry && await slot(SECONDARY_IMPLEMENTATION_SLOT)) return null // an unknown two-slot proxy
  const impl = await slot(EIP1967_IMPLEMENTATION_SLOT) ?? await beaconImplementation(rpc, await slot(EIP1967_BEACON_SLOT), block)
  const implEntry = impl && await lookup(registry, await codeAt(impl))
  return implEntry ? { version: implEntry.version, repo: implEntry.repo } : null
}

/**
 * The address a beacon's `implementation()` returns, or null if there is no beacon, or the call
 * reverts or returns no address. An RPC failure throws.
 */
export async function beaconImplementation(rpc: Pick<VersionRpc, 'call'>, beacon: string | null, block: string): Promise<string | null> {
  if (!beacon) return null
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

/** The address in a 32-byte word (its last 20 bytes, if the other 12 are zero), or null if it is zero or not an address. */
export function slotAddress(word: string): string | null {
  const h = word.replace(/^0x/, '').padStart(64, '0')
  if (!/^0{24}/.test(h) || /^0{64}$/.test(h)) return null
  return '0x' + h.slice(24)
}

/**
 * The entry whose `fingerprint` is the keccak256 of `code` with the entry's `fingerprintMask`
 * zeroed, or null. Only entries of the code's length can match, and the registry keeps the
 * entries of one length masking the same bytes, so at most one does.
 */
export async function lookup(registry: RegistryFiles, code: Uint8Array): Promise<VersionEntry | null> {
  for (const entry of await readByLength(registry, code.length)) {
    if (keccak256(zeroRanges(code, entry.fingerprintMask)) === entry.fingerprint) return entry
  }
  return null
}

/** The entries in `registry/by-length/<length>.json`: none, without a read, for a length the index doesn't list. */
export async function readByLength(registry: RegistryFiles, length: number): Promise<VersionEntry[]> {
  if (!registry.index.codeLengths.includes(length)) return []
  const path = `registry/by-length/${length}.json`
  const text = await registry.read(path)
  if (text === null) throw new Error(`registry/index.json lists code length ${length}, but ${path} is missing`)
  return JSON.parse(text).entries
}

/** A copy of `code` with every `[offset, length]` in `ranges` zeroed. */
export function zeroRanges(code: Uint8Array, ranges: readonly [offset: number, length: number][]): Uint8Array {
  const out = Uint8Array.from(code)
  for (const [offset, length] of ranges) out.fill(0, offset, offset + length)
  return out
}
