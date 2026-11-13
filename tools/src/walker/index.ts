// Public API of the reference walker, for TypeScript consumers.
export { walk, EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT } from './walk.ts'
export type { WalkOptions, WalkResult, WalkNode, Warning, Edge, CodeId, MatchedEntry, ClosestEntry, Implementation } from './walk.ts'
export { Registry, versionOf, openSource, DirSource, GitSource, HttpSource } from './registry.ts'
export type { RegistrySource } from './registry.ts'
export { Rpc, RpcError, ExecutionError } from './rpc.ts'
export { mask, matches, fingerprintOf, decodeImmutables } from '../lib/fingerprint.ts'
export type { MaskSpec, ImmutableValue } from '../lib/fingerprint.ts'
export type { Entry, ByLengthEntry, ByLengthFile, IndexFile, TagFile, BranchFile, MaskedRange, Getter, ContractRole } from '../lib/types.ts'
