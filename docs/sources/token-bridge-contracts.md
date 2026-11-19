# token-bridge-contracts

`OffchainLabs/token-bridge-contracts` builds the token bridge: the gateway routers and gateways of
both chains, the child chain's tokens (`StandardArbERC20`, `aeWETH`) and their beacon, and the
Orbit creator (`L1AtomicTokenBridgeCreator`, `L2AtomicTokenBridgeFactory`). The registry covers its
release history from `v1.0.1-beta.0`: `start` is `{"tag": "v1.0.1-beta.0"}`, so 15 `v*` tags are
published, `v1.0.1-beta.0` to `v1.2.5`, prereleases included, and the heads of `release-main`,
`release-1.1.1` and `hotfix/add-sbom-export`. `v1.1.0-alpha.0` and `v1.1.0-alpha.1` are on a side
branch, so they stay out. Every tag equals `v` + `package.json` version.

What real chains run, and the version `getVersion` reports for it:

| Code | Version |
|---|---|
| Arbitrum One's and Nova's canonical bridge (deployed 2021 to 2023 from an older repo): router and gateway logic on both chains, `StandardArbERC20`, Nova's aeWETH, Arbitrum One's proxy admins and beacon, and the DAO's reverse gateways for ARB | `v1.0.1-beta.0`: that code is only in the `v1.0.1-beta.*` prereleases |
| The creators' L1 and L2 templates (Ethereum and Arbitrum One), and the routers and gateways of the Orbit chains created from them (still in 2026) | `v1.1.0` |
| The creators' `L2AtomicTokenBridgeFactory` template | `v1.2.0` |
| The creators (Ethereum, Arbitrum One, Nova) and their `L1TokenBridgeRetryableSender` | `v1.2.2` |

Two contracts of Arbitrum One's 2021 bridge are older than any tag and unknown: its aeWETH logic
(`0x8b194bEa…`) and its `BeaconProxyFactory` (`0x3fE38087…`). Nova's proxies, beacon and
`BeaconProxyFactory` come from a 2022 build that no tag reproduces; the logic behind its proxies is
known, so `getVersion` reaches it through the slot probe for unknown code. Arbitrum One's
Classic-era core proxies on Ethereum (its Inbox `0x4Dbd4fc5…`, among others) were compiled from the
same OpenZeppelin 3.4.2 `TransparentUpgradeableProxy` with the same settings as `v1.0.1-beta.*`, so
they match that entry: `lookup` reports token bridge proxy code, `getVersion` reports the
nitro-contracts logic behind it, and a nitro-contracts walk lists them in
`summary.otherRepoInScope`.

- **Two profiles, Hardhat only**, both on Node 24 and yarn 1.22.22:

  | Profile | Selects | Builds |
  |---|---|---|
  | `hardhat-0.6.11-oz3` | commits that don't descend from `v1.1.0-beta.0` | `v1.0.1-beta.*` and `release-main`: gateways at solc 0.6.11, OpenZeppelin 3.4.2 |
  | `hardhat-0.8.16-oz4` | descendants of `v1.1.0-beta.0` that don't descend from `3f643a0c` | `v1.1.0-beta.0` to `v1.2.5`, `release-1.1.1` and `hotfix/add-sbom-export`: solc 0.8.16, OpenZeppelin 4.8.3 |

  The Hardhat build is the deployed one: the deploy scripts use its artifacts. There's no Foundry
  parity output. The repo builds with `bytecodeHash: ipfs`, so the two toolchains' raw bytes
  differ, and three factories embed other contracts' creation code, metadata hash included, so
  even their masked code differs.
- **The YBB guard.** `3f643a0c` ("add L1YbbBridgeDeployer lib", 2026-02-05, on `develop`) set
  `foundry.toml` to 200 optimizer runs, while Hardhat stays at 100. No published ref contains it
  yet. A release that does matches no profile and fails the run, so its deployed toolchain gets
  decided before anything of it is published.
