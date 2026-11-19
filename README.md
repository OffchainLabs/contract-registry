# contract-registry

Identifies which release, or which commit, of an Offchain Labs contract repo a deployed contract
was built from, using only a standard RPC (`eth_getCode`, `eth_getStorageAt`, `eth_call`).
CI builds each source repo's tags and the heads of its release and hotfix branches, fingerprints
every deployable contract, and publishes the results here as static JSON. A reference walker
discovers and identifies every contract of a chain.

## Quick start

The version of Arbitrum One's rollup on Ethereum, from the command line (Node 22.18 or later):

```sh
npm ci
ETH=https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY   # any Ethereum RPC
node tools/src/cli/version.ts --rpc $ETH --address 0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0
# v3.0.0 OffchainLabs/nitro-contracts
```

The same from TypeScript:

```ts
import { Registry, Rpc } from '<this repo>/walker'

const registry = await Registry.open()   // this repo's main branch, resolved to one commit
const v = await registry.getVersion(new Rpc(rpcUrl), '0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0')
// { version: 'v3.0.0', repo: 'OffchainLabs/nitro-contracts' }
```

## What's covered

| Source | Repo | Range |
|---|---|---|
| [nitro-contracts](docs/sources/nitro-contracts.md) | `OffchainLabs/nitro-contracts` | releases from `v3.0.0`, and every tag from `v3.2.0` |
| [token-bridge-contracts](docs/sources/token-bridge-contracts.md) | `OffchainLabs/token-bridge-contracts` | every tag from `v1.0.1-beta.0` |
| [upgrade-executor](docs/sources/upgrade-executor.md) | `OffchainLabs/upgrade-executor` | every tag from `v1.0.0` |

The heads of each source's release and hotfix branches are built too. Code that no published ref
builds, such as a one-off or patched build, is added by hand as a
[manual entry](docs/manual-entries.md).

## How it works

