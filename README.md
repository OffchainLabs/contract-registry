# contract-registry (prototype)

Identifies which release, or which commit, of an Offchain Labs contract repo a deployed contract
was built from, using only a standard RPC (`eth_getCode`, `eth_getStorageAt`, `eth_call`).
CI builds each source repo's tags and the heads of its release and hotfix branches, fingerprints
every deployable contract, and publishes the results here as static JSON. A reference walker
discovers and identifies every contract of a chain.

Design: `contract-registry-spec.md` (BLK-491). Status: prototype. Sources: `nitro-contracts`,
every tag from `v3.2.0` onward, plus the releases from `v3.0.0` on (backfilled; see "Backfill").

## How to use

To get the version of the contract at an address:

```ts
import { Registry, Rpc } from '<this repo>/walker'

// Registry.open() reads this repo's main branch, resolved to a commit once, so every file comes
// from one snapshot. One registry covers every source repo: a lookup searches all of them.
const registry = await Registry.open()
const v = await registry.getVersion(new Rpc(rpcUrl), address)
// e.g. { version: 'v3.2.0', repo: 'OffchainLabs/nitro-contracts' }, or null
```

`getVersion` returns the repo with the version, because tag names overlap across source repos.
`Registry.open(spec)` opens another snapshot: `github:<owner>/<repo>@<ref>`, `git:<path>@<rev>`,
or a directory.

**What a version means.** A version is the earliest release in the registry's range for that
source whose build contains the code: the first non-prerelease tag, else the first prerelease tag,
else a manual entry's label, else `<ref>@<commit>`. So nitro-contracts code unchanged since
`v2.1.0` reports `v3.0.0`, the first release the registry builds. "Backfill" gives each
source's range.

`getVersion` does this:

```
EIP1967_IMPLEMENTATION_SLOT   = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
SECONDARY_IMPLEMENTATION_SLOT = 0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d
EIP1967_BEACON_SLOT           = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50

getVersion(rpc, address) -> { version, repo } | null:
  entry = lookup(rpc.getCode(address))
  if entry != null and not (entry.role == "proxy" and (entry.beaconSlot or len(entry.implementationSlots) == 1)):
    return versionAndRepo(entry)   # logic, proxy admins, and two-slot proxies report themselves
  # a one-slot proxy, a beacon proxy, or unknown code (maybe a proxy the registry doesn't have)
  impls = implementations(rpc, address, entry)
  if impls.secondary: return null  # unknown code with both slots set (an old RollupProxy): no version of its own
  if not impls.implementation: return null
  implEntry = lookup(rpc.getCode(impls.implementation))
  return implEntry ? versionAndRepo(implEntry) : null

implementations(rpc, address, entry) -> { implementation?, secondary? }:
  # an address is the last 20 bytes of a slot whose other 12 bytes are zero; zero slots are left out
  if entry != null and entry.beaconSlot:     # a beacon proxy: what its beacon says
    return { implementation: beaconImplementation(rpc, slot(entry.beaconSlot)) }
  if entry != null:                          # a one-slot proxy: the slot its entry lists
    return { implementation: slot(entry.implementationSlots[0]) }
  impl = slot(EIP1967_IMPLEMENTATION_SLOT)   # unknown code: probe the known slots
  if not impl: return { implementation: beaconImplementation(rpc, slot(EIP1967_BEACON_SLOT)) }
  return { implementation: impl, secondary: slot(SECONDARY_IMPLEMENTATION_SLOT) }

beaconImplementation(rpc, beacon) -> address | null:
  if not beacon: return null
  # eth_call implementation() (selector 0x5c60da1b) on the beacon; a revert, or a result
  # that isn't a nonzero address in its first 32 bytes, gives null
  return address in rpc.call(beacon, 0x5c60da1b)

versionAndRepo(entry) -> { version, repo }:
  return { version: versionOf(entry), repo: entry.repo }

versionOf(entry) -> string:
  releases = [t for t in entry.tags if not isPrerelease(t)]   # tags are in semver order
  if releases:   return releases[0]
  if entry.tags: return entry.tags[0]
  if entry.label: return entry.label                         # a manual entry
  return entry.ref + "@" + entry.commit[:12]                 # e.g. release-3.3.0@abcdef012345

lookup(code) -> entry | null:
  # every read at one commit of this repo
  index = registry/index.json      # read once; if it is missing, this isn't a layout-v2 snapshot: fail
  if len(code) not in index.codeLengths: return null
  for entry in registry/by-length/<len(code)>.json .entries:   # that length's entries of every source
    masked = copy of code
    for range in entry.maskedRanges:
      for offset in range.offsets: zero masked[offset : offset + range.length]
    zero the last entry.cborMetadataLength bytes of masked
    if keccak256(masked) == entry.fingerprint: return entry
  return null
```

