export type Hex = `0x${string}`

/** The `schemaVersion` of input files (entries, tags, branches) and config. */
export const SCHEMA_VERSION = 1
/** The `schemaVersion` of the generated views (`registry/by-length/`, `registry/index.json`). */
export const VIEW_SCHEMA_VERSION = 1

/**
 * Bytes of runtime code that are filled in at deploy time, so they are zeroed before hashing: a
 * Solidity immutable (named as in the source, e.g. `maxDataSize`, `__self`), a linked library's
 * address (`<link <file>:<library>>`) or a library's own address (`<library address>`). Synthetic
 * names start with `<`.
 */
export interface MaskedRange {
  name: string
  /** ABI type used to decode the value, e.g. `uint256`, `bool`, `address`. */
  type: string
  /** Byte offsets of every occurrence in the runtime code. */
  offsets: number[]
  /** Length in bytes of each occurrence (32 for Solidity immutables, 20 for addresses). */
  length: number
}

export interface Getter {
  /** Canonical signature, e.g. `bridge()` or `allowedDelayedInboxList(uint256)`. */
  signature: string
  selector: Hex
  /** `single`: no inputs. `list`: one uint256 input, called with 0, 1, ... */
  kind: 'single' | 'list'
}

export interface CompilerInfo {
  language: string
  version: string
  evmVersion: string | null
  optimizer: { enabled: boolean; runs: number | null; details?: unknown }
  viaIR: boolean
  metadata: { bytecodeHash: string | null; appendCBOR: boolean }
}

/**
 * What a contract is to someone walking a chain. `logic`: code that implements the system (on its
 * own or behind a proxy). `proxy`: delegates to the implementation(s) in its slots, or to its
 * beacon's implementation. `proxy-admin`: administers proxies (e.g. OpenZeppelin's ProxyAdmin, or
 * an UpgradeableBeacon). Upgrades replace logic, never proxies or their admins, so only logic says
 * which release a deployment runs.
 */
export type ContractRole = 'logic' | 'proxy' | 'proxy-admin'

/**
 * A contract's role as configured in sources.json `contractRoles` (unlisted contracts are logic).
 * A proxy lists either the slots holding its implementations or, for a beacon proxy, the slot
 * holding its beacon.
 */
export type RoleConfig = { role: 'proxy'; implementationSlots: Hex[] } | { role: 'proxy'; beaconSlot: Hex } | { role: 'proxy-admin' }

/** The registry record for one distinct fingerprint (entries/<fingerprint>.json). Write-once. */
export interface Entry {
  schemaVersion: number
  fingerprint: Hex
  repo: string
  contracts: string[]
  /**
   * The contracts compiled from an installed dependency package, by fully qualified name:
   * `<package>@<version>`, e.g. `@openzeppelin/contracts@4.7.3`. Contracts not listed are the
   * source repo's own code; absent when every contract is. Like `ref` and `commit`, recorded from
   * the first build that produced the fingerprint (a later build may compile the same code from
   * another version).
   */
  packages?: Record<string, string>
  role: ContractRole
  /**
   * Proxies only: the storage slots holding implementation addresses, in order. The first is the
   * implementation; AdminFallbackProxy (RollupProxy) has a second, the user-logic implementation.
   * A proxy has either this or `beaconSlot`.
   */
  implementationSlots?: Hex[]
  /**
   * Beacon proxies only: the storage slot holding the beacon's address (EIP-1967's beacon slot for
   * OpenZeppelin's `BeaconProxy`). The implementation is what the beacon's `implementation()`
   * returns. A proxy has either this or `implementationSlots`.
   */
  beaconSlot?: Hex
  codeLength: number
  /** The ranges zeroed before hashing, besides the trailing CBOR metadata. */
  maskedRanges: MaskedRange[]
  cborMetadataLength: number
  getters: Getter[]
  /** Every function selector in the ABI; used to find the closest entry for unknown code. */
  selectors: Hex[]
  compiler: CompilerInfo | null
  /**
   * The ref the entry was first built from: a tag (`v3.2.0`) or a published branch
   * (`release-3.3.0`), whose head was built. Only tags and branch heads are built, so this is
   * where the registry first saw the code, not the earliest commit that contains it. Null only on
   * a manual entry, which has a `label`.
   */
  ref: string | null
  /** The commit `ref` pointed at when the entry was built. Null only on a manual entry. */
  commit: string | null
  /** Manual entries only (one-offs, old releases not on a published ref). */
  label?: string
  notes?: string
}

export interface TagFile {
  schemaVersion: number
  repo: string
  tag: string
  commit: string
  prerelease: boolean
  /** `version` from package.json at the tag's commit (recorded even when it doesn't match the tag). */
  packageVersion: string | null
  contracts: Record<string, Hex>
}

export interface BranchFile {
  schemaVersion: number
  repo: string
  branch: string
  commit: string
  contracts: Record<string, Hex>
}

/** Bytes of runtime code: `[offset, length]`. */
export type ByteRange = [offset: number, length: number]

/**
 * An entry as the by-length view lists it: the entry file, the tags of its own source's tag files,
 * and three fields worked out when the view is generated, so that a lookup and `getVersion` need
 * nothing else.
 */
export type ByLengthEntry = Entry & {
  /** Its source's tags whose builds produced the code, in semver order. */
  tags: string[]
  /**
   * What `getVersion` reports for this code: its first release tag, else its first tag (a
   * prerelease), else a manual entry's `label`, else `<ref>@<first 12 hex digits of commit>`.
   */
  version: string
  /**
   * A proxy that forwards every call to one implementation: one implementation slot, or a beacon.
   * `getVersion` reports its implementation instead of the proxy. False for logic, proxy admins and
   * two-slot proxies (RollupProxy, AdminFallbackProxy).
   */
  isSingleImplementationProxy: boolean
  /**
   * The bytes the fingerprint zeroes, sorted by offset: each of `maskedRanges` at every offset, and
   * the trailing CBOR metadata. `fingerprint = keccak256(code with each range zeroed)`.
   */
  fingerprintMask: ByteRange[]
}

/**
 * Generated lookup shard (`registry/by-length/<codeLength>.json`): every entry of that length, of
 * every source, sorted by fingerprint. Each entry has its own `repo`, and the tags of its source's
 * tag files.
 */
export interface ByLengthFile {
  schemaVersion: number
  codeLength: number
  entries: ByLengthEntry[]
}

/** Generated summary (`registry/index.json`): the code lengths with a shard, and per source its repo and getters. */
export interface IndexFile {
  schemaVersion: number
  codeLengths: number[]
  /** By source id (its `directory`). */
  sources: Record<string, IndexSource>
}

export interface IndexSource {
  repo: string
  /**
   * The getters of every entry the source's tag and branch files reference, and of its own entries
   * (manual ones included). The walker calls them on unknown code in a walk of that source.
   */
  getters: Getter[]
}

/** A contract produced by one build, before it becomes (or matches) an entry. */
export interface BuiltContract {
  fqName: string
  /** `<package>@<version>` when compiled from an installed dependency package, else null. */
  package: string | null
  fingerprint: Hex
  codeLength: number
  maskedRanges: MaskedRange[]
  cborMetadataLength: number
  getters: Getter[]
  selectors: Hex[]
  compiler: CompilerInfo
}
