# Changelog

Changes that affect clients of the registry's data, its TypeScript API or its CLIs, newest first.

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
