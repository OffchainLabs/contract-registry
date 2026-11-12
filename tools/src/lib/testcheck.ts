import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { Rpc } from '../walker/rpc.ts'
import { Registry, DirSource } from '../walker/registry.ts'
import { walk, type CodeId, type WalkResult } from '../walker/walk.ts'
import { stableJson } from './json.ts'
import type { Hex } from './types.ts'

/** Bump when the walker or the check's rules change, so cached check results are not reused. */
export const CHECK_VERSION = 1

export interface ChainCheck { chain: string; start: string; problems: string[]; summary?: WalkResult['summary']; warnings?: number }
export interface CheckResult { commit: string; key: string; ok: boolean; problems: string[]; chains: ChainCheck[] }

export interface TestChainDeployer {
  deployTestChains(opts: { checkoutDir: string; log?: (s: string) => void }): Promise<{
    rpcUrl: string
    chains: { name: string; contracts: Record<string, string>; optional: Record<string, string> }[]
    stop(): Promise<void>
  }>
}

export function checkKey(outOfScope: string[], deployerName: string): string {
  const deployerFiles = [path.join(import.meta.dirname, '..', 'testchain', `${deployerName}.ts`)]
  const h = createHash('sha256').update(JSON.stringify({ v: CHECK_VERSION, outOfScope: [...outOfScope].sort() }))
  for (const f of deployerFiles) if (fs.existsSync(f)) h.update(fs.readFileSync(f))
  return h.digest('hex').slice(0, 16)
}

export class CheckCache {
  readonly dir: string
  constructor(workDir: string, directory: string) { this.dir = path.join(workDir, 'checks', directory) }
  private file(commit: string, key: string) { return path.join(this.dir, `${commit}-${key}.json`) }
  get(commit: string, key: string): CheckResult | null {
    const f = this.file(commit, key)
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
  }
  put(r: CheckResult): void {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.file(r.commit, r.key), stableJson(r))
  }
}

export async function loadDeployer(name: string): Promise<TestChainDeployer> {
  return import(path.join(import.meta.dirname, '..', 'testchain', `${name}.ts`))
}

/**
 * The test-chain check (spec §5.8): deploy test chains from the commit's checkout, walk each from
 * its rollup, and fail when an in-scope edge lands on code that doesn't match an entry from this
 * commit's build, when an in-scope edge returns zero, or when the walk can't complete.
 */
export async function checkCommit(opts: {
  commit: string
  key: string
  checkoutDir: string
  commitFingerprints: Set<string>
  dataRepo: string
  directory: string
  repo: string
  outOfScope: string[]
  deployer: TestChainDeployer
  log?: (s: string) => void
  /** Where to save each chain's full walk output, for debugging. */
  walkOutDir?: string
}): Promise<CheckResult> {
  const log = opts.log ?? (() => {})
  const chains: ChainCheck[] = []
  let dep: Awaited<ReturnType<TestChainDeployer['deployTestChains']>> | undefined
  try {
    log(`test chains: deploying from ${opts.commit.slice(0, 12)}`)
    dep = await opts.deployer.deployTestChains({ checkoutDir: opts.checkoutDir, log })
    for (const chain of dep.chains) {
      const start = chain.contracts.rollup
      const problems: string[] = []
      try {
        const registry = new Registry(new DirSource(opts.dataRepo), opts.directory)
        const w = await walk({ start, rpc: new Rpc(dep.rpcUrl), registry, repo: opts.repo, outOfScope: opts.outOfScope })
        if (opts.walkOutDir) {
          fs.mkdirSync(opts.walkOutDir, { recursive: true })
          fs.writeFileSync(path.join(opts.walkOutDir, `${opts.commit.slice(0, 12)}-${chain.name}.json`), stableJson(w))
        }
        problems.push(...evaluate(w, opts.commitFingerprints))
        chains.push({ chain: chain.name, start, problems, summary: w.summary, warnings: w.warnings.length })
      } catch (e) {
        problems.push(`walk could not complete: ${(e as Error).message}`)
        chains.push({ chain: chain.name, start, problems })
      }
      log(`test chain ${chain.name}: ${problems.length ? `${problems.length} problem(s)` : 'ok'}`)
    }
  } catch (e) {
    chains.push({ chain: '(deployment)', start: '', problems: [`test-chain deployment failed: ${(e as Error).message.slice(-3000)}`] })
  } finally {
    await dep?.stop().catch(() => {})
  }
  const problems = chains.flatMap(c => c.problems.map(p => `${c.chain}: ${p}`))
  return { commit: opts.commit, key: opts.key, ok: problems.length === 0, problems, chains }
}

export function evaluate(w: WalkResult, commitFingerprints: Set<string>): string[] {
  const problems: string[] = []
  const via = (n: WalkResult['nodes'][number]) => {
    const e = n.edges.filter(x => x.inScope).map(x => `${w.nodes.find(m => m.address === x.from)?.name ?? x.from}.${x.getter}${x.index === null ? '' : `[${x.index}]`}`)
    return e.length ? e.join(', ') : 'start'
  }
  const describe = (id: CodeId) => id.status === 'matched' ? `matched ${id.matches.map(m => `${m.contracts[0]} ${m.fingerprint.slice(0, 10)} tags [${m.tags.join(',')}]`).join('; ')}` : id.status
  for (const n of w.nodes) {
    if (!n.inScope) continue
    if (n.kind === 'account') { problems.push(`in-scope edge ${via(n)} lands on ${n.address}, which has no code`); continue }
    for (const [role, id] of [['code', n.code], ['implementation', n.implementation?.code], ['secondary implementation', n.secondaryImplementation?.code]] as const) {
      if (!id) continue
      const ok = id.status === 'matched' && id.matches.some(m => commitFingerprints.has(m.fingerprint))
      if (!ok) problems.push(`in-scope edge ${via(n)} lands on ${n.address} whose ${role} doesn't match an entry from this commit's build (${describe(id)})`)
    }
    for (const u of n.unset) if (u.inScope) problems.push(`in-scope getter ${n.name}.${u.getter}${u.index === null ? '' : `[${u.index}]`} on ${n.address} returned zero`)
  }
  return problems
}
