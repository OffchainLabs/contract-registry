# contract-registry (prototype)

Identifies which release, or which commit, of an Offchain Labs contract repo a deployed contract
was built from, using only a standard RPC (`eth_getCode`, `eth_getStorageAt`, `eth_call`).
CI builds the source repos, fingerprints every deployable contract, and publishes the results here
as static JSON. A reference walker discovers and identifies every contract of a chain.

Design: `contract-registry-spec.md` (BLK-491). Status: prototype. Sources: `nitro-contracts`,
from tag `v3.2.0` onward.

## How to use

To get the version of the contract at an address:

```ts
import { openSource, Registry, Rpc } from '<this repo>/walker'

// openSource resolves `main` to a commit once, so every file is read from one snapshot.
const registry = new Registry(await openSource('github:<owner>/<repo>@main'), 'nitro-contracts')
const version = await registry.getVersion(new Rpc(rpcUrl), address) // e.g. 'v3.2.0', or null
```

`getVersion` does this:

```
getVersion(rpc, address) -> string | null:
  entry = lookup(rpc.getCode(address))
  if entry == null: return null
  if entry.role == "proxy" and len(entry.implementationSlots) == 1:
    impl = lastTwentyBytes(rpc.getStorageAt(address, entry.implementationSlots[0]))
    if impl is zero or has no code: return null
    implEntry = lookup(rpc.getCode(impl))
    return implEntry ? versionOf(implEntry) : null
  return versionOf(entry)        # logic, proxy admins, and two-slot proxies report themselves

versionOf(entry) -> string:
  releases = [t for t in entry.tags if not isPrerelease(t)]   # tags are in semver order
  if releases:   return releases[0]
  if entry.tags: return entry.tags[0]
  return entry.firstBranch + "@" + entry.firstCommit[:12]

lookup(code) -> entry | null:
  # every read at one commit of this repo
  for entry in <source>/by-length/<len(code)>.json .entries:
    masked = copy of code
    for range in entry.maskedRanges:
      for offset in range.offsets: zero masked[offset : offset + range.length]
    zero the last entry.cborMetadataLength bytes of masked
    if keccak256(masked) == entry.fingerprint: return entry
  return null
```

The choices it makes:

- A proxy with one implementation slot (`TransparentUpgradeableProxy`, `ERC1967Proxy`) reports its
  implementation's version.
- `RollupProxy` and `AdminFallbackProxy`, which have two slots, report themselves, as do logic and
  `ProxyAdmin`. A two-slot proxy's version is the release its proxy code came from, and it can lag
  the logic behind it: upgrades replace the logic, never the proxy.
- The version is the first non-prerelease tag whose build contains the code: the earliest release
  with that exact code.
- Code in no release gives its first prerelease tag. Code in no tag at all gives
  `<firstBranch>@<first 12 hex digits of firstCommit>`, e.g. `develop@349a4bfbdfec`. (A manual
  entry with no tag gives its label.)
- Unknown code gives null, as does a one-slot proxy whose slot is zero or whose implementation is
  unknown or has no code.

For more than a version: `registry.lookup(code)` returns the matched entry (contracts, role, tags,
`firstCommit`, ...), and `decodeImmutables(code, entry)` reads its immutables (`maxDataSize`,
`isUsingFeeToken`, ...). `walk` discovers and identifies every contract of a chain from one address
(see "Look up and walk").

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
  storage slots that hold its implementation addresses, in order. So a client that identifies
  proxy code knows to read those slots and identify the code at each address. Roles come from
  `contractRoles` in `config/<source>/sources.json` (unlisted contracts are logic). For
  nitro-contracts, `TransparentUpgradeableProxy` and `ERC1967Proxy` list the EIP-1967 slot;
  `RollupProxy` and `AdminFallbackProxy` list it and the secondary (user-logic) slot; `ProxyAdmin`
  is a `proxy-admin`. The role is copied into the entry when it is written, and entries are
  write-once, so list a contract before its first build is published.
- `packages`: for contracts compiled from an installed dependency package, the package and version,
  e.g. `{"@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy":
  "@openzeppelin/contracts@4.7.3"}`. It maps each such contract's name, so an entry whose contracts
  come from several packages, or from a package and the repo's own code, stays unambiguous.
  Contracts not listed are the source repo's own code; the field is absent when all of them are.
  The version is read from the package's `package.json` in the build checkout. Like `firstCommit`,
  it records the first build that produced the fingerprint: a later build may compile the same code
  from another version of the package, and the entry doesn't change.

