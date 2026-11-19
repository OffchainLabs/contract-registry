# Data format

What the registry records for each contract, and where its files are.

## Fingerprints

A contract's fingerprint is keccak256 of its runtime code with every byte filled in at deploy time
zeroed. An entry lists those bytes as `maskedRanges` (`name`, `type`, `offsets`, `length` each):
the Solidity immutables, plus the addresses of linked libraries (`<link <file>:<library>>`) and a
library's own address (`<library address>`). The trailing CBOR metadata section, `cborMetadataLength`
bytes, is zeroed too. On-chain code matches an entry when it has the entry's length and the same
hash after masking with the entry's ranges.

`decodeImmutables(code, entry)` reads matched code's immutables, by name and decoded by type
(`maxDataSize`, `isUsingFeeToken`, `isDelayBufferable`, `__self`, ...); the walker and the `lookup`
CLI report them as `immutables`. The `<…>` ranges are masked but not reported: they say where the
code was deployed, not how it was configured.

Libraries with no external functions are not recorded: they are only ever inlined, never linked or
deployed, and all compile to the same 45-byte stub. Libraries with an external function (a public
constant's getter counts) are kept.

## Entries

Besides the fingerprint and its masks (`codeLength`, `maskedRanges`, `cborMetadataLength`), an
entry says what the code is:

- `role`: `logic`, `proxy` or `proxy-admin`. A `proxy` entry also has `implementationSlots`, the
  storage slots that hold its implementation addresses, in order, or, for a beacon proxy,
  `beaconSlot`, the slot that holds its beacon's address; never both. So a client that identifies
  proxy code knows to read those slots and identify the code at each address, or to ask the beacon
  for its `implementation()` and identify the code there. Roles come from `contractRoles` in
  `config/<source>/sources.json` (unlisted contracts are logic), in the same form:
  `{"role": "proxy", "implementationSlots": [...]}`, `{"role": "proxy", "beaconSlot": "0x..."}` or
  `{"role": "proxy-admin"}`. For nitro-contracts, `TransparentUpgradeableProxy` and `ERC1967Proxy`
  list the EIP-1967 slot; `RollupProxy` and `AdminFallbackProxy` list it and the secondary
  (user-logic) slot; `ProxyAdmin` and `UpgradeableBeacon` are `proxy-admin`s. A beacon proxy
  (OpenZeppelin's `BeaconProxy`) lists EIP-1967's beacon slot,
  `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50`. Contracts that compile to one
  fingerprint must have the same role, slots and beacon slot included. The role is copied into the
  entry when it is written, and entries are write-once, so list a contract before its first build
  is published.
- `ref` and `commit`: the ref the entry was first built from, and the commit it pointed at then.
  `ref` is a tag (`v3.2.0`) or a release or hotfix branch whose head was built (`release-3.3.0`).
  Only tags and branch heads are built, never a branch's earlier commits, so `commit` contains the
  code but isn't necessarily the earliest commit that does. When a new tag and a new branch head
  bring the same new code in one run, the entry names the tag. Entries are write-once: code first
  built from a release branch keeps naming that branch after a tag includes it (the tag shows in
  the entry's `tags` in `registry/by-length/`) and after the branch is deleted. A manual entry,
  which has a `label`, may have a null `ref` or `commit` (see [Manual entries](manual-entries.md)).
- `packages`: for contracts compiled from an installed dependency package, the package and version,
  e.g. `{"@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy":
  "@openzeppelin/contracts@4.7.3"}`. It maps each such contract's name, so an entry whose contracts
  come from several packages, or from a package and the repo's own code, stays unambiguous.
  Contracts not listed are the source repo's own code; the field is absent when all of them are.
  None of them is another source's package: publish refuses that code (see
  [Across sources](publishing.md#across-sources)). The version is read from the package's `package.json` in the build checkout. Like `ref` and
  `commit`, it records the first build that produced the fingerprint: a later build may compile the
  same code from another version of the package, and the entry doesn't change.

## Layout

```
config/<source>/sources.json                  which refs are published; how to fetch, build (profiles
                                              by ref range) and check the source repo; its npm
                                              packages; proxies; reviewed range pairs
config/<source>/out-of-scope-getters.json     getters the walker doesn't follow
schema/                                       JSON schemas for every file type
registry/<source>/entries/<fingerprint>.json  one per distinct fingerprint, in one source only (see
                                              "Across sources" in publishing.md); write-once
registry/<source>/tags/<tag>.json             contract -> fingerprint for a tag's build; write-once
registry/<source>/branches/<branch>.json      same for the head of a live release or hotfix branch;
                                              overwritten, and removed with the branch
registry/by-length/<codeLength>.json          generated, all sources: every entry of that length,
                                              with its tags
registry/index.json                           generated, all sources: code lengths present; per
                                              source, its repo and getters
```

`<source>` is a source's id, its `directory` in `sources.json` (`nitro-contracts`). Each source's
inputs are under `registry/<source>/`; the generated views combine every source, so one lookup
covers them all. `by-length` and `index.json` are taken, so no source can use them as its id.

The views are generated from the inputs and never hand-edited. `registry/by-length/<len>.json`
lists every entry of that length, sorted by fingerprint; each keeps its own `repo`, and its `tags`
come from its own source's tag files only (tag names overlap across source repos).
`registry/index.json` lists the code lengths that have a file and, per source, its `repo` and
getters: those of its own entries and of every entry its tag and branch files reference. The walker
calls a source's getters on code it doesn't know. The views have `schemaVersion` 2; entries, tags,
branches and config stay at 1.

Read every file at one commit of this repo, never across a push.
