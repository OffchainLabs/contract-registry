export type Hex = `0x${string}`

export const SCHEMA_VERSION = 1

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
 * own or behind a proxy). `proxy`: delegates to the implementation(s) in its slots. `proxy-admin`:
 * administers proxies (e.g. OpenZeppelin's ProxyAdmin). Upgrades replace logic, never proxies or
 * their admins, so only logic says which release a deployment runs.
 */
export type ContractRole = 'logic' | 'proxy' | 'proxy-admin'

/** A contract's role as configured in sources.json `contractRoles` (unlisted contracts are logic). */
export type RoleConfig = { role: 'proxy'; implementationSlots: Hex[] } | { role: 'proxy-admin' }

/** The registry record for one distinct fingerprint (entries/<fingerprint>.json). Write-once. */
export interface Entry {
  schemaVersion: number
  fingerprint: Hex
  repo: string
  contracts: string[]
  /**
   * The contracts compiled from an installed dependency package, by fully qualified name:
   * `<package>@<version>`, e.g. `@openzeppelin/contracts@4.7.3`. Contracts not listed are the
   * source repo's own code; absent when every contract is. Like `firstCommit`, recorded from the
   * first build that produced the fingerprint (a later build may compile the same code from
   * another version).
   */
  packages?: Record<string, string>
  role: ContractRole
  /**
   * Proxies only: the storage slots holding implementation addresses, in order. The first is the
   * implementation; AdminFallbackProxy (RollupProxy) has a second, the user-logic implementation.
   */
  implementationSlots?: Hex[]
  codeLength: number
  /** The ranges zeroed before hashing, besides the trailing CBOR metadata. */
  maskedRanges: MaskedRange[]
  cborMetadataLength: number
  getters: Getter[]
  /** Every function selector in the ABI; used to find the closest entry for unknown code. */
  selectors: Hex[]
  compiler: CompilerInfo | null
  firstCommit: string | null
  firstBranch: string | null
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

export type ByLengthEntry = Entry & { tags: string[] }

export interface ByLengthFile {
  schemaVersion: number
  repo: string
  codeLength: number
  entries: ByLengthEntry[]
}

/** Generated summary of a source repo's directory: which lengths exist and every getter known. */
export interface IndexFile {
  schemaVersion: number
  repo: string
  codeLengths: number[]
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
