// Public API of the reference walker, for TypeScript consumers.
export { walk, EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT } from './walk.ts'
export type { WalkOptions, WalkResult, WalkNode, Warning, Edge, CodeId, MatchedEntry, ClosestEntry } from './walk.ts'
export { Registry, openSource, DirSource, GitSource, HttpSource } from './registry.ts'
export type { RegistrySource, Match } from './registry.ts'
export { Rpc, RpcError, ExecutionError } from './rpc.ts'
export { mask, matches, fingerprintOf, variantValues } from '../lib/fingerprint.ts'
export type { Entry, ByLengthEntry, ByLengthFile, IndexFile, TagFile, BranchFile, ImmutableRef, Getter } from '../lib/types.ts'
