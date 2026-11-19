// Deploys token bridges on local anvil nodes for the test-chain check (spec §5.8).
//
// A token bridge spans a parent chain and a child chain, and its child side is deployed by
// retryable tickets that the parent chain only records. So:
//   1. On a parent anvil, tools/testchain/token-bridge-contracts/deploy-testchains.ts runs inside a
//      built token-bridge-contracts checkout with its ts-node. It deploys the creator with the
//      checkout's own deploy code, stands up the parent side of one rollup per variant (ETH, an
//      ERC20 fee token, and the yield-bearing bridge of each where the creator has one), creates a
//      token bridge for each and deposits a token on the ETH ones.
//   2. For each variant, a child anvil with the rollup's chain id replays the retryables the
//      variant's Inbox recorded, in order: each is sent from its sender (already aliased by the
//      Inbox) by impersonation, to its destination or, if that is zero, as a contract creation,
//      as ArbOS executes them. So the child side is what the creator's own retryables deploy, at
//      the addresses the creator predicted.
// The check then walks the creator, and each variant's contracts on both chains (and, on a
// yield-bearing bridge, the deposited token's vault).
//
// The checkout needs `node_modules`, the Hardhat build (`build/contracts`) and its typechain
// output (`build/types`). The parent side of the rollups uses nitro-contracts' Bridge and Inbox
// from a pinned npm release (NITRO_CONTRACTS), downloaded and checked against its integrity hash.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, getAddress, keccak256, parseAbi, toEventSelector, type Hex } from 'viem'
import { ANVIL_DEPLOYER_KEY, checkAddressMap, isAddress, requireFiles, runCheckoutScript, startAnvil, type Address, type Anvil } from './common.ts'

export type { Address }

/** One walk of the check: a name (`<variant>-<parent|child>:<contract>`, or `creator`), where it starts, and the node. */
export interface Walk { name: string; start: Address; rpcUrl: string }

export interface Variant {
  /** 'eth', 'erc20', 'eth-ybb' or 'erc20-ybb' */
  name: string
  feeToken: 'eth' | 'erc20'
  /** Created with createYbbTokenBridge (a yield-bearing bridge). */
  ybb: boolean
  childChainId: number
  childRpcUrl: string
  childAnvilPid: number
  /** The parent side of the rollup the bridge belongs to. */
  rollup: Address
  bridge: Address
  inbox: Address
  proxyAdmin: Address
  upgradeExecutor: Address
  nativeToken?: Address
  /** The creator's `canonicalL2FactoryAddress()`: the child chain's L2AtomicTokenBridgeFactory. */
  l2Factory: Address
  /** The creator's `inboxToL1Deployment(inbox)` and `inboxToL2Deployment(inbox)`, without zeros. */
  l1: Record<string, Address>
  l2: Record<string, Address>
  /**
   * Deposited tokens: on the parent chain, their bridged tokens on the child chain and, on a
   * yield-bearing bridge, their vaults on the parent chain.
   */
  tokens: { l1: Address; l2: Address; vault?: Address }[]
  /** The retryables replayed on the child chain, in order. */
  retryables: { sender: Address; to: Address | null; transactionHash: Hex }[]
}

export interface TestChainDeployment {
  /** The parent chain. */
  rpcUrl: string
  chainId: number
  anvilPid: number
  creator: Address
  retryableSender: Address
  variants: Variant[]
  /** The check's walks (`TestChainDeployer` calls them chains). */
  chains: Walk[]
  /** Stops every anvil. */
  stop(): Promise<void>
}

export interface DeployTestChainsOptions {
  /** A built token-bridge-contracts checkout. Only a temporary copy of the deploy script is written to it. */
  checkoutDir: string
  /** Receives anvil and deploy script progress lines. */
  log?: (s: string) => void
  /** Start the anvils detached so they outlive this process (for the CLI's --keep). */
  detach?: boolean
}

/**
 * The nitro-contracts release whose Bridge and Inbox stand in for a rollup's parent side: the
 * version the token bridge pins from v1.2.2 on, and the first with the ERC20 (fee token) bridge.
 */
export const NITRO_CONTRACTS = {
  version: '1.1.1',
  tarball: 'https://registry.npmjs.org/@arbitrum/nitro-contracts/-/nitro-contracts-1.1.1.tgz',
  integrity: 'sha512-4Tyk3XVHz+bm8UujUC78LYSw3xAxyYvBCxfEX4z3qE4/ww7Qck/rmce5gbHMzQjArEAzAP2YSfYIFuIFuRXtfg==',
}

