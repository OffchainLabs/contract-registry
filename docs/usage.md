# Usage

How to get the version of a deployed contract, identify its code and walk a chain, from TypeScript
or the command line.

## Get a version

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

### What a version means

A version is the earliest release in the registry's range for that source whose build contains
the code: the first non-prerelease tag, else the first prerelease tag, else a manual entry's label,
else `<ref>@<commit>`. So nitro-contracts code unchanged since `v2.1.0` reports `v3.0.0`, the
first release the registry builds, and the token bridge's canonical bridge reports
`v1.0.1-beta.0`, the prerelease that first contains it. [Sources](sources/README.md) gives each
source's range.

### How `getVersion` works

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
  secondary = slot(SECONDARY_IMPLEMENTATION_SLOT)
  if impl or secondary: return { implementation: impl, secondary: secondary }
  return { implementation: beaconImplementation(rpc, slot(EIP1967_BEACON_SLOT)) }

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
  One, for example, many core proxies are early nitro-contracts builds, older than the registry's
  range, and the Arbitrum DAO's upgrade executors sit behind proxy code that no source builds. So
  unknown code is probed at the EIP-1967 implementation slot and, like a one-slot proxy, reports
  the version of the implementation there. If that slot and the secondary slot are both zero, the
  EIP-1967 beacon slot is probed, and a beacon there is asked for its implementation, as for a
  beacon proxy. That is safe for any unknown code: these are the standard slots, and the fallback
  can only return a version if it reaches code the registry recognises.
- Unknown code whose secondary slot is set is a two-slot proxy (an old `RollupProxy`) and gives
  null, whatever its other slots hold, since a two-slot proxy reports its own version, which here
  is unknown. It never reports the admin logic in its EIP-1967 slot, and its beacon slot isn't
  read.
- Unknown code gives null if its EIP-1967 and beacon slots are both zero, or the implementation is
  unknown or has no code. So does a one-slot proxy whose slot is zero or whose implementation is
  unknown or has no code, and a beacon proxy whose beacon slot is zero, whose beacon's
  `implementation()` reverts or returns no address, or whose implementation is unknown or has no
  code.
- A snapshot with no `registry/index.json` (an older commit of this repo, from before layout v2)
  makes every lookup throw, rather than answer null.

## Look up and walk

For more than a version: `registry.lookup(code)` returns the matched entry (`repo`, contracts,
role, tags, `ref`, `commit`, ...), and `decodeImmutables(code, entry)` reads its immutables
(`maxDataSize`, `isUsingFeeToken`, ...). `walk` discovers and identifies every contract of a chain
from one address (below).

```sh
npm ci
# version of the contract at an address, as getVersion gives it (a proxy reports its implementation)
node tools/src/cli/version.ts --rpc $RPC --address 0x...   # prints e.g. "v3.2.0 OffchainLabs/nitro-contracts"; unknown: exit 1
# identify one contract (the code at the address itself, as JSON)
node tools/src/cli/lookup.ts --rpc $RPC --address 0x...
# walk a chain from any core contract (JSON on stdout)
node tools/src/cli/walk.ts --rpc $RPC --start <rollup, inbox or token bridge router> [--source nitro-contracts] [--registry github:<owner>/<repo>@main]
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
older than the registry's range, or a proxy built outside it, like the one in front of the
Arbitrum DAO's upgrade executor on each chain) is probed at the EIP-1967 and secondary slots and,
if both are zero, at the beacon slot.

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
