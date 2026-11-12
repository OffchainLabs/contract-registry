# contract-registry (prototype)

Identifies which release, or which commit, of an Offchain Labs contract repo a deployed contract
was built from, using only a standard RPC (`eth_getCode`, `eth_getStorageAt`, `eth_call`).
CI builds the source repos, fingerprints every deployable contract, and publishes the results here
as static JSON. A reference walker discovers and identifies every contract of a chain.

Design: `contract-registry-spec.md` (BLK-491). Status: local prototype; not yet a GitHub repo
(open item O1). Sources: `nitro-contracts`, from tag `v3.2.0` onward.

## Fingerprints

A contract's fingerprint is keccak256 of its runtime code with every immutable and the trailing
CBOR metadata section zeroed. On-chain code matches an entry when it has the entry's length and the
same hash after masking with the entry's ranges. The immutables read from the matched code are
reported as variant values (`maxDataSize`, `isUsingFeeToken`, `isDelayBufferable`, ...).

## Layout

```
config/<source>/sources.json                  how to fetch, build and check the source repo
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
# identify one contract
node tools/src/cli/lookup.ts --rpc $RPC --address 0x...
# walk a chain from any core contract (JSON on stdout)
node tools/src/cli/walk.ts --rpc $RPC --start <rollup or inbox> [--registry github:<owner>/<repo>@main]
```

From TypeScript: `import { walk, Registry, openSource, Rpc } from '<this repo>/walker'` (run
`npm run build:walker` to emit `dist/`).

## Publishing

Everything runs here ("pull" model); the source repos need no CI or credentials.

- `publish.yml` (schedule, manual): builds every new commit on a published branch in history order
  (so `firstCommit` is exact), rebuilds every new tag from scratch and checks it reproduces its
  commit, writes entries, tag and branch files, regenerates the views, deploys test chains from
  each new head and tag and walks them, and lands everything as one commit.
- `reconcile.yml` (daily): the same run, plus an alert for any published ref that should already
  have been processed.
- `ci.yml` (every push and PR): schemas, generated files match their inputs, `entries/` and `tags/`
  are append-only.

Failures open or update one GitHub issue per failure kind and source repo, and close it once every
item is resolved. Locally, `--alerts local:<dir>` writes the same alerts as JSON files.

```sh
node tools/src/cli/publish.ts --source nitro-contracts [--reconcile] [--push] [--alerts github:<owner>/<repo>]
node tools/src/cli/check.ts --rev develop        # test-chain check of one commit, writes nothing
node tools/src/cli/rebuild.ts --tag v3.2.0       # rebuild a tag and compare with its tags/ file
node tools/src/cli/ci-check.ts --base origin/main
npm test && npm run test:integration
```
