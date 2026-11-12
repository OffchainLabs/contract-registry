export type Hex = `0x${string}`

export const SCHEMA_VERSION = 1

/** One immutable variable (or other deploy-time-filled range) inside runtime code. */
export interface ImmutableRef {
  name: string
  /** ABI type used to decode the value, e.g. `uint256`, `bool`, `address`. */
  type: string
  /** Byte offsets of every occurrence in the runtime code. */
  offsets: number[]
  /** Length in bytes of each occurrence (32 for Solidity immutables). */
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

/** The registry record for one distinct fingerprint (entries/<fingerprint>.json). Write-once. */
export interface Entry {
  schemaVersion: number
  fingerprint: Hex
  repo: string
  contracts: string[]
  codeLength: number
  immutables: ImmutableRef[]
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
  fingerprint: Hex
  codeLength: number
  immutables: ImmutableRef[]
  cborMetadataLength: number
  getters: Getter[]
  selectors: Hex[]
  compiler: CompilerInfo
}