- **Setup.** `yarn install --ignore-scripts`, because a `v1.0.1-beta.*` dependency's postinstall
  fails (`phantomjs-prebuilt`); no tag has install scripts of its own. Submodules are fetched over
  HTTPS (`git -c url.https://github.com/.insteadOf=git@github.com: submodule update ...`): the
  tags from `v1.1.0-beta.0` to `v1.2.0` point `lib/nitro-contracts` at an SSH URL, which CI can't
  clone. The output sets `INTERFACE_TESTER_SOLC_VERSION` to empty: when it is set, the Hardhat
  config adds that solc to its compilers, which would change the compiler of every `^0.8` file.
- **Excludes.** Tests and mocks (`contracts/tokenbridge/test/**` and the test directories), and
  other sources' code, which publish would refuse (see
  [Across sources](../publishing.md#across-sources)):
  `@offchainlabs/upgrade-executor/**` (the repo compiles its own copy of `UpgradeExecutor`, never
  deployed), `@arbitrum/nitro-contracts/**`, and `lib/**`, which holds the `lib/nitro-contracts`
  submodule.
- **Roles.** OpenZeppelin's `TransparentUpgradeableProxy`, `UpgradeableProxy` (3.4.2) and
  `ERC1967Proxy` (4.8.3) are proxies at the EIP-1967 slot; `ProxyAdmin` and `UpgradeableBeacon`
  are proxy admins. OpenZeppelin's `BeaconProxy` and the repo's `ClonableBeaconProxy`, which
  compile to one fingerprint, are beacon proxies, so a bridged token reports its beacon's
  implementation: Arbitrum One's LINK (`0xf97f4df7…`) reports `v1.0.1-beta.0`, from
  `StandardArbERC20`.
- **Test chains** from `v1.1.1` on (see [Test chains](../publishing.md#test-chains)): every tag
  from `v1.1.1` to `v1.2.5` and the head of `hotfix/add-sbom-export` pass. Older releases are
  published without the check; their out-of-scope list was checked by walking real chains (below).

**Which commits get a test-chain check: `testChains.when`.** For token-bridge-contracts it is
`{"descendantOf": ["v1.1.1"]}`: the `v1.0.1-beta.*` releases have no creator, and up to `v1.1.0`,
`deployL1TokenBridgeCreator` estimates the child chain's factory deployment on a live child chain
(Arbitrum's NodeInterface), which an anvil doesn't have. [Backfill](README.md#backfill) explains
the setting.

**Out of scope.** The token bridge is mostly pointers to the other chain, so its list
(`config/token-bridge-contracts/out-of-scope-getters.json`) is long:

- addresses on the other chain: `counterpartGateway()`, `l2BeaconProxyFactory()`,
  `canonicalL2FactoryAddress()`, `l1Address()`, the `v1.1.x` creators' `getCanonicalL2*(uint256)`,
  and `L1WethGateway.l2Weth()`. On the child chain, `L2WethGateway.l2Weth()` is that chain's own
  aeWETH, so it stays in scope;
- other repos and external code: `inbox()` (nitro-contracts), `owner()` (an upgrade executor or an
  account), `l1Weth()` (WETH9), `l1USDC()` and `l2USDC()`;
- accounts: `burner()`, `usdcOwnershipTransferrer()`, `getCurrentBlockCoinbase()`, and the legacy
  `whitelist()`;
- the creator's child-chain templates (`l2RouterTemplate()`, ...): code to copy, initialised with
  placeholder addresses (`0x…dEaD`). They are still identified, as leaves. Likewise the beacon's
  `UpgradeableBeacon.implementation()`, the `StandardArbERC20` logic that bridged tokens run: code,
  not an instance, so its own getters are unset. It is identified as a leaf, and as each bridged
  token's implementation;
- zero by design: a router's own `router()` (`L1GatewayRouter`, `L1OrbitGatewayRouter`,
  `L2GatewayRouter`). A gateway's `router()` stays in scope.

Walks from Arbitrum One's routers (Ethereum and Arbitrum One), its WETH gateways and LINK, both
creators, Nova's routers and a 2026 Orbit chain's router match every in-scope contract except
Arbitrum One's two 2021 ones and Nova's 2022 proxies, beacon and factory; no in-scope getter
reaches an account.