- Every release is built and fingerprinted, with the bytes filled in at deploy time masked
  ([Fingerprints](docs/data-format.md#fingerprints)).
- `getVersion` looks up the code at an address and follows proxies and beacons to the
  implementation ([How `getVersion` works](docs/usage.md#how-getversion-works)).
- GitHub Actions publish new tags and changed branch heads every 15 minutes
  ([Publishing](docs/publishing.md)).
- A version is the earliest release in the registry's range that contains the code
  ([What a version means](docs/usage.md#what-a-version-means)).

<details>
<summary>Usage in depth</summary>

**Importing.** `<this repo>/walker` is this package's `./walker` export; `npm run build:walker`
emits it to `dist/`. In a checkout, on Node 22.18 or later, you can import
`tools/src/walker/index.ts` directly.

**Opening a registry.** `Registry.open(spec)` opens one snapshot of the registry. A branch or tag
is resolved to a commit once, so every file comes from that commit, and a push during a run can't
mix old and new data. One registry covers every source: a lookup searches all of them.

| `spec` | Reads |
|---|---|
| omitted | `github:OffchainLabs/contract-registry@main` |
| `github:<owner>/<repo>@<ref>` | a branch or tag on GitHub, resolved to its commit (`ref` defaults to `main`) |
| `github:<owner>/<repo>@<commit>` | that commit, given as 40 hex digits: pin one to read the same data every time |
| `git:<path>@<rev>` | a local clone at a commit (`rev` defaults to `HEAD`) |
| `dir:<path>`, or a bare path | a directory as it is now |

**Getting a version.** `registry.getVersion(rpc, address, block = 'latest')` returns
`{ version, repo }`, or null. `repo` is the source repo, e.g. `OffchainLabs/nitro-contracts`; it is
needed because tag names overlap across repos. `version` is the first of these that the code has:

1. its first release tag, such as `v3.0.0`: the earliest release in the registry's range that
   contains the code;
2. its first prerelease tag, such as `v1.0.1-beta.0`;
3. a manual entry's label, such as `v3.1.0-callfilter`;
4. `<branch>@<commit>`, for code built only as a release or hotfix branch head, such as
   `release-3.3.0@abcdef012345`.

A proxy with one implementation slot, and a beacon proxy, report their implementation's version
and repo. Logic, proxy admins and the two-slot proxies (`RollupProxy`, `AdminFallbackProxy`)
report their own. Unknown code is probed at the standard EIP-1967 slots, since it may be a proxy
the registry doesn't have, in front of logic it does.

**Looking up code.** `registry.lookup(code)` takes runtime code as a `Uint8Array` and returns the
one entry it matches, of any source (`repo`, `contracts`, `role`, `tags`, `ref`, `commit`, ...), or
null. It doesn't follow proxies. `decodeImmutables(code, entry)` reads the matched code's
immutables.

**Walking a chain.** `walk({ start, rpc, registry })` finds every contract reachable from `start`
through its getters, identifies each, and returns `{ nodes, warnings, summary, ... }`. Options:
`source`, the id of the source the walk belongs to (default: the source of the start contract's
logic); `outOfScope`, the getters not to follow (default: the source's list); `blockNumber`
(default: the latest block).

```ts
import { Registry, Rpc, walk, decodeImmutables } from '<this repo>/walker'
import { hexToBytes, type Hex } from 'viem'

const registry = await Registry.open('github:OffchainLabs/contract-registry@main')
const rpc = new Rpc(rpcUrl)
const rollup = '0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0'

const code = hexToBytes((await rpc.getCode(rollup, 'latest')) as Hex)
const entry = await registry.lookup(code)        // RollupProxy, tags v3.0.0, v3.1.0, v3.1.1
const immutables = entry && decodeImmutables(code, entry)
const result = await walk({ start: rollup, rpc, registry })
console.log(result.summary.tags)                 // []: see "Reading a walk's summary" below
```

**The `rpc`.** `new Rpc(url)` is a small JSON-RPC client. It runs up to 8 requests at a time, and
retries rate limits, server errors and timeouts. `walk` needs an `Rpc`. `getVersion` takes any
object with these three methods, so you can wrap another client:

```ts
getCode(address: string, block: string): Promise<string>                     // eth_getCode
getStorageAt(address: string, slot: string, block: string): Promise<string>  // eth_getStorageAt
call(to: string, data: string, block: string): Promise<string>               // eth_call
```

`call` is only used to ask a beacon for its `implementation()`. When the call reverts, it must
throw `ExecutionError` (exported, and what `Rpc` throws). Any other error is passed on.

**Null, and what throws.** Null is an answer, not a failure: the code at the address, or the
implementation it leads to, matches no entry. That covers an address with no code; code older
than a source's range, or that no source builds; a proxy whose implementation slot is zero; a
beacon proxy whose beacon slot is zero, or whose beacon's `implementation()` reverts; and unknown
code with the secondary slot set (an old `RollupProxy`), which has no version of its own. These
throw instead:

- A snapshot with no `registry/index.json`, such as a commit of this repo from before layout v2
  (2026-11-16), or an index with another `schemaVersion`. Every lookup throws, rather than answer
  null for everything:

  ```
  Error: https://raw.githubusercontent.com/OffchainLabs/contract-registry/bfdc32b8… is not a layout-v2 registry snapshot: it has no registry/index.json
  ```

- An RPC request that still fails after its retries (`RpcError`).
- A registry file that can't be fetched: `github:` reads are retried, five attempts in all.
- A walk whose source can't be inferred from its start: pass `source`.

**CLIs.** Each reads the registry in this checkout unless given `--registry <spec>` (the specs of
`Registry.open`), and reads the latest block unless given `--block`. `version` and `lookup` search
every source.

`version` prints what `getVersion` gives. With one address it prints `<version> <repo>`; with
several, one line per address. It exits 0 if every address has a version, 1 if any is unknown
(one address prints `unknown` on stderr), and 2 on bad arguments.

```sh
$ node tools/src/cli/version.ts --rpc $ETH --address 0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0 \
    --address 0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a --address 0x0000000000000000000000000000000000000001
0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0 v3.0.0 OffchainLabs/nitro-contracts
0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a v3.1.0-callfilter OffchainLabs/nitro-contracts
0x0000000000000000000000000000000000000001 unknown
```

`lookup` identifies the code at each address itself, without following proxies. It prints JSON:
per address, the code's length and hash, and the matched entry as `match` (or null), with its
`repo`, `version`, `tags` and `immutables`. `--code 0x...` looks up code without an RPC.

```sh
$ node tools/src/cli/lookup.ts --rpc $ETH --address 0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0
[ { "address": "0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0", "codeLength": 5171, ...,
    "match": { "repo": "OffchainLabs/nitro-contracts", "contracts": ["src/rollup/RollupProxy.sol:RollupProxy"],
               "role": "proxy", ..., "version": "v3.0.0", "tags": ["v3.0.0", "v3.1.0", "v3.1.1"], ... } } ]
```

`walk` starts from a rollup, inbox or token bridge router and prints one JSON document: `nodes`
(each contract found, its code's match and its implementations), `warnings` (unknown code,
implementations with no code, reverted or conflicting getters) and `summary`. `--source <id>` names
the source the walk belongs to, and `--out-of-scope <file>` replaces its list of getters not to
follow. A walk of Arbitrum One from its rollup takes a few seconds:

```sh
$ node tools/src/cli/walk.ts --rpc $ETH --start 0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0 | jq .summary
{
  "tags": [],
  "matchedInScope": 20,
  "unknownInScope": 10,
  "untaggedInScope": ["0xfE4749061Fb052c354aaC65b9Fb0cCD7e20D2418"],
  "otherRepoInScope": [
    { "address": "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f", "repo": "OffchainLabs/token-bridge-contracts", "version": "v1.0.1-beta.0" },
    ...
  ]
}
```

**Reading a walk's summary.** In-scope code is what the walk reached through getters that aren't
in the source's out-of-scope list. Each count is of pieces of code: a contract's own code and its
implementations.

- `tags`: the releases of the walk's repo that contain all of its matched in-scope logic: the
  releases the deployment is consistent with. Proxies and proxy admins are left out, since
  upgrades replace logic, never proxies. Empty means no one release has it all.
- `untaggedInScope`: matched logic of the walk's repo that is in no tag, such as a manual entry or
  a branch head's build. Each one empties `tags`. Here it is Arbitrum One's Bridge implementation,
  the manual entry `v3.1.0-callfilter`.
- `matchedInScope` and `unknownInScope`: in-scope code, of every role and repo, that the registry
  knows and doesn't. Here most of the unknown code is older than the registry's range, such as
  Arbitrum One's core proxies; the logic behind them is known.
- `otherRepoInScope`: in-scope code matched to another repo, with that repo's version. It never
  counts in `tags`. Here, Arbitrum One's Classic-era proxies, whose code matches the OpenZeppelin
  proxy that token-bridge-contracts `v1.0.1-beta.0` builds.

Each node in `nodes` has its `code`, whose `status` is `matched` (with the entry as `match`),
`unknown` or `no-code`, and for a proxy its `implementation` and `secondaryImplementation`,
identified the same way.

Everything else, including each case `getVersion` handles and how a walk picks its source, is in
[docs/usage.md](docs/usage.md).

</details>

## Documentation

- [Usage](docs/usage.md): `getVersion` step by step, the CLIs, and walks.
- [Data format](docs/data-format.md): fingerprints, entries and the file layout.
- [Publishing](docs/publishing.md): the workflows, the rules that hold across sources, test chains
  and rebuilding tags.
- [Sources](docs/sources/README.md): how ranges and build profiles are set, and a page per source:
  [nitro-contracts](docs/sources/nitro-contracts.md),
  [token-bridge-contracts](docs/sources/token-bridge-contracts.md) and
  [upgrade-executor](docs/sources/upgrade-executor.md).
- [Manual entries](docs/manual-entries.md): adding code that no published ref builds.
- [Changelog](CHANGELOG.md).

Design: `contract-registry-spec.md` (BLK-491).

## Development

```sh
npm ci
npm test
npm run typecheck
node tools/src/cli/ci-check.ts --base origin/main
```

`npm run test:integration` runs a publish end to end against a throwaway clone of this repo. The
commands that publish, check and rebuild are in [Publishing](docs/publishing.md).
