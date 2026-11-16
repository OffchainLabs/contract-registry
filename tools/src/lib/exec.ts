import { spawn, execFileSync } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Receives combined stdout/stderr; the tail is kept for error messages either way. */
  log?: (chunk: string) => void
  timeoutMs?: number
}

export class CommandError extends Error {
  readonly output: string
  constructor(message: string, output: string) {
    super(message)
    this.output = output
  }
}

/** Runs a shell command, resolving with its output; rejects with the output tail on failure. */
export function sh(command: string, opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-o', 'pipefail', '-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const onData = (d: Buffer) => {
      const s = d.toString()
      out += s
      if (out.length > 4_000_000) out = out.slice(-2_000_000)
      opts.log?.(s)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined
    child.on('error', reject)
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new CommandError(`command failed (exit ${code}): ${command} [in ${opts.cwd ?? process.cwd()}]\n${out.slice(-3000)}`, out))
    })
  })
}

/** Synchronous git with no credential helper and no prompts, so source repos are read anonymously. */
export function git(args: string[], cwd?: string, input?: string): string {
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * The commits that branch `ref` and tag `ref` point at in a remote repo (`git ls-remote`), each if
 * it exists. An annotated tag gives the commit it points at (the peeled `^{}` line), not the tag
 * object. Names must match exactly: `main` doesn't match `refs/heads/feature/main`.
 */
export function remoteRefCommits(url: string, ref: string): { branch?: string; tag?: string } {
  // `<ref>` alone lists an annotated tag's object; `<ref>^{}` lists its commit.
  const listed = git(['ls-remote', url, ref, `${ref}^{}`])
  const at = new Map(listed.trim().split('\n').filter(Boolean).map(l => l.split('\t').reverse() as [string, string]))
  return { branch: at.get(`refs/heads/${ref}`), tag: at.get(`refs/tags/${ref}^{}`) ?? at.get(`refs/tags/${ref}`) }
}

export function gitOk(args: string[], cwd?: string): boolean {
  try { git(args, cwd); return true } catch { return false }
}

/** A tiny promise-based mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
}

/** Runs `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
