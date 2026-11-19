# Manual entries

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
missing label, a label that is a published tag of the source, another source's code (from its npm
package or a submodule of its repo; it names the `--source` the contract belongs to), a
fingerprint that already has an entry in any source (it names that source and what its entry
reports), and an entry that breaks the range invariant, checked against every source's entries
(see [Across sources](publishing.md#across-sources)). The role comes from `contractRoles` and `packages` from the checkout, as in publish. It then writes the
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