const PARENT_CHAIN_ID = 31337

/**
 * The parent anvil's hardfork, pinned as the nitro-contracts deployer's is (anvil's default moves
 * with the Foundry version).
 */
const PARENT_HARDFORK = 'osaka'

/**
 * The child anvils' hardfork. Not Osaka: its per-transaction gas cap (EIP-7825, 2^24) is below
 * what deploying the whole child side in one retryable costs on an Ethereum EVM. An Arbitrum
 * chain prices that transaction its own way; the child chain here only has to run it.
 */
const CHILD_HARDFORK = 'prague'
const CHILD_GAS_LIMIT = 100_000_000

/** A full deploy takes well under a minute; this only stops a hung run. */
const SCRIPT_TIMEOUT_MS = 5 * 60_000

const DEPLOY_SCRIPT = fileURLToPath(new URL('../../testchain/token-bridge-contracts/deploy-testchains.ts', import.meta.url))

/** Contracts the check doesn't start a walk from. */
const NOT_STARTS = {
  // The parent chain's WETH: external code (a test WETH9 here).
  l1: new Set(['weth']),
  // The child chain's upgrade executor: a token bridge proxy in front of upgrade-executor's
  // logic, which the commit's build doesn't contain. Walks reach it through owner(), as a leaf.
  l2: new Set(['upgradeExecutor']),
}

export async function deployTestChains(opts: DeployTestChainsOptions): Promise<TestChainDeployment> {
  const log = opts.log ?? (() => {})
  const checkoutDir = path.resolve(opts.checkoutDir)
  const tsNode = path.join(checkoutDir, 'node_modules', '.bin', 'ts-node')
  await requireFiles(checkoutDir, [
    tsNode,
    path.join(checkoutDir, 'scripts', 'atomicTokenBridgeDeployer.ts'),
    path.join(checkoutDir, 'build', 'contracts'),
    path.join(checkoutDir, 'build', 'types'),
    path.join(checkoutDir, 'node_modules', '@offchainlabs', 'upgrade-executor', 'build', 'contracts', 'src', 'UpgradeExecutor.sol', 'UpgradeExecutor.json'),
  ])

  const anvils: Anvil[] = []
  const stop = async () => { await Promise.all(anvils.map(a => a.stop())) }
  const nitroDir = mkdtempSync(path.join(tmpdir(), 'registry-nitro-contracts-'))
  try {
    const nitroArtifacts = await fetchNitroContracts(nitroDir, log)
    const parent = await startAnvil({ chainId: PARENT_CHAIN_ID, hardfork: PARENT_HARDFORK, detach: opts.detach, log })
    anvils.push(parent)
    const raw = await runCheckoutScript({
      checkoutDir,
      script: DEPLOY_SCRIPT,
      scriptDir: 'scripts',
      command: scriptRel => ({ cmd: tsNode, args: [scriptRel] }),
      // Transpile only, as Hardhat runs scripts: the checkout's scripts aren't all type-correct.
      env: { TS_NODE_TRANSPILE_ONLY: 'true', PARENT_RPC_URL: parent.rpcUrl, DEPLOYER_KEY: ANVIL_DEPLOYER_KEY, NITRO_ARTIFACTS: nitroArtifacts },
      timeoutMs: SCRIPT_TIMEOUT_MS,
      log,
      onSignal: () => anvils.forEach(a => a.kill()),
    })
    const out = parseOutput(raw)
    if (out.chainId !== PARENT_CHAIN_ID) throw new Error(`deploy script saw chain id ${out.chainId}, expected ${PARENT_CHAIN_ID}`)

    const variants: Variant[] = []
    for (const v of out.variants) {
      const child = await startAnvil({ chainId: v.childChainId, hardfork: CHILD_HARDFORK, extraArgs: ['--gas-limit', String(CHILD_GAS_LIMIT)], detach: opts.detach, log })
      anvils.push(child)
      log(`${v.name}: replaying retryables on chain ${v.childChainId}`)
      const retryables = await replayRetryables(parent.rpcUrl, child.rpcUrl, v.bridge, v.inbox, log)
      // The first retryable deploys the factory at the address the creator predicted.
      if (retryables[0]?.to !== null || retryables[0].contractAddress !== v.l2Factory) {
        throw new Error(`${v.name}: the first retryable didn't deploy the child chain's factory at ${v.l2Factory}`)
      }
      for (const [what, a] of [['l2Factory', v.l2Factory], ...Object.entries(v.l2).map(([k, x]) => [`l2.${k}`, x]), ...v.tokens.map((t, i) => [`tokens[${i}].l2`, t.l2])]) {
        if ((await rpc<Hex>(child.rpcUrl, 'eth_getCode', [a, 'latest'])) === '0x') throw new Error(`${v.name}: no code at ${what} ${a} on the child chain after the retryables`)
      }
      for (const [i, t] of v.tokens.entries()) {
        if (t.vault && (await rpc<Hex>(parent.rpcUrl, 'eth_getCode', [t.vault, 'latest'])) === '0x') throw new Error(`${v.name}: no code at tokens[${i}].vault ${t.vault} on the parent chain`)
      }
      variants.push({
        ...v,
        childRpcUrl: child.rpcUrl,
        childAnvilPid: child.pid,
        retryables: retryables.map(r => ({ sender: r.sender, to: r.to, transactionHash: r.transactionHash })),
      })
    }

    const chains: Walk[] = [{ name: 'creator', start: out.creator, rpcUrl: parent.rpcUrl }]
    for (const v of variants) {
      for (const [k, a] of Object.entries(v.l1)) if (!NOT_STARTS.l1.has(k)) chains.push({ name: `${v.name}-parent:${k}`, start: a, rpcUrl: parent.rpcUrl })
      chains.push({ name: `${v.name}-child:factory`, start: v.l2Factory, rpcUrl: v.childRpcUrl })
      for (const [k, a] of Object.entries(v.l2)) if (!NOT_STARTS.l2.has(k)) chains.push({ name: `${v.name}-child:${k}`, start: a, rpcUrl: v.childRpcUrl })
      for (const [i, t] of v.tokens.entries()) {
        const n = v.tokens.length > 1 ? String(i) : ''
        chains.push({ name: `${v.name}-child:token${n}`, start: t.l2, rpcUrl: v.childRpcUrl })
        if (t.vault) chains.push({ name: `${v.name}-parent:vault${n}`, start: t.vault, rpcUrl: parent.rpcUrl })
      }
    }
    return { rpcUrl: parent.rpcUrl, chainId: out.chainId, anvilPid: parent.pid, creator: out.creator, retryableSender: out.retryableSender, variants, chains, stop }
  } catch (err) {
    await stop()
    throw err
  } finally {
    rmSync(nitroDir, { recursive: true, force: true })
  }
}

