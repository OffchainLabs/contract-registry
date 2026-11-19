# nitro-contracts

`OffchainLabs/nitro-contracts` builds an Arbitrum chain's core contracts and the `RollupCreator`
that deploys them. The registry covers every tag from `v3.2.0` onward, plus the releases from
`v3.0.0` on, backfilled. [Backfill](README.md#backfill) explains each setting below.

**Which tags are published: `start`.** For nitro-contracts,
`{"tag": "v3.2.0", "releasesFrom": "v3.0.0"}` adds `v3.0.0`, `v3.1.0` and `v3.1.1`; `v3.1.1` is on
a side branch, not an ancestor of `v3.2.0`. Prereleases before `v3.2.0` stay out:
`v3.0.1-beta.*`, `v3.1.0-qol` and `v3.2.0-beta.0`.

**How each commit is built: `builds[].when`.** nitro-contracts has two profiles, both on Node 24,
Foundry v1.9.0 and yarn 1.22.22:

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
`{"descendantOf": ["v3.2.0"]}`, because the deployer targets `v3.2.0`'s `createRollup`. What the
deployer builds and walks is in [Test chains](../publishing.md#test-chains).

The roles of its proxies and proxy admins are listed under [Entries](../data-format.md#entries).
Arbitrum One's Bridge implementation is a one-off build, added as a
[manual entry](../manual-entries.md).
