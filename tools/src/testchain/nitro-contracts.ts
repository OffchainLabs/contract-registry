// Deploys nitro-contracts test chains on a local anvil node for the test-chain check (spec §5.8).
//
// Runs tools/testchain/nitro-contracts/deploy-testchains.ts inside a built nitro-contracts
// checkout with the checkout's own Hardhat, so the RollupCreator, its templates and the chains all
// come from that commit's deploy scripts and build artifacts. The checkout needs `node_modules`,
// the Hardhat build (`build/contracts`, `build/types`) and the Yul build (`out/yul`).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANVIL_DEPLOYER_KEY, checkAddressMap, isAddress, requireFiles, runCheckoutScript, startAnvil, type Address } from './common.ts'

export type { Address }

export interface TestChain {
  /** e.g. 'eth-bufferable', 'erc20-nonbufferable' */
  name: string
  variant: { feeToken: 'eth' | 'erc20'; delayBufferable: boolean }
  /** Parent-chain block of the createRollup transaction. */
  blockNumber: number
  /** Where the test-chain check walks from: the rollup (`contracts.rollup`). */
  start: Address
  /**
   * Every address in the creator's RollupCreated event except nativeToken: rollup, inbox, outbox,
   * rollupEventInbox, challengeManager, adminProxy (the ProxyAdmin of the bridge contracts),
   * sequencerInbox, bridge, upgradeExecutor, validatorWalletCreator.
   */
  contracts: Record<string, Address>
  /**
   * Every address-valued createRollup param, all non-zero (owner and loserStakeEscrow are
   * required, the rest optional), keyed by param name with arrays as `name[i]`: stakeToken, owner,
   * loserStakeEscrow, anyTrustFastConfirmer, validators[0] (a ValidatorWallet), validators[1],
   * batchPosters[0], batchPosterManager, customOsp, and on ERC20 chains nativeToken and
   * feeTokenPricer. Plus customDAValidator, the custom OSP's OneStepProverHostIo arg.
   */
  optional: Record<string, Address>
}

export interface TestChainDeployment {
  rpcUrl: string
  chainId: number
  /** pid of the anvil process; `stop()` kills it. */
  anvilPid: number
  creator: Address
  /**
   * The creator's templates as returned by deployAllContracts (bridgeCreator, osp, prover0, ...),
   * the BridgeCreator's `ethBasedTemplates.<field>` / `erc20BasedTemplates.<field>`, and reader4844.
   */
  templates: Record<string, Address>
  chains: TestChain[]
  stop(): Promise<void>
}

export interface DeployTestChainsOptions {
  /** A built nitro-contracts checkout. Only a temporary copy of the deploy script is written to it. */
  checkoutDir: string
  /** anvil port; a free one is picked if omitted. */
  port?: number
  /** Receives anvil and Hardhat progress lines. */
  log?: (s: string) => void
  /**
   * Start anvil detached so it outlives this process (for the CLI's --keep). Otherwise anvil is
   * also killed when this process exits.
   */
  detach?: boolean
}

/**
 * The parent chain's id. deploymentUtils.ts deploys the real Reader4844 (Yul) only when the chain
 * id is 1 or 11155111; on any other non-Arbitrum chain it passes 0x…dead to the SequencerInbox
 * templates, an address with no code that the walker could not identify. The node is local, and
 * its deployer key is public anyway, so reusing Sepolia's id exposes nothing.
 */
const PARENT_CHAIN_ID = 11155111

/**
 * anvil's hardfork, pinned rather than left to anvil's default, which moves with the Foundry
 * version. Foundry v1.9.0 defaults to Amsterdam, where deploying SequencerInbox (21.9 KB of code)
 * through the create2 factory costs ~34.3M gas, over anvil's 30M block gas limit (Amsterdam
 * reprices state creation, EIP-8037), so estimateGas fails with "execution reverted". Under Osaka
 * it costs ~4.8M, as under v1.8's default (Bpo2, Osaka's EVM with other blob parameters). anvil
 * v1.8 and v1.9 both accept the name.
 */
const ANVIL_HARDFORK = 'osaka'