/** Downloads the pinned nitro-contracts package into `dir`, checks its hash, and returns its `build/contracts`. */
async function fetchNitroContracts(dir: string, log: (s: string) => void): Promise<string> {
  log(`fetching @arbitrum/nitro-contracts@${NITRO_CONTRACTS.version}`)
  const res = await fetch(NITRO_CONTRACTS.tarball)
  if (!res.ok) throw new Error(`fetching ${NITRO_CONTRACTS.tarball}: HTTP ${res.status}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  if (integrity !== NITRO_CONTRACTS.integrity) throw new Error(`${NITRO_CONTRACTS.tarball} has integrity ${integrity}, expected ${NITRO_CONTRACTS.integrity}`)
  const file = path.join(dir, 'package.tgz')
  writeFileSync(file, tgz)
  execFileSync('tar', ['-xzf', file, '-C', dir])
  return path.join(dir, 'package', 'build', 'contracts')
}

// --- Retryables ----------------------------------------------------------------------------------

const BRIDGE_EVENTS = parseAbi(['event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)'])
const INBOX_EVENTS = parseAbi(['event InboxMessageDelivered(uint256 indexed messageNum, bytes data)'])
const MESSAGE_DELIVERED = toEventSelector(BRIDGE_EVENTS[0])
const INBOX_MESSAGE_DELIVERED = toEventSelector(INBOX_EVENTS[0])
/** nitro-contracts' L1MessageType_submitRetryableTx. */
const SUBMIT_RETRYABLE = 9

/** A retryable ticket as the Inbox records it, with the sender the Bridge recorded (aliased). */
export interface Retryable {
  messageIndex: bigint
  sender: Address
  /** Null for a contract creation (a zero destination). */
  to: Address | null
  l2CallValue: bigint
  deposit: bigint
  maxSubmissionCost: bigint
  excessFeeRefundAddress: Address
  callValueRefundAddress: Address
  gasLimit: bigint
  maxFeePerGas: bigint
  data: Hex
}

/**
 * Decodes a retryable's message data, as the Inbox encodes it: abi.encodePacked of the destination,
 * l2CallValue, deposit, maxSubmissionCost, excessFeeRefundAddress, callValueRefundAddress, gasLimit,
 * maxFeePerGas and data.length (each a 32-byte word), then data.
 */
export function decodeRetryable(messageIndex: bigint, sender: Address, messageData: Hex): Retryable {
  const hex = messageData.slice(2)
  const word = (i: number) => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`)
  const addr = (i: number) => {
    const w = word(i)
    if (w >> 160n) throw new Error(`retryable ${messageIndex}: word ${i} isn't an address`)
    return getAddress(`0x${w.toString(16).padStart(40, '0')}`)
  }
  if (hex.length < 9 * 64) throw new Error(`retryable ${messageIndex}: message data too short (${hex.length / 2} bytes)`)
  const dataLength = word(8)
  if (BigInt(hex.length / 2) !== 9n * 32n + dataLength) throw new Error(`retryable ${messageIndex}: data length ${dataLength} doesn't match the message (${hex.length / 2} bytes)`)
  const to = addr(0)
  return {
    messageIndex, sender: getAddress(sender), to: BigInt(to) === 0n ? null : to,
    l2CallValue: word(1), deposit: word(2), maxSubmissionCost: word(3),
    excessFeeRefundAddress: addr(4), callValueRefundAddress: addr(5), gasLimit: word(6), maxFeePerGas: word(7),
    data: `0x${hex.slice(9 * 64)}`,
  }
}