## Layout

```
config/<source>/sources.json                  how to fetch, build and check the source repo; proxies;
                                              reviewed range pairs
config/<source>/out-of-scope-getters.json     getters the walker doesn't follow
schema/                                       JSON schemas for every file type
<source>/entries/<fingerprint>.json           one per distinct fingerprint; write-once
<source>/tags/<tag>.json                      contract -> fingerprint for a tag's build; write-once
<source>/branches/<branch>.json               same for a published branch head; overwritten
<source>/by-length/<codeLength>.json          generated: every entry of that length, with its tags
<source>/index.json                           generated: code lengths present, every getter known
```

`by-length/` and `index.json` are generated from `entries/` and `tags/` and never hand-edited.
Read every file at one commit of this repo, never across a push.

## Look up and walk

```sh
npm ci
# version of the contract at an address, as getVersion gives it (a proxy reports its implementation)
node tools/src/cli/version.ts --rpc $RPC --address 0x...       # prints e.g. v3.2.0; unknown: exit 1
# identify one contract (the code at the address itself, as JSON)
node tools/src/cli/lookup.ts --rpc $RPC --address 0x...
# walk a chain from any core contract (JSON on stdout)
node tools/src/cli/walk.ts --rpc $RPC --start <rollup or inbox> [--registry github:<owner>/<repo>@main]
```

From TypeScript: `import { walk, Registry, openSource, Rpc } from '<this repo>/walker'` (run
`npm run build:walker` to emit `dist/`). `Registry.lookup(code)` returns the matched entry or null,
and `decodeImmutables(code, entry)` its immutables. The `lookup` CLI prints, for each address, the
entry as `match` (or null), with its `version` and `immutables`.

The walker identifies each contract's code: matched code is `{ status: "matched", codeLength,
match }`, where `match` is the one matching entry with its `tags` and the code's `immutables`. For
a `proxy` entry it reads the slots the entry lists: the
first gives the node's `implementation`, the second its `secondaryImplementation`. Logic and
proxy-admin code isn't probed. Code the registry doesn't know (for example a chain deployed before
the registry's start, like Arbitrum One) is probed at the EIP-1967 slot and, if that is set, at the
secondary slot.

`summary.tags` is the intersection of the tag sets of the matched in-scope logic code: the releases
the deployment is consistent with. Proxies and proxy admins are still identified in the nodes, but
left out of the summary: upgrades replace implementations, never proxies, so after an upgrade to a
release that changed proxy code they would empty the intersection. `summary.matchedInScope` counts
every role.

## Publishing

Everything runs here ("pull" model); the source repos need no CI or credentials.

- `publish.yml` (schedule, manual): builds every new commit on a published branch in history order
  (so `firstCommit` is exact), rebuilds every new tag from scratch and checks it reproduces its
  commit, writes entries, tag and branch files, checks that entries of one code length mask the
  same bytes (so no code can match two; a conflict fails the whole run, and its alert says how to
  review the pair and list it in `reviewedRangePairs`), regenerates the views, deploys test chains
  from each new head and tag and walks them, and lands everything as one commit. The test-chain check
  requires all in-scope code, proxies and proxy admins included, to match an entry from that
  commit's build. It also reads both known implementation slots on every matched contract, and
  fails if one holds an address the walk didn't read: a proxy missing from `contractRoles`.
- `reconcile.yml` (daily): the same run, plus an alert for any published ref that should already
  have been processed.
- `ci.yml` (every push and PR): schemas, generated files match their inputs, the range invariant
  (with `reviewedRangePairs`), `entries/` and `tags/` are append-only.

Failures open or update one GitHub issue per failure kind and source repo, and close it once every
item is resolved. Locally, `--alerts local:<dir>` writes the same alerts as JSON files.

```sh
node tools/src/cli/publish.ts --source nitro-contracts [--reconcile] [--push] [--alerts github:<owner>/<repo>]
node tools/src/cli/check.ts --rev develop        # test-chain check of one commit, writes nothing
node tools/src/cli/rebuild.ts --tag v3.2.0       # rebuild a tag and compare with its tags/ file
node tools/src/cli/ci-check.ts --base origin/main
npm test && npm run test:integration
```
