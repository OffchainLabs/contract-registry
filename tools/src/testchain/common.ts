// Helpers shared by the test-chain deployers (tools/src/testchain/<source>.ts): local anvil nodes,
// and running a deploy script inside a source checkout with its output logged.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { abbreviate, collapseData, truncateMiddle } from '../lib/abbrev.ts'

export type Address = `0x${string}`

/** anvil's default account 0, the deployer. */
export const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

export interface Anvil {
  pid: number
  rpcUrl: string
  /** Kills anvil and waits for it to exit. */
  stop(): Promise<void>
  /** Sends the kill signal without waiting. */
  kill(): void
}

export interface AnvilOptions {
  /** A free one is picked if omitted. */
  port?: number
  chainId: number
  /** Pinned by each deployer rather than left to anvil's default, which moves with the Foundry version. */
  hardfork: string
  /** Further anvil arguments, e.g. ['--mixed-mining', '--block-time', '0.5']. */
  extraArgs?: string[]
  /**
   * Start anvil detached so it outlives this process (for a CLI's --keep). Otherwise anvil is
   * also killed when this process exits.
   */
  detach?: boolean
  log?: (s: string) => void
}

/** Starts anvil and waits until it answers with the expected chain id. */
export async function startAnvil(opts: AnvilOptions): Promise<Anvil> {
  const log = opts.log ?? (() => {})
  const detach = opts.detach ?? false
  const port = opts.port ?? (await freePort())
  if (opts.port !== undefined) await assertPortFree(port)
  const rpcUrl = `http://127.0.0.1:${port}`
  const args = ['--port', String(port), '--chain-id', String(opts.chainId), '--hardfork', opts.hardfork, ...(opts.extraArgs ?? [])]
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

  const expected = `0x${opts.chainId.toString(16)}`
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
      return { pid, rpcUrl, stop, kill }
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

/** Longest output line logged or kept for an error message. */
export const MAX_LINE = 2000

export class CommandFailed extends Error {
  /** The last stdout lines, shortened as logged. */
  readonly stdoutTail: string[]
  constructor(message: string, stdoutTail: string[]) {
    super(message)
    this.stdoutTail = stdoutTail
  }
}

/**
 * Runs `cmd`, logging each output line with long data collapsed (see collapseData) and capped at
 * MAX_LINE characters. Rejects on a non-zero exit or timeout with a CommandFailed holding the last
 * 40 lines.
 */
export function startLogged(
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
    const stdoutTail: string[] = []
    const keep = (lines: string[], line: string) => {
      lines.push(line)
      if (lines.length > 40) lines.shift()
    }
    // A chunk can end mid-line (an ethers error can print one line of hundreds of KB), so each
    // stream keeps its unfinished line until the next chunk or the end.
    const lineReader = (stream: NodeJS.ReadableStream | null, isStdout: boolean) => {
      const addLine = (line: string) => {
        if (!line) return
        const short = truncateMiddle(collapseData(line), MAX_LINE)
        log(short)
        keep(tail, short)
        if (isStdout) keep(stdoutTail, short)
      }
      let partial = ''
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop()!
        lines.forEach(addLine)
      })
      return () => {
        addLine(partial)
        partial = ''
      }
    }
    const flushStdout = lineReader(child.stdout, true)
    const flushStderr = lineReader(child.stderr, false)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    let finished = false
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      flushStdout()
      flushStderr()
      const what = `${path.basename(cmd)} ${args.join(' ')}`
      if (timedOut) reject(new CommandFailed(`${what} timed out after ${timeoutMs / 1000}s:\n${tail.join('\n')}`, stdoutTail))
      else if (code !== 0) reject(new CommandFailed(`${what} exited ${code}:\n${tail.join('\n')}`, stdoutTail))
      else resolve()
    }
    child.once('error', e => {
      finished = true
      clearTimeout(timer)
      reject(e)
    })
    // Finish on 'close', after the output streams have ended, so no output is lost; but not later
    // than 5s after 'exit', in case a leftover grandchild still holds the pipes.
    child.once('exit', code => setTimeout(() => finish(code), 5000).unref())
    child.once('close', code => finish(code))
  })
  return { kill, done }
}

export function isAddress(v: unknown): v is Address {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}

/** Fails unless `m` maps names to non-zero addresses. */
export function checkAddressMap(m: unknown, what: string, fail: (what: string) => never): void {
  if (typeof m !== 'object' || m === null) fail(what)
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!isAddress(v) || /^0x0{40}$/.test(v)) fail(`${what}.${k}`)
  }
}

export interface CheckoutScriptOptions {
  checkoutDir: string
  /** The script to run, copied into the checkout under `scriptDir` with a random name, and removed afterwards. */
  script: string
  /** Where in the checkout the copy goes, relative to it (e.g. `scripts`), so its relative imports resolve. */
  scriptDir: string
  /** The command that runs the copy, given its path relative to the checkout. */
  command(scriptRel: string): { cmd: string; args: string[] }
  env: Record<string, string>
  timeoutMs: number
  log: (s: string) => void
  /** Called on SIGINT or SIGTERM before the copy is removed, e.g. to kill anvil. */
  onSignal?: () => void
}

/**
 * Runs a deploy script inside a source checkout and returns the JSON it writes to
 * $REGISTRY_TESTCHAIN_OUT. The script writes its error's stack to $REGISTRY_TESTCHAIN_ERROR on
 * failure; that error is reported first, then the script's last progress lines, since an ethers
 * error's stack doesn't say which deployment step failed.
 */
export async function runCheckoutScript(opts: CheckoutScriptOptions): Promise<unknown> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'registry-testchain-'))
  const outFile = path.join(tmp, 'out.json')
  const errorFile = path.join(tmp, 'error.txt')
  const scriptRel = path.join(opts.scriptDir, `.registry-testchain-${randomBytes(4).toString('hex')}.ts`)
  const scriptAbs = path.join(opts.checkoutDir, scriptRel)
  let killScript: (() => void) | undefined
  // A signal would skip the cleanup below and leave the script copy in the checkout.
  const onSignal = (signal: NodeJS.Signals) => {
    killScript?.()
    opts.onSignal?.()
    rmSync(scriptAbs, { force: true })
    rmSync(tmp, { recursive: true, force: true })
    process.kill(process.pid, signal)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await copyFile(opts.script, scriptAbs)
    const { cmd, args } = opts.command(scriptRel)
    const run = startLogged(cmd, args, opts.checkoutDir, { ...opts.env, REGISTRY_TESTCHAIN_OUT: outFile, REGISTRY_TESTCHAIN_ERROR: errorFile }, opts.timeoutMs, opts.log)
    killScript = run.kill
    await run.done.catch(async (err: Error) => {
      const scriptError = await readFile(errorFile, 'utf8').catch(() => '')
      if (!scriptError) throw err
      const progress = err instanceof CommandFailed ? err.stdoutTail.slice(-5) : []
      throw new Error(
        `deploy script failed: ${abbreviate(scriptError.replaceAll(opts.checkoutDir, '<checkout>'), { max: 2500, maxLine: MAX_LINE })}` +
          (progress.length ? `\nlast progress output:\n${progress.join('\n')}` : '')
      )
    })
    return JSON.parse(await readFile(outFile, 'utf8'))
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await rm(scriptAbs, { force: true })
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Fails with a message naming the first of `paths` that is missing. */
export async function requireFiles(checkoutDir: string, paths: string[]): Promise<void> {
  for (const required of paths) {
    await access(required).catch(() => {
      throw new Error(`${required} missing: is ${checkoutDir} an installed and built checkout?`)
    })
  }
}