/** Every message the Bridge recorded from `inbox`, joined with its data from the Inbox, in order. Fails on anything but a retryable. */
export async function parentRetryables(rpcUrl: string, bridge: Address, inbox: Address): Promise<Retryable[]> {
  const logs = (address: Address, topic: Hex) => rpc<{ topics: [Hex, ...Hex[]]; data: Hex }[]>(rpcUrl, 'eth_getLogs', [{ address, topics: [topic], fromBlock: '0x0', toBlock: 'latest' }])
  const data = new Map<bigint, Hex>()
  for (const l of await logs(inbox, INBOX_MESSAGE_DELIVERED)) {
    const e = decodeEventLog({ abi: INBOX_EVENTS, ...l })
    data.set(e.args.messageNum, e.args.data)
  }
  const out: Retryable[] = []
  for (const l of await logs(bridge, MESSAGE_DELIVERED)) {
    const { args } = decodeEventLog({ abi: BRIDGE_EVENTS, ...l })
    if (getAddress(args.inbox) !== getAddress(inbox)) continue
    if (args.kind !== SUBMIT_RETRYABLE) throw new Error(`message ${args.messageIndex} has kind ${args.kind}; the replay handles only retryables (${SUBMIT_RETRYABLE})`)
    const d = data.get(args.messageIndex)
    if (d === undefined) throw new Error(`message ${args.messageIndex}: the Inbox logged no data`)
    if (keccak256(d) !== args.messageDataHash) throw new Error(`message ${args.messageIndex}: data doesn't match the hash the Bridge recorded`)
    out.push(decodeRetryable(args.messageIndex, args.sender, d))
  }
  return out.sort((a, b) => (a.messageIndex < b.messageIndex ? -1 : 1))
}

/**
 * Executes each of the parent chain's retryables for `inbox` on the child chain, in order: from
 * its sender, by impersonation, with its call value, to its destination or as a contract creation.
 * Gas is the child node's estimate, not the ticket's limit, which is priced for an Arbitrum
 * chain. Fails if one reverts.
 */