The choices it makes:

- A proxy with one implementation slot (`TransparentUpgradeableProxy`, `ERC1967Proxy`) reports its
  implementation's version and repo. The implementation can come from another source than the
  proxy: a nitro-contracts proxy in front of another repo's logic reports that repo.
- A beacon proxy (OpenZeppelin's `BeaconProxy`, and the token bridge's `ClonableBeaconProxy`, the
  code of each standard token the bridge deploys on the child chain) reports its implementation
  too: the one its beacon returns. Its entry has a `beaconSlot` instead of `implementationSlots`.
  `getVersion` reads the beacon's address from that slot and calls the beacon's
  `implementation()`, so its `rpc` needs `call` as well as `getCode` and `getStorageAt`. A
  reverting call must throw `ExecutionError` (as `Rpc`'s does); other errors are passed on.
- `RollupProxy` and `AdminFallbackProxy`, which have two slots, report themselves, as do logic and
  `ProxyAdmin`. A two-slot proxy's version is the release its proxy code came from, and it can lag
  the logic behind it: upgrades replace the logic, never the proxy.
- Code in no tag at all was built only as the head of a release or hotfix branch. It gives
  `<ref>@<first 12 hex digits of commit>`, the branch and head commit it was first built from,
  e.g. `release-3.3.0@abcdef012345`. That commit contains the code, but isn't necessarily the first
  commit that does: only branch heads are built. Once a tag contains the code, the tag wins.
- Unknown code may be a proxy the registry doesn't have, in front of logic it does: on Arbitrum
  One, for example, most proxies are early nitro-contracts builds, and the Inbox proxy an Arbitrum
  Classic build. So unknown code is probed at the EIP-1967 implementation slot and, like a one-slot
  proxy, reports the version of the implementation there. If that slot is zero, the EIP-1967
  beacon slot is probed, and a beacon there is asked for its implementation, as for a beacon proxy.
  That is safe for any unknown code: these are the standard slots, and the fallback can only
  return a version if it reaches code the registry recognises.
- Unknown code whose secondary slot is also set is a two-slot proxy (an old `RollupProxy`) and
  gives null, since a two-slot proxy reports its own version, which here is unknown. It never
  reports the admin logic in its EIP-1967 slot.
- Unknown code gives null if its EIP-1967 and beacon slots are both zero, or the implementation is
  unknown or has no code. So does a one-slot proxy whose slot is zero or whose implementation is
  unknown or has no code, and a beacon proxy whose beacon slot is zero, whose beacon's
  `implementation()` reverts or returns no address, or whose implementation is unknown or has no
  code.
- A snapshot with no `registry/index.json` (an older commit of this repo, from before layout v2)
  makes every lookup throw, rather than answer null.

For more than a version: `registry.lookup(code)` returns the matched entry (`repo`, contracts,
role, tags, `ref`, `commit`, ...), and `decodeImmutables(code, entry)` reads its immutables
(`maxDataSize`, `isUsingFeeToken`, ...). `walk` discovers and identifies every contract of a chain
from one address (see "Look up and walk").

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
  which has a `label`, may have a null `ref` or `commit` (see "Manual entries").
- `packages`: for contracts compiled from an installed dependency package, the package and version,
  e.g. `{"@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy":
  "@openzeppelin/contracts@4.7.3"}`. It maps each such contract's name, so an entry whose contracts
  come from several packages, or from a package and the repo's own code, stays unambiguous.
  Contracts not listed are the source repo's own code; the field is absent when all of them are.
  The version is read from the package's `package.json` in the build checkout. Like `ref` and
  `commit`, it records the first build that produced the fingerprint: a later build may compile the
  same code from another version of the package, and the entry doesn't change.

## Layout

```
config/<source>/sources.json                  which refs are published; how to fetch, build (profiles
                                              by ref range) and check the source repo; proxies;
                                              reviewed range pairs
config/<source>/out-of-scope-getters.json     getters the walker doesn't follow
schema/                                       JSON schemas for every file type
registry/<source>/entries/<fingerprint>.json  one per distinct fingerprint, in one source only (see
                                              "Across sources"); write-once
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

## Look up and walk

```sh
npm ci
# version of the contract at an address, as getVersion gives it (a proxy reports its implementation)
node tools/src/cli/version.ts --rpc $RPC --address 0x...   # prints e.g. "v3.2.0 OffchainLabs/nitro-contracts"; unknown: exit 1
# identify one contract (the code at the address itself, as JSON)
node tools/src/cli/lookup.ts --rpc $RPC --address 0x...
# walk a chain from any core contract (JSON on stdout)
node tools/src/cli/walk.ts --rpc $RPC --start <rollup or inbox> [--source nitro-contracts] [--registry github:<owner>/<repo>@main]
```

`version` and `lookup` search every source. Given several `--address`es, `version` prints
`<address> <version> <repo>`, or `<address> unknown`, per line. The `lookup` CLI prints, for each
address, the entry as `match` (or null), with its `repo`, `version` and `immutables`. Every CLI
reads the registry in this checkout unless given `--registry`.

A walk belongs to one source: code the registry doesn't know is probed with that source's
getters, that source's out-of-scope list applies (unless `--out-of-scope` gives another), and the
summary intersects that source's logic. `--source` names it, by id. Without it, the walk takes the
source of the start contract's logic: of the first of these that matches an entry, in order: its
implementation, its secondary implementation, its own code. So a proxy belongs to the source of the
logic behind it, not to the source that owns its proxy code. If nothing at the start matches and the registry has
only one source, the walk takes that one; otherwise it fails and asks for `--source`. Arbitrum
One's rollup (`0x5eF0D09d…` on Ethereum) is such a start: its proxy and both implementations
predate the registry's range.

From TypeScript: `import { walk, Registry, Rpc } from '<this repo>/walker'` (run
`npm run build:walker` to emit `dist/`). `walk({ start, rpc, registry })` takes `source` and
`outOfScope` (a list of getter signatures) as options, with the same defaults.

The walker identifies each contract's code: matched code is `{ status: "matched", codeLength,
match }`, where `match` is the one matching entry with its `repo`, its own `version`, its `tags`
and the code's `immutables`. For a `proxy` entry it reads the slots the entry lists: the first
gives the node's `implementation`, the second its `secondaryImplementation`. For a beacon proxy it
reads the entry's `beaconSlot` and calls the beacon's `implementation()`: the node's
`implementation` is `{ slot, beacon, address, code }`, with the beacon slot and the beacon's
address. A beacon whose `implementation()` reverts or returns no address gives no implementation.
Either way, the getters of the proxy's code and of its implementation are called on the proxy.
Logic and proxy-admin code isn't probed. Code the registry doesn't know (for example a release
older than the registry's range, or a proxy built outside it, like Arbitrum One's Arbitrum
Classic-era Inbox proxy) is probed at the EIP-1967 slot and, if that is set, at the secondary
slot; if it is zero, at the beacon slot.

A getter in the source's out-of-scope list (`config/<source>/out-of-scope-getters.json`) leads to a
leaf. A leaf is labelled with the edges that reached it (`RollupProxy.owner()`) and identified like
any other contract, implementations included, so a rollup's `owner()` shows which upgrade executor
owns it. A leaf is never expanded: no getters are called on it and no closest entry is looked for,
and its code raises no warning and doesn't count in the summary.

A key in the out-of-scope list is either a getter signature, such as `owner()`, out of scope on
every contract, or a contract name and a signature, such as `L1WethGateway.l2Weth()`, out of scope
only on contracts whose code or implementation matches an entry with a contract of that name (the
part after `:` in its fully qualified name). The second kind is for a getter that returns an
address on another chain in some contracts and one on the same chain in others. In the token
bridge, `L1WethGateway.l2Weth()`, on the parent chain, is an address on the child chain, while
`L2WethGateway.l2Weth()`, on the child chain, is that chain's own WETH. Code the registry doesn't
know only sees the first kind.

`summary.tags` is the intersection of the tag sets of the matched in-scope logic code of the walk's
repo: the releases the deployment is consistent with. Proxies and proxy admins are still identified
in the nodes, but left out of the summary: upgrades replace implementations, never proxies, so
after an upgrade to a release that changed proxy code they would empty the intersection.
`summary.matchedInScope` counts every role. In-scope code matched to another repo never enters the
intersection, since its tags are another repo's releases: `summary.otherRepoInScope` lists it, with
its address, repo and version.

The output doesn't depend on RPC timing: nodes come in order of depth, then in-scope first, then
by address; warnings by kind (unknown code, implementations with no code, reverted getters,
conflicting getters), then in node order.

## Publishing

Everything runs here ("pull" model); the source repos need no CI or credentials.

- `publish.yml` (schedule, manual): builds every new `v*` tag in range (see "Backfill"), and the
  head of every `release-*` and `hotfix*` branch whose head has changed. Nothing else is built: not
  `main` or `develop`, and not a release or hotfix branch's earlier commits. Each new tag is built
  from scratch, with the build profile its commit selects. If its
  commit was also built as a release or hotfix head (recorded in a branch file, or built in the
  same run), the tag build must reproduce that build's fingerprints; otherwise there is nothing to
  compare it with. The run writes entries (for code no source has an entry for yet; see "Across
  sources"), tag files and branch files (a deleted branch's file is removed; its entries stay),
  checks that entries of one code length mask the same bytes, in every source (so no code can
  match two; a conflict fails the whole run, and its alert says how to review the pair and list it
  in `reviewedRangePairs`), regenerates the views, deploys test chains from each new
  tag and changed head in the check's range and walks them, and lands everything as one commit.
  It checks that each new tag equals `v` + `package.json` version at its commit; a mismatch is
  published anyway and raises an alert until the tag is listed in `tagValidation.allowlist`.
  The test-chain check
  requires all in-scope code, proxies and proxy admins included, to match an entry from that
  commit's build. It also reads the known slots (EIP-1967's implementation and beacon slots, and the
  secondary slot) on every matched contract, and fails if one that its entry doesn't list holds an
  address: a proxy missing from `contractRoles`, or listed with the wrong slots.
- `reconcile.yml` (daily): the same run, plus an alert for any published ref that should already
  have been processed.
- `ci.yml` (every push and PR): schemas; no two sources share an id or a repo; nothing outside the
  layout (a source's directory at the top of the repo, or anything in `registry/` but configured
  sources, `by-length/` and `index.json`); generated files match their inputs; one entry per
  fingerprint across sources, and an entry for every fingerprint a tag or branch file lists; the
  range invariant across sources (with every source's `reviewedRangePairs`); `entries/` and
  `tags/` files are append-only. Append-only compares content with the base, so a file moved into
  `registry/` passes, and a changed or deleted one fails wherever it moved.

A run publishes each source in turn, in id order (every configured source unless `--source` names
some), and lands each as its own commit: the source's files under `registry/<source>/` and the
regenerated views. A failed run discards both. One run at a time per work directory, since every
run rewrites the shared views.

Failures open or update one GitHub issue per failure kind and source repo, and close it once every
item is resolved. A build or test-chain failure at a branch head also resolves once the branch has
a newer head or is deleted, since only current heads are built. Locally, `--alerts local:<dir>`
writes the same alerts as JSON files.

```sh
node tools/src/cli/publish.ts [--source nitro-contracts ...] [--reconcile] [--push] [--alerts github:<owner>/<repo>]
node tools/src/cli/check.ts --source nitro-contracts --rev v3.2.0    # test-chain check of one commit, writes nothing
node tools/src/cli/rebuild.ts --source nitro-contracts (--tag v3.2.0 | --all)  # rebuild tags, compare with their tags/ files
node tools/src/cli/generate.ts [--check]   # regenerate the views (--check: compare only)
node tools/src/cli/ci-check.ts --base origin/main
npm test && npm run test:integration
```

### Across sources

One lookup searches every source, so the registry's rules hold across sources. Publish,
`add-entry` and `ci-check` apply them to the entries of every configured source:

- **One entry per fingerprint.** A fingerprint has one entry, in one source's `entries/`. Publish
  and `add-entry` look a fingerprint up in every source before writing one. When a build produces
  code that another source already has an entry for (shared code, such as a proxy both repos
  compile from the same package), publish writes no entry. The build's tag or branch file lists
  the fingerprint as usual, and the other source's entry is the one lookups find. That entry's
  `tags` come from its own source's tag files only (tag names overlap across sources), so shared
  code reports the version and repo of the source that owns it; its `packages` says where the
  code comes from.
- **Who owns shared code.** The source that published it first. A run publishes sources in id
  order, whatever order `--source` names them in, so on a fresh backfill the owner is the first
  source by id whose build produced the code.
- **Roles agree.** The role a source's `contractRoles` gives shared code must be the owner's
  entry's `role` and `implementationSlots`. Otherwise the run fails and publishes nothing, and its
  alert names both configs. The entry is write-once, so the fix is normally in the publishing
  source's `contractRoles`. Within one source, roles aren't rechecked: a proxy added to
  `contractRoles` after its first build was published keeps its old entry, and failing every
  later build that contains it would leave no way forward.
- **The range invariant spans sources.** Entries of one code length mask the same bytes, whichever
  source they are in, apart from reviewed pairs. Every source's `reviewedRangePairs` counts for
  every check, so a pair from two sources goes in either source's config. The conflict report
  names each entry's source and the configs the pair can go in.
- **Every listed fingerprint has an entry.** Each fingerprint in a tag or branch file has an entry
  in some source (`ci-check`).

### Rebuilding tags: `rebuild.yml`

`rebuild.ts` shows that a source's published tags reproduce. It rebuilds each tag from scratch,
at the commit its tag file records and with the build profile that commit selects, and compares
the fingerprints with the tag file. `--tag` names tags; `--all` takes every tag file of the
source, building a commit that several tags share once. It prints one JSON report on stdout: per
tag, the commit, profile, contract count, whether it reproduced, and a build failure or the
contracts that differ. It exits 0 if every tag reproduced, 1 if any differs or fails to build, and
2 if it can't run (an unknown source or tag, or no tag files). It writes nothing to the data; build
logs are under the work directory, in `logs/<source>/<commit>.fresh.log`.

`rebuild.yml` (manual) runs it in CI, on the same toolchain as publish. Inputs: `source`
(required) and `tag` (empty for every tag file). It has read-only permissions and never pushes.
The run's summary lists each tag's result, and the report and build logs are uploaded as the
`rebuild-report` artifact. It reads the data at the ref it runs on, so a data branch can be
checked before its PR merges:

```sh
gh workflow run rebuild.yml --ref <branch> -f source=<id>                       # every tag file of the source
gh workflow run rebuild.yml --ref main -f source=nitro-contracts -f tag=v3.2.0   # one tag
```

GitHub only dispatches a workflow that is on the default branch; the run then uses the branch's
copy of the workflow and of the data.

### Backfill

Three settings in `config/<source>/sources.json` let the registry cover releases older than its
start tag. Each is a selector over source commits, and the run applies them per tag.

**Which tags are published: `start`.** A tag is published when its commit is `start.tag`'s or
descends from it, prereleases included. With `start.releasesFrom`, so is every release tag (a
semver version with no prerelease part) at or above that version, wherever its commit is. For
nitro-contracts, `{"tag": "v3.2.0", "releasesFrom": "v3.0.0"}` adds `v3.0.0`, `v3.1.0` and
`v3.1.1`; `v3.1.1` is on a side branch, not an ancestor of `v3.2.0`. Prereleases before
`v3.2.0` stay out: `v3.0.1-beta.*`, `v3.1.0-qol` and `v3.2.0-beta.0`. Branch heads must still
descend from `start.tag`.

**How each commit is built: `builds[].when`.** The first profile whose `when` matches the commit
builds it. A selector can require `descendantOf`, `notDescendantOf`, `refs`, and `tags`: a
published tag at the commit whose semver version is at least `tags.from` and below
`tags.before`, by semver precedence. A commit that no profile matches fails the run ("no build
profile matches commit"), so a tag is never built with settings meant for other releases.
nitro-contracts has two profiles, both on Node 24, Foundry v1.9.0 and yarn 1.22.22:

| Profile | Selects | Outputs |
|---|---|---|
| `hardhat-foundry-0.8.17` | descendants of `v3.2.0` | Hardhat (deployed), Foundry (parity with Hardhat only), Foundry Yul profile (deployed) |
| `hardhat-0.8.17-v3.0-v3.1` | tags `>= v3.0.0` and `< v3.2.0` | Hardhat (deployed), Foundry Yul profile (deployed); no parity check |

The `v3.0`-`v3.1` profile has no Foundry parity output, because those releases' Foundry build
isn't the deployed build. Their `foundry.toml` doesn't pin solc, so Foundry compiles the `^0.8.x`
pragmas with the newest solc (0.8.34 today), not 0.8.17. It also sets `evm_version = 'cancun'`
and lacks Hardhat's per-file optimizer runs (20 for `RollupUserLogic`, 200 for
`EdgeChallengeManager`). Their deploy scripts use the Hardhat artifacts. The repo's own parity
check (`yarn test:bytecodes`, from PR #358) first ships in `v3.2.0`.

The Yul profile is deployed: the deploy scripts read `out/yul/Reader4844.yul/Reader4844.json`.
Its commands follow the releases' own `build:forge:yul` script, with two changes:

- **`--skip '*.sol'`**: the releases' Yul profile doesn't skip Solidity, and builds the tests
  without their remappings.
- **`--no-lint`**: Foundry v1.9.0's lint step fails on Yul.

The Yul build also sets `FOUNDRY_SOLC_VERSION=0.8.24`. Unpinned, Foundry would compile it with
whatever solc is newest, so the fingerprint would change with each solc release. Every solc from
0.8.23 on compiles it to the same 87 bytes, identical to the `Reader4844` that Arbitrum One's
SequencerInbox uses (`0x15b25E3f…d4ca`).

**Which commits get a test-chain check: `testChains.when`.** For nitro-contracts it is
`{"descendantOf": ["v3.2.0"]}`, because the deployer targets `v3.2.0`'s `createRollup`. A
published commit outside it is built and published without the check, and not silently: each run
lists it in `checksSkipped` (commit, refs, reason), logs `test-chain check skipped for <refs>`,
and names it in the data commit's message. `check.ts --rev` refuses such a commit.

**Going further back.** Lower `start.releasesFrom`; that one line is the range rule. Then:

1. Make a profile cover the new tags: widen `tags.from` if the toolchain still works, or add a
   profile.
2. Check that `contractRoles` lists every proxy and proxy admin those builds produce, under its
   exact name. Entries are write-once, and the role is copied in when one is written.
3. Check that each new tag equals `v` + `package.json` version, or allowlist it.

The run checks the range invariant against every existing entry of every source, as for any new
tag.

## Manual entries

A manual entry is for code that no published ref builds: a one-off or patched build deployed
somewhere. Arbitrum One's Bridge implementation (`0xfE4749061Fb052c354aaC65b9Fb0cCD7e20D2418`, on
Ethereum) is one. Its entry has the label `v3.1.0-callfilter`, which `getVersion` reports unless a
tag later builds the same code, and a null `ref` and `commit`. Publish never builds or rewrites a
manual entry.

To add one:

1. Build the contract. The build must reproduce the deployed bytecode exactly, so use the build
   the deployment used: its source, solc version and settings (optimizer runs, `evmVersion`,
   `viaIR`, metadata hash). These may differ from the source's build profiles in `sources.json`.
2. Run `add-entry` on the build output, with the address of a deployed instance. This Bridge, for
   example, matches only a Foundry build with the metadata hash turned off
   (`bytecode_hash = 'none'`), so the example reads what `forge build --build-info` writes:

   ```sh
   node tools/src/cli/add-entry.ts --source nitro-contracts --checkout /path/to/checkout \
     --build-info out/build-info --layout standard-json \
     --contract src/bridge/Bridge.sol:Bridge \
     --rpc $RPC --address 0xfE4749061Fb052c354aaC65b9Fb0cCD7e20D2418 \
     --label v3.1.0-callfilter --notes 'Arbitrum One Bridge implementation, a patched build based on v3.1.0'
   ```

   `--build-info`, `--layout` and `--artifacts` are as in a `sources.json` output, relative to
   `--checkout`. A Hardhat build takes `--layout hardhat` and `--artifacts`. `--source` is
   required, with no default: it picks the entry's directory (`registry/<source>/entries/`), its
   `repo` and the `contractRoles` its role comes from, and the entry is write-once. `--block`
   defaults to `latest`.
3. Check what it prints: `getVersion` should give your label and the source's repo (here
   `v3.1.0-callfilter OffchainLabs/nitro-contracts`; a one-slot proxy gives its implementation's
   version and repo), and any names it lists must be public (see below).
4. Run `node tools/src/cli/ci-check.ts --base origin/main`, commit on a branch and open a PR.

`add-entry` extracts the contract as publish does, and writes nothing unless the result matches the
code at the address. On a mismatch it prints both lengths and metadata trailers, and where the code
before the trailers differs. A trailer that differs alone usually means another metadata hash
setting; a different solc version or code means other settings or source. It also refuses a
missing label, a label that is a published tag of the source, a fingerprint that already has an
entry in any source (it names that source and what its entry reports), and an entry that breaks
the range invariant, checked against every source's entries (see "Across sources"). The role
comes from `contractRoles` and `packages` from the checkout, as in publish. It then writes the
entry, regenerates `registry/by-length/` and `registry/index.json`, and prints the entry's path,
its fingerprint and what `getVersion` reports for the address. It builds nothing and commits
nothing.

`--ref` and `--commit` default to null. Set them only for a build of a public commit: `--ref` must
point at `--commit` in the source repo at its `url` in `sources.json`, and the checkout must be at
that commit with no changes to tracked files.

**Private source.** If the build comes from a private repo, nothing that identifies it may appear
in the entry, its label or notes, the commit message, or config: not the repo's name, a branch,
commit, author or commit message, nor a file, contract or function name that only exists there.
Never add a private repo to `sources.json`. Fields derived from the bytecode are fine, since the
deployed code is public on chain. The names in `contracts`, `getters` and `maskedRanges` come from
the source, not the bytecode, so `add-entry` lists any that no other entry, of any source, has.
Before committing, grep the diff and the commit message for the private repo's identifiers.

**Trust.** CI checks the schema, the generated views, one entry per fingerprint, range conflicts
across sources and that entries are append-only. Nothing rebuilds a manual entry. Its correctness
rests on the person who added it; the on-chain match when `add-entry` writes it is the check.

## Changes

**Layout v2 and one lookup across sources (2026-11).** One break for every client that reads
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
  `getStorageAt`. Unknown code is also probed at the beacon slot when its EIP-1967 slot is zero.
- Out-of-scope keys can name a contract (`L1WethGateway.l2Weth()`) as well as be a bare getter
  signature.
