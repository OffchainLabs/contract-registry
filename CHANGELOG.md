# Changelog

Changes that affect clients of the registry's data, its TypeScript API or its CLIs, newest first.

**`getVersion` reads its decisions from the data (2026-11-23).** View `schemaVersion` 3. A client
that reads `main` needs this version of the walker; one pinned to an earlier commit keeps working.

- Every entry in `registry/by-length/` has three new fields, worked out when the views are
  generated: `version` (what `getVersion` reports, as `versionOf` did), `isSingleImplementationProxy`
  (a proxy with one implementation slot, or a beacon proxy) and `fingerprintMask` (the
  `[offset, length]` pairs a lookup zeroes before hashing: `maskedRanges` and the CBOR metadata).
  Entry, tag and branch files and fingerprints are unchanged; `registry/index.json` changes only in
  its `schemaVersion`.
- `getVersion` follows a known single-implementation proxy as it follows unknown code: EIP-1967's
  implementation slot, then the beacon in EIP-1967's beacon slot, instead of the slots its entry
  lists. Every such entry lists those slots, and publish, `add-entry` and `ci-check` now refuse one
  that doesn't. So a one-slot proxy whose implementation slot is zero now tries the beacon slot,
  and a beacon proxy reads the implementation slot first. Unknown code reads its secondary slot
  first. For Arbitrum One's core, token bridge and upgrade executor contracts, the answers are
  unchanged.
- `Registry.open` reads `registry/index.json` and throws for a snapshot it can't read: one with no
  index (before layout v2) or another `schemaVersion` (any commit before this one). Before, the
  first lookup threw. `Registry.open` also takes a `RegistrySource`; `new Registry(source)` is gone
  (use `Registry.open(source)`), and `registry.index` is a property, not a method.
- The walker no longer exports `versionOf`: read `entry.version`. A walk's `match.version` is that
  field.

**Layout v2 and one lookup across sources (2026-11-16).** One break for every client that reads
`main`. Clients pinned to an earlier commit keep working, since old commits keep the old layout.

- Data moved under `registry/`: a source's inputs are in `registry/<source>/` (was `<source>/`), and
  the generated views combine every source, in `registry/by-length/` and `registry/index.json`
  (`schemaVersion` 2). A `by-length` entry keeps its own `repo`; the index lists each source's
  `repo` and getters.
- `new Registry(source, 'nitro-contracts')` is now `new Registry(source)`, or `await
  Registry.open(spec)`, which also resolves the spec (default: this repo's `main`).
- `getVersion` returns `{ version, repo }` instead of a string, because tag names overlap across
  sources.
- Lookups read `registry/index.json` first. A snapshot without it, such as an older commit of this
  repo, throws instead of answering null for everything.
- `walk` takes an optional `source` (a source id, inferred from the start) instead of `repo`, and
  `outOfScope` is optional (default: the source's list in the registry). Walk output has
  `schemaVersion` 2: out-of-scope leaves are identified, each match has its `version`, the summary
  intersects only the walk's repo and lists other repos' code in `otherRepoInScope`, and warnings
  come in a fixed order.
- CLIs: `version` prints `<version> <repo>`; `version` and `lookup` search every source and take no
  `--source`; `walk`'s `--source` is optional; `add-entry`, `check` and `rebuild` require
  `--source`, with no default.
- Beacon proxies: a proxy entry (and its `contractRoles` value) can have a `beaconSlot` instead of
  `implementationSlots`, and `getVersion`, the walker and the test-chain check follow it to the
  beacon's implementation. `getVersion`'s `rpc` needs `call` as well as `getCode` and
  `getStorageAt`. Unknown code is also probed at the beacon slot when its EIP-1967 and secondary
  slots are zero.
- Out-of-scope keys can name a contract (`L1WethGateway.l2Weth()`) as well as be a bare getter
  signature.