export async function replayRetryables(parentRpc: string, childRpc: string, bridge: Address, inbox: Address, log: (s: string) => void = () => {}) {
  const out: (Retryable & { transactionHash: Hex; contractAddress: Address | null })[] = []
  for (const r of await parentRetryables(parentRpc, bridge, inbox)) {
    await rpc(childRpc, 'anvil_setBalance', [r.sender, `0x${(r.deposit + r.l2CallValue + 10n ** 24n).toString(16)}`])
    await rpc(childRpc, 'anvil_impersonateAccount', [r.sender])
    let hash: Hex
    try {
      hash = await rpc<Hex>(childRpc, 'eth_sendTransaction', [{ from: r.sender, ...(r.to ? { to: r.to } : {}), value: `0x${r.l2CallValue.toString(16)}`, data: r.data }])
    } catch (e) {
      throw new Error(`retryable ${r.messageIndex} from ${r.sender} ${r.to ? `to ${r.to}` : '(contract creation)'} fails on the child chain: ${(e as Error).message}`)
    } finally {
      await rpc(childRpc, 'anvil_stopImpersonatingAccount', [r.sender])
    }
    const receipt = await waitForReceipt(childRpc, hash)
    if (receipt.status !== '0x1') {
      // Rerun it as a call on the state before, for the revert reason.
      const tx = await rpc<{ gas: Hex }>(childRpc, 'eth_getTransactionByHash', [hash])
      const before = `0x${(BigInt(receipt.blockNumber) - 1n).toString(16)}`
      const reason = await rpc(childRpc, 'eth_call', [{ from: r.sender, ...(r.to ? { to: r.to } : {}), value: `0x${r.l2CallValue.toString(16)}`, data: r.data, gas: tx.gas }, before]).then(() => 'the call succeeds', (e: Error) => e.message)
      throw new Error(`retryable ${r.messageIndex} from ${r.sender} reverted on the child chain (${hash}, gas used ${BigInt(receipt.gasUsed)} of ${BigInt(tx.gas)}): ${reason}`)
    }
    log(`retryable ${r.messageIndex}: ${r.to ?? 'contract creation'}, gas ${BigInt(receipt.gasUsed)}`)
    out.push({ ...r, transactionHash: hash, contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null })
  }
  return out
}

interface Receipt { status: Hex; contractAddress: Address | null; gasUsed: Hex; blockNumber: Hex }

/** anvil automines, but may answer eth_sendTransaction before the block is in. */
async function waitForReceipt(url: string, hash: Hex): Promise<Receipt> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const r = await rpc<Receipt | null>(url, 'eth_getTransactionReceipt', [hash])
    if (r) return r
    if (Date.now() > deadline) {
      const pool = await rpc(url, 'txpool_status', []).catch(() => null)
      throw new Error(`transaction ${hash} not mined within 30s (txpool ${JSON.stringify(pool)})`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

let rpcId = 0
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } }
  if (body.error) throw new Error(`${method}: ${body.error.message}${body.error.data ? ` (${JSON.stringify(body.error.data).slice(0, 300)})` : ''}`)
  return body.result as T
}

// --- Deploy script output ------------------------------------------------------------------------

type ScriptVariant = Omit<Variant, 'childRpcUrl' | 'childAnvilPid' | 'retryables'>
interface ScriptOutput { chainId: number; creator: Address; retryableSender: Address; variants: ScriptVariant[] }

function parseOutput(raw: unknown): ScriptOutput {
  const o = raw as ScriptOutput
  const fail = (what: string): never => {
    throw new Error(`deploy script output: bad ${what}`)
  }
  if (typeof o?.chainId !== 'number') fail('chainId')
  if (!isAddress(o.creator)) fail('creator')
  if (!isAddress(o.retryableSender)) fail('retryableSender')
  if (!Array.isArray(o.variants) || o.variants.length < 2) fail('variants')
  for (const v of o.variants) {
    if (typeof v.name !== 'string') fail('variant name')
    if (v.feeToken !== 'eth' && v.feeToken !== 'erc20') fail(`${v.name}.feeToken`)
    if (typeof v.ybb !== 'boolean') fail(`${v.name}.ybb`)
    if (!Number.isInteger(v.childChainId)) fail(`${v.name}.childChainId`)
    for (const k of ['rollup', 'bridge', 'inbox', 'proxyAdmin', 'upgradeExecutor', 'l2Factory'] as const) if (!isAddress(v[k])) fail(`${v.name}.${k}`)
    checkAddressMap(v.l1, `${v.name}.l1`, fail)
    checkAddressMap(v.l2, `${v.name}.l2`, fail)
    if (!v.l1.router || !v.l2.router) fail(`${v.name}: no router`)
    if (!Array.isArray(v.tokens)) fail(`${v.name}.tokens`)
    for (const t of v.tokens) if (!isAddress(t.l1) || !isAddress(t.l2) || (t.vault !== undefined && !isAddress(t.vault))) fail(`${v.name}.tokens`)
  }
  return o
}