const DEPLOY_SCRIPT = fileURLToPath(
  new URL('../../testchain/nitro-contracts/deploy-testchains.ts', import.meta.url)
)

export async function deployTestChains(opts: DeployTestChainsOptions): Promise<TestChainDeployment> {
  const log = opts.log ?? (() => {})
  const checkoutDir = path.resolve(opts.checkoutDir)
  const hardhatBin = path.join(checkoutDir, 'node_modules', '.bin', 'hardhat')
  await requireFiles(checkoutDir, [
    hardhatBin,
    path.join(checkoutDir, 'scripts', 'deploymentUtils.ts'),
    path.join(checkoutDir, 'build', 'contracts'),
    path.join(checkoutDir, 'out', 'yul', 'Reader4844.yul', 'Reader4844.json'),
  ])

  const anvil = await startAnvil({
    port: opts.port,
    chainId: PARENT_CHAIN_ID, // see PARENT_CHAIN_ID
    hardfork: ANVIL_HARDFORK, // see ANVIL_HARDFORK
    // v3.2.0's deploymentUtils.create2() waits for 2 confirmations (tx.wait(2)). With anvil's
    // default automine a second block never comes, so also mine an empty block every 0.5s.
    extraArgs: ['--mixed-mining', '--block-time', '0.5'],
    detach: opts.detach,
    log,
  })
  const rpcUrl = anvil.rpcUrl
  try {
    // --no-compile: use the checkout's existing build and leave its build/cache untouched.
    // The `custom` network is defined in the checkout's hardhat.config.ts from these env vars.
    const raw = await runCheckoutScript({
      checkoutDir,
      script: DEPLOY_SCRIPT,
      scriptDir: 'scripts',
      command: scriptRel => ({ cmd: hardhatBin, args: ['run', '--no-compile', '--network', 'custom', scriptRel] }),
      env: { CUSTOM_RPC_URL: rpcUrl, CUSTOM_PRIVKEY: ANVIL_DEPLOYER_KEY, DISABLE_VERIFICATION: 'true' },
      timeoutMs: HARDHAT_TIMEOUT_MS,
      log,
      onSignal: anvil.kill,
    })
    const out = parseOutput(raw)
    if (out.chainId !== PARENT_CHAIN_ID) {
      throw new Error(`deploy script saw chain id ${out.chainId}, expected ${PARENT_CHAIN_ID}`)
    }
    return { rpcUrl, anvilPid: anvil.pid, ...out, stop: anvil.stop }
  } catch (err) {
    await anvil.stop()
    throw err
  }
}

/** A full deploy takes under 20s; this only stops a hung run (e.g. a wait for a block that never comes). */
const HARDHAT_TIMEOUT_MS = 5 * 60_000

type ScriptOutput = Pick<TestChainDeployment, 'chainId' | 'creator' | 'templates' | 'chains'>

function parseOutput(raw: unknown): ScriptOutput {
  const o = raw as ScriptOutput
  const fail = (what: string): never => {
    throw new Error(`deploy script output: bad ${what}`)
  }
  if (typeof o?.chainId !== 'number') fail('chainId')
  if (!isAddress(o.creator)) fail('creator')
  checkAddressMap(o.templates, 'templates', fail)
  if (!Array.isArray(o.chains) || o.chains.length === 0) fail('chains')
  for (const c of o.chains) {
    if (typeof c.name !== 'string') fail('chain name')
    if (c.variant?.feeToken !== 'eth' && c.variant?.feeToken !== 'erc20') fail(`${c.name}.variant`)
    if (typeof c.variant.delayBufferable !== 'boolean') fail(`${c.name}.variant`)
    if (typeof c.blockNumber !== 'number') fail(`${c.name}.blockNumber`)
    checkAddressMap(c.contracts, `${c.name}.contracts`, fail)
    checkAddressMap(c.optional, `${c.name}.optional`, fail)
  }
  const chains = o.chains.map(c => ({ ...c, start: c.contracts.rollup }))
  for (const c of chains) if (!isAddress(c.start)) fail(`${c.name}.contracts.rollup`)
  return { chainId: o.chainId, creator: o.creator, templates: o.templates, chains }
}
