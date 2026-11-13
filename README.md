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
import { openSource, Registry, Rpc } from '<this repo>/walker'

// openSource resolves `main` to a commit once, so every file is read from one snapshot.
const registry = new Registry(await openSource('github:<owner>/<repo>@main'), 'nitro-contracts')
const version = await registry.getVersion(new Rpc(rpcUrl), address) // e.g. 'v3.2.0', or null
```

`getVersion` does this:

```
EIP1967_IMPLEMENTATION_SLOT   = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
SECONDARY_IMPLEMENTATION_SLOT = 0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d

getVersion(rpc, address) -> string | null:
  entry = lookup(rpc.getCode(address))
  if entry == null:              # unknown code: maybe a proxy the registry doesn't have
    if rpc.getStorageAt(address, SECONDARY_IMPLEMENTATION_SLOT) != 0:
      return null                # a two-slot proxy (an old RollupProxy): no version of its own
    return implementationVersion(rpc, address, EIP1967_IMPLEMENTATION_SLOT)
  if entry.role == "proxy" and len(entry.implementationSlots) == 1:
    return implementationVersion(rpc, address, entry.implementationSlots[0])
  return versionOf(entry)        # logic, proxy admins, and two-slot proxies report themselves

implementationVersion(rpc, proxy, slot) -> string | null:
  impl = lastTwentyBytes(rpc.getStorageAt(proxy, slot))
  if impl is zero or has no code: return null
  implEntry = lookup(rpc.getCode(impl))
  return implEntry ? versionOf(implEntry) : null

versionOf(entry) -> string:
  releases = [t for t in entry.tags if not isPrerelease(t)]   # tags are in semver order
  if releases:   return releases[0]
  if entry.tags: return entry.tags[0]
  if entry.label: return entry.label                         # a manual entry
  return entry.ref + "@" + entry.commit[:12]                 # e.g. release-3.3.0@abcdef012345

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
- Code in no release gives its first prerelease tag.
- Code in no tag at all was built only as the head of a release or hotfix branch. It gives
  `<ref>@<first 12 hex digits of commit>`, the branch and head commit it was first built from,
  e.g. `release-3.3.0@abcdef012345`. That commit contains the code, but isn't necessarily the first
  commit that does: only branch heads are built. Once a tag contains the code, the tag wins.
- A manual entry with no tag gives its label.
- Unknown code may be a proxy the registry doesn't have, in front of logic it does: on Arbitrum
  One, for example, most proxies are early nitro-contracts builds, and the Inbox proxy an Arbitrum
  Classic build. So unknown code is probed at the EIP-1967 implementation slot and, like a one-slot
  proxy, reports the version of the implementation there. That is safe for any unknown code:
  every nitro-contracts proxy uses that standard slot, and the fallback can only return a version
  if the slot holds code the registry recognises.
- Unknown code whose secondary slot is set is a two-slot proxy (an old `RollupProxy`) and gives
  null, since a two-slot proxy reports its own version, which here is unknown. The secondary slot
  is read first, so such a proxy never reports the admin logic in its EIP-1967 slot.
- Unknown code gives null if neither slot is set, or the implementation is unknown or has no code.
  So does a one-slot proxy whose slot is zero or whose implementation is unknown or has no code.

For more than a version: `registry.lookup(code)` returns the matched entry (contracts, role, tags,
`ref`, `commit`, ...), and `decodeImmutables(code, entry)` reads its immutables (`maxDataSize`,
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
- `ref` and `commit`: the ref the entry was first built from, and the commit it pointed at then.
  `ref` is a tag (`v3.2.0`) or a release or hotfix branch whose head was built (`release-3.3.0`).
  Only tags and branch heads are built, never a branch's earlier commits, so `commit` contains the
  code but isn't necessarily the earliest commit that does. When a new tag and a new branch head
  bring the same new code in one run, the entry names the tag. Entries are write-once: code first
  built from a release branch keeps naming that branch after a tag includes it (the tag shows in
  the entry's `tags` in `by-length/`) and after the branch is deleted. A manual entry, which has a
  `label`, may have a null `ref` or `commit`.
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
<source>/entries/<fingerprint>.json           one per distinct fingerprint; write-once
<source>/tags/<tag>.json                      contract -> fingerprint for a tag's build; write-once
<source>/branches/<branch>.json               same for the head of a live release or hotfix branch;
                                              overwritten, and removed with the branch
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
proxy-admin code isn't probed. Code the registry doesn't know (for example a release older than
the registry's range, or a one-off build like Arbitrum One's patched Bridge) is probed at the
EIP-1967 slot and, if that is set, at the secondary slot.

`summary.tags` is the intersection of the tag sets of the matched in-scope logic code: the releases
the deployment is consistent with. Proxies and proxy admins are still identified in the nodes, but
left out of the summary: upgrades replace implementations, never proxies, so after an upgrade to a
release that changed proxy code they would empty the intersection. `summary.matchedInScope` counts
every role.

## Publishing

Everything runs here ("pull" model); the source repos need no CI or credentials.

- `publish.yml` (schedule, manual): builds every new `v*` tag in range (see "Backfill"), and the
  head of every `release-*` and `hotfix*` branch whose head has changed. Nothing else is built: not
  `main` or `develop`, and not a release or hotfix branch's earlier commits. Each new tag is built
  from scratch, with the build profile its commit selects. If its
  commit was also built as a release or hotfix head (recorded in a branch file, or built in the
  same run), the tag build must reproduce that build's fingerprints; otherwise there is nothing to
  compare it with. The run writes entries, tag files and branch files (a deleted branch's file is
  removed; its entries stay), checks that entries of one code length mask the same bytes (so no
  code can match two; a conflict fails the whole run, and its alert says how to review the pair
  and list it in `reviewedRangePairs`), regenerates the views, deploys test chains from each new
  tag and changed head in the check's range and walks them, and lands everything as one commit.
  It checks that each new tag equals `v` + `package.json` version at its commit; a mismatch is
  published anyway and raises an alert until the tag is listed in `tagValidation.allowlist`.
  The test-chain check
  requires all in-scope code, proxies and proxy admins included, to match an entry from that
  commit's build. It also reads both known implementation slots on every matched contract, and
  fails if one holds an address the walk didn't read: a proxy missing from `contractRoles`.
- `reconcile.yml` (daily): the same run, plus an alert for any published ref that should already
  have been processed.
- `ci.yml` (every push and PR): schemas, generated files match their inputs, the range invariant
  (with `reviewedRangePairs`), `entries/` and `tags/` are append-only.

Failures open or update one GitHub issue per failure kind and source repo, and close it once every
item is resolved. A build or test-chain failure at a branch head also resolves once the branch has
a newer head or is deleted, since only current heads are built. Locally, `--alerts local:<dir>`
writes the same alerts as JSON files.

```sh
node tools/src/cli/publish.ts --source nitro-contracts [--reconcile] [--push] [--alerts github:<owner>/<repo>]
node tools/src/cli/check.ts --rev v3.2.0         # test-chain check of one commit, writes nothing
node tools/src/cli/rebuild.ts --tag v3.2.0       # rebuild a tag and compare with its tags/ file
node tools/src/cli/ci-check.ts --base origin/main
npm test && npm run test:integration
```

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

The run checks the range invariant against every existing entry, as for any new tag.
