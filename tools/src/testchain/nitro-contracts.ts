// Deploys nitro-contracts test chains on a local anvil node for the test-chain check (spec §5.8).
//
// Runs tools/testchain/nitro-contracts/deploy-testchains.ts inside a built nitro-contracts
// checkout with the checkout's own Hardhat, so the RollupCreator, its templates and the chains all
// come from that commit's deploy scripts and build artifacts. The checkout needs `node_modules`,
// the Hardhat build (`build/contracts`, `build/types`) and the Yul build (`out/yul`).

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Address = `0x${string}`

export interface TestChain {
  /** e.g. 'eth-bufferable', 'erc20-nonbufferable' */
  name: string
  variant: { feeToken: 'eth' | 'erc20'; delayBufferable: boolean }
  /** Parent-chain block of the createRollup transaction. */
  blockNumber: number
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

/** anvil's default account 0, the deployer. */
export const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/**
 * The parent chain's id. deploymentUtils.ts deploys the real Reader4844 (Yul) only when the chain
 * id is 1 or 11155111; on any other non-Arbitrum chain it passes 0x…dead to the SequencerInbox
 * templates, an address with no code that the walker could not identify. The node is local, and
 * its deployer key is public anyway, so reusing Sepolia's id exposes nothing.
 */
const PARENT_CHAIN_ID = 11155111

const DEPLOY_SCRIPT = fileURLToPath(
  new URL('../../testchain/nitro-contracts/deploy-testchains.ts', import.meta.url)
)

export async function deployTestChains(opts: DeployTestChainsOptions): Promise<TestChainDeployment> {
  const log = opts.log ?? (() => {})
  const checkoutDir = path.resolve(opts.checkoutDir)
  const hardhatBin = path.join(checkoutDir, 'node_modules', '.bin', 'hardhat')
  for (const required of [
    hardhatBin,
    path.join(checkoutDir, 'scripts', 'deploymentUtils.ts'),
    path.join(checkoutDir, 'build', 'contracts'),
    path.join(checkoutDir, 'out', 'yul', 'Reader4844.yul', 'Reader4844.json'),
  ]) {
    await access(required).catch(() => {
      throw new Error(`${required} missing: is ${checkoutDir} an installed and built checkout?`)
    })
  }

  const port = opts.port ?? (await freePort())
  if (opts.port !== undefined) await assertPortFree(port)
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = await startAnvil(port, rpcUrl, opts.detach ?? false, log)

  const tmp = await mkdtemp(path.join(tmpdir(), 'registry-testchain-'))
  const outFile = path.join(tmp, 'out.json')
  const scriptRel = path.join('scripts', `.registry-testchain-${randomBytes(4).toString('hex')}.ts`)
  const scriptAbs = path.join(checkoutDir, scriptRel)
  let killHardhat: (() => void) | undefined
  // A signal would skip the cleanup below and leave the script copy in the checkout.
  const onSignal = (signal: NodeJS.Signals) => {
    killHardhat?.()
    anvil.kill()
    rmSync(scriptAbs, { force: true })
    rmSync(tmp, { recursive: true, force: true })
    process.kill(process.pid, signal)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await copyFile(DEPLOY_SCRIPT, scriptAbs)
    // --no-compile: use the checkout's existing build and leave its build/cache untouched.
    // The `custom` network is defined in the checkout's hardhat.config.ts from these env vars.
    const run = start(
      hardhatBin,
      ['run', '--no-compile', '--network', 'custom', scriptRel],
      checkoutDir,
      {
        CUSTOM_RPC_URL: rpcUrl,
        CUSTOM_PRIVKEY: ANVIL_DEPLOYER_KEY,
        DISABLE_VERIFICATION: 'true',
        REGISTRY_TESTCHAIN_OUT: outFile,
      },
      HARDHAT_TIMEOUT_MS,
      log
    )
    killHardhat = run.kill
    await run.done
    const out = parseOutput(JSON.parse(await readFile(outFile, 'utf8')))
    if (out.chainId !== PARENT_CHAIN_ID) {
      throw new Error(`deploy script saw chain id ${out.chainId}, expected ${PARENT_CHAIN_ID}`)
    }
    return { rpcUrl, anvilPid: anvil.pid, ...out, stop: anvil.stop }
  } catch (err) {
    await anvil.stop()
    throw err
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await rm(scriptAbs, { force: true })
    await rm(tmp, { recursive: true, force: true })
  }
}

/** A full deploy takes under 20s; this only stops a hung run (e.g. a wait for a block that never comes). */
const HARDHAT_TIMEOUT_MS = 5 * 60_000

interface Anvil {
  pid: number
  /** Kills anvil and waits for it to exit. */
  stop(): Promise<void>
  /** Sends the kill signal without waiting. */
  kill(): void
}

async function startAnvil(
  port: number,
  rpcUrl: string,
  detach: boolean,
  log: (s: string) => void
): Promise<Anvil> {
  const args = [
    '--port', String(port),
    '--chain-id', String(PARENT_CHAIN_ID), // see PARENT_CHAIN_ID
    // v3.2.0's deploymentUtils.create2() waits for 2 confirmations (tx.wait(2)). With anvil's
    // default automine a second block never comes, so also mine an empty block every 0.5s.
    '--mixed-mining', '--block-time', '0.5',
  ]
  log(`anvil ${args.join(' ')}`)
  const child = spawn('anvil', args, {
    detached: detach,
    stdio: detach ? 'ignore' : ['ignore', 'ignore', 'pipe'],
  })
  if (child.pid === undefined) {
    await new Promise(resolve => child.once('error', resolve))
    throw new Error('could not start anvil (is Foundry installed and on PATH?)')
  }
  const pid = child.pid
  let exited = false
  const exitedPromise = new Promise<void>(resolve =>
    child.once('exit', () => {
      exited = true
      resolve()
    })
  )
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
  const kill = () => {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
  }
  if (detach) child.unref()
  else process.once('exit', kill)

  const stop = async (): Promise<void> => {
    process.removeListener('exit', kill)
    if (exited) return
    kill()
    // A detached child is unref'd, so its exit event may never be delivered.
    if (!detach) await exitedPromise
  }

  const expected = `0x${PARENT_CHAIN_ID.toString(16)}`
  const deadline = Date.now() + 30_000
  for (;;) {
    if (exited) throw new Error(`anvil exited during startup: ${stderr.trim()}`)
    const chainId = await rpcChainId(rpcUrl)
    // Our anvil must still be running: a node answering after it exited is someone else's.
    if (chainId !== undefined && !exited) {
      if (chainId !== expected) {
        await stop()
        throw new Error(`a node with chain id ${chainId} is already answering on ${rpcUrl}`)
      }
      return { pid, stop, kill }
    }
    if (Date.now() > deadline) {
      await stop()
      throw new Error(`anvil did not answer on ${rpcUrl} within 30s`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function rpcChainId(rpcUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    const body = (await res.json()) as { result?: unknown }
    return typeof body.result === 'string' ? body.result : undefined
  } catch {
    return undefined
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))
      )
    })
  })
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use`) : err)
    )
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
  })
}

function start(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  log: (s: string) => void
): { kill: () => void; done: Promise<void> } {
  // `hardhat run` executes the script in a child node process, so give it its own process group
  // and kill the whole group.
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const kill = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid)
    } catch {
      // already gone
    }
  }
  const done = new Promise<void>((resolve, reject) => {
    const tail: string[] = []
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        if (!line) continue
        log(line)
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    child.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      const what = `${path.basename(cmd)} ${args.join(' ')}`
      if (timedOut) reject(new Error(`${what} timed out after ${timeoutMs / 1000}s:\n${tail.join('\n')}`))
      else if (code !== 0) reject(new Error(`${what} exited ${code}:\n${tail.join('\n')}`))
      else resolve()
    })
  })
  return { kill, done }
}

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
  return { chainId: o.chainId, creator: o.creator, templates: o.templates, chains: o.chains }
}

function checkAddressMap(m: unknown, what: string, fail: (what: string) => never): void {
  if (typeof m !== 'object' || m === null) fail(what)
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!isAddress(v) || /^0x0{40}$/.test(v)) fail(`${what}.${k}`)
  }
}

function isAddress(v: unknown): v is Address {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}
