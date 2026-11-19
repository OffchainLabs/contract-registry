# Publishing

How CI builds the source repos and publishes the registry, and the rules it checks.

Everything runs here ("pull" model); the source repos need no CI or credentials.

- `publish.yml` (schedule, manual): builds every new `v*` tag in range (see
  [Backfill](sources/README.md#backfill)), and the head of every `release-*` and `hotfix*` branch whose head has changed. Nothing else is built: not
  `main` or `develop`, and not a release or hotfix branch's earlier commits. Each new tag is built
  from scratch, with the build profile its commit selects. If its
  commit was also built as a release or hotfix head (recorded in a branch file, or built in the
  same run), the tag build must reproduce that build's fingerprints; otherwise there is nothing to
  compare it with. The run writes entries (for code no source has an entry for yet; see
  [Across sources](#across-sources)), tag files and branch files (a deleted branch's file is
  removed; its entries stay), checks that entries of one code length mask the same bytes, in every source (so no code can
  match two; a conflict fails the whole run, and its alert says how to review the pair and list it
  in `reviewedRangePairs`), regenerates the views, deploys test chains from each new
  tag and changed head in the check's range and walks them (see [Test chains](#test-chains)), and
  lands everything as one commit.
  It checks that each new tag equals `v` + `package.json` version at its commit; a mismatch is
  published anyway and raises an alert until the tag is listed in `tagValidation.allowlist`.
  The test-chain check
  requires all in-scope code, proxies and proxy admins included, to match an entry from that
  commit's build. It also reads the known slots (EIP-1967's implementation and beacon slots, and the
  secondary slot, plus any other slot the source's `contractRoles` lists) on every matched
  contract, and fails if one that its entry doesn't list holds an address: a proxy missing from
  `contractRoles`, or listed with the wrong slots.
- `reconcile.yml` (daily): the same run, plus an alert for any published ref that should already
  have been processed.
- `ci.yml` (every push and PR): schemas; no two sources share an id, a repo or an npm package; each source's
  `outOfScopeGetters` is `config/<source>/out-of-scope-getters.json`, the file the walker reads
  (publish's test-chain check reads the field); nothing outside the layout (a source's directory
  at the top of the repo, or anything in `registry/` but configured sources, `by-length/` and
  `index.json`); generated files match their inputs; one entry per fingerprint across sources,
  and an entry for every fingerprint a tag or branch file lists; shared code's role agrees with
  its owner's entry in every source's `contractRoles`; no source's entries, tags or branches have
  another source's package code; the range invariant across sources (with
  every source's `reviewedRangePairs`); `entries/` and `tags/` files are append-only. Append-only compares content with the base, so a file moved into
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

## Across sources

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
  entry's `role`, `implementationSlots` and `beaconSlot`. Otherwise the run fails and publishes
  nothing, and its alert names both configs. `ci-check` applies the same rule to every fingerprint
  a source's tag and branch files list whose entry another source owns, so a later change to
  either config can't break it unnoticed. The entry is write-once, so the fix is normally in the
  publishing source's `contractRoles`. Within one source, roles aren't rechecked: a proxy added to
  `contractRoles` after its first build was published keeps its old entry, and failing every
  later build that contains it would leave no way forward.
- **The range invariant spans sources.** Entries of one code length mask the same bytes, whichever
  source they are in, apart from reviewed pairs. Every source's `reviewedRangePairs` counts for
  every check, so a pair from two sources goes in either source's config. The conflict report
  names each entry's source and the configs the pair can go in.
- **Every listed fingerprint has an entry.** Each fingerprint in a tag or branch file has an entry
  in some source (`ci-check`).
- **A source never publishes another source's code.** A build compiles its dependencies too, and
  some are other sources: the token bridge installs `@arbitrum/nitro-contracts` and
  `@offchainlabs/upgrade-executor`, and has nitro-contracts as the submodule `lib/nitro-contracts`.
  Published, that code would get entries with this source's repo and versions, built with its
  settings. Each source lists the npm package names its code is installed under in `npmPackages`
  (required: its `package.json` name, every name it has had, or `[]` for a repo with no package;
  no two sources may list the same one): `@arbitrum/nitro-contracts`,
  `@arbitrum/token-bridge-contracts` and `@offchainlabs/upgrade-executor`. A contract a build
  would fingerprint is another source's code when its file is anywhere inside another source's
  package or repo:
  - it was compiled from an installed package (the `packages` field) that is one of that source's
    `npmPackages`, by the name in the installed `package.json`, so an npm alias counts;
  - its path names one of those packages at its start (a Hardhat import name, or a copy at the top
    of the repo) or after a `node_modules/` directory (Foundry's names, nested installs); or
  - it is in a git submodule, nested ones included, whose URL in `.gitmodules` is that source's
    `repo` on GitHub (HTTPS, SSH or relative).

  Publish refuses such a build before writing anything: the run fails (`publish-error`) and
  publishes nothing, and its message names each contract, the package or submodule, the source it
  belongs to and the exclude to add to the build profile (the package or submodule directory and
  `/**`, e.g. `@offchainlabs/upgrade-executor/**` or `lib/**`). This holds for shared code too, so
  the tag or branch file doesn't list it either. Publish also fails while a built commit's
  `package.json` name isn't in its own source's `npmPackages`, so a new or renamed package can't
  go unlisted. `add-entry` refuses a contract from another source's package or repo and names the
  `--source` it belongs to. `ci-check` checks the data: no entry's `packages`, and no contract
  name in an entry, tag or branch file, names another source's package. It can't see submodules
  (the data doesn't record them); publish checks those when it builds. A file vendored some other
  way, copied into the repo's own directories, isn't recognised: excludes still need review.

## Test chains

The test-chain check deploys a source's contracts from the commit being published on local anvil
nodes, walks them with the registry, and fails on in-scope code that doesn't match an entry from
that commit's build, on an in-scope getter that returns zero, on a probed slot holding an address
the walk didn't read, and on a walk that can't complete. A source's `testChains.deployer` names its
deployer, `tools/src/testchain/<deployer>.ts`. It runs its scripts (`tools/testchain/<deployer>/`)
inside the built checkout, so the deployment comes from that commit's own deploy code and
artifacts, and returns the walks: for each, a name, the address it starts from and the node it
reads. Each walk's problems are reported under its name. A result is cached per commit, keyed by
`CHECK_VERSION`, the source's out-of-scope list and the deployer's code (its module, the helpers
the deployers share, `common.ts`, and its scripts).

- **nitro-contracts** deploys the RollupCreator with the commit's deploy scripts, creates four
  rollups (ETH or ERC20 fee token, delay-bufferable or not) with every optional address set, and
  walks each from its rollup. The deployment takes under 20 seconds.
- **token-bridge-contracts** needs a parent chain with a rollup, and a child chain that executes
  retryable tickets. Two token bridges and 25 walks up to `v1.2.5` (four and 50 with the
  yield-bearing bridges on `develop`); deploying and walking takes about 10 seconds.
  - *Parent chain.* One anvil. The creator and its templates come from the commit's own
    `deployL1TokenBridgeCreator` (`scripts/atomicTokenBridgeDeployer.ts`). Each variant gets the
    parent side of a rollup: nitro-contracts' `Bridge` and `Inbox` (`ERC20Bridge` and `ERC20Inbox`
    with a fee token) behind proxies, the rollup's `ProxyAdmin` and `UpgradeExecutor`, and a
    stand-in for the rollup contract that answers `owner()` and `chainId()`, the only calls the
    creator makes to it. The nitro-contracts artifacts come from the npm release
    `@arbitrum/nitro-contracts@1.1.1` (its integrity hash is checked), not the checkout's, whose
    version varies by tag.
  - *Variants.* ETH and an ERC20 fee token, plus the yield-bearing bridge of each where the
    creator has `createYbbTokenBridge`. The deployer creates a token bridge for each, and deposits a
    token through each ETH router; on a yield-bearing bridge, the deposit also deploys the token's
    MasterVault on the parent chain.
  - *Child chains.* One anvil per variant, with the rollup's chain id, replays the retryables the
    variant's Inbox recorded, in order: each from its sender (aliased by the Inbox) by
    impersonation, to its destination or, if that is zero, as a contract creation, as ArbOS runs
    them. So the child side is what the creator's own retryables deploy, at the addresses the
    creator predicted, which the deployer checks. The child anvils run Prague, not Osaka: Osaka's
    per-transaction gas cap (2^24) is barely above the transaction that deploys the child side
    (15.4M gas at `v1.2.5`).
  - *Walks.* From the creator; each variant's parent-chain contracts (`inboxToL1Deployment`: router
    and gateways); its child-chain contracts (`inboxToL2Deployment`, the factory and the bridged
    token); and the MasterVault. Before `v1.2.0` the creator keeps no such record, so the
    addresses come from its `OrbitTokenBridgeCreated` event and its `getCanonicalL2*(chainId)`, as
    those releases' own deploy script collects them. Two are left out: the parent chain's WETH
    (external code) and the child chain's upgrade executor (upgrade-executor's logic behind a token
    bridge proxy; walks reach it through `owner()`, as a leaf).

Each deployer has a CLI that deploys from a built checkout and prints the addresses as JSON:
`node tools/src/testchain/<deployer>-cli.ts --checkout <dir> [--keep]`.

## Rebuilding tags: `rebuild.yml`

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
