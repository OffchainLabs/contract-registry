# upgrade-executor

`OffchainLabs/upgrade-executor` builds one contract, `UpgradeExecutor`. The registry covers its
whole release history: `start` is `{"tag": "v1.0.0"}`, so every `v*` tag from `v1.0.0` is
published (`v1.0.0`, `v1.1.0-beta.0`, `v1.1.0`, `v1.1.1-beta.0`, `v1.1.1`), and the heads of
`release-conf` and `hotfix/add-sbom-export`. `v1.0.0-beta.2` is on a side branch from before
`v1.0.0`, so it stays out.

The tags give two fingerprints. `v1.0.0` is the DAO's original 2023 UpgradeExecutor logic on
Ethereum, Arbitrum One and Nova (deployed before the repo existed, from identical code). `v1.1.0`
is what every later tag and both branch heads build, and what every current upgrade executor
runs: the DAO's on all three chains since their 2025 upgrade, and the templates in
nitro-contracts' RollupCreator and the token bridge creator. Its entry's `ref` is
`v1.1.0-beta.0`, the first tag that built it; `getVersion` reports `v1.1.0`, the first release.

- **Allowlist.** `v1.1.0` was tagged later on the `v1.1.0-beta.0` commit, whose `package.json`
  says `1.1.0-beta.0`. Every other tag equals `v` + `package.json` version.
- **One profile, `hardhat-0.8.16`, for every commit.** The Hardhat build (solc 0.8.16, 20000
  optimizer runs) is the deployed one: the npm package ships it, and nitro-contracts' deploy
  scripts use that artifact. The output sets two environment variables so the build doesn't
  depend on its surroundings: `FOUNDRY_PROFILE=default`, because the Hardhat config picks its
  solc settings by that variable; and `TS_NODE_SKIP_PROJECT=true`, because the repo has no
  `tsconfig.json`, so Hardhat's ts-node would load the nearest one above the checkout (this
  repo's, when the work directory is inside it, which fails). The config loads
  `hardhat-foundry`, so `forge` must be installed.
- **No roles, no out-of-scope getters, no test chains** (`testChains: null`). The repo builds no
  proxies, and `UpgradeExecutor` has no address getters, so a walk from it is one node. Its proxy
  always comes from another repo, so it couldn't match the commit's own build, as the check
  requires.

Upgrade executors show up as leaves of other sources' walks: a nitro-contracts rollup's
`owner()` is identified, implementation included, and not expanded (see
[Look up and walk](../usage.md#look-up-and-walk)). An
Orbit chain's upgrade executor is a nitro-contracts `TransparentUpgradeableProxy` in front of
`UpgradeExecutor`, so `getVersion` reports `v1.1.0 OffchainLabs/upgrade-executor` for it (on
Arbitrum One, `0x76a0fd6e…4eb8c`). The DAO's upgrade executors sit behind proxy code that no
source builds, so `getVersion` finds their logic through the EIP-1967 slot probe for unknown
code.
