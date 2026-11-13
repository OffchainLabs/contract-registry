import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { sh, Mutex, git } from './exec.ts'
import { loadBuildInfos, selectArtifacts, filterSources, extractContract, packageOf, parityCheck, type ArtifactRef } from './extract.ts'
import { profileFor, type BuildProfile } from './config.ts'
import type { SourceRepo } from './source.ts'
import type { BuiltContract } from './types.ts'

/** Bump when extraction or fingerprinting changes, so cached results are not reused. */
export const GENERATOR_VERSION = 3

export interface BuildFailure { kind: 'build-failure' | 'parity-mismatch'; message: string }

export interface BuildResult {
  generatorVersion: number
  commit: string
  profile: string
  profileHash: string
  ok: boolean
  failure?: BuildFailure
  packageVersion: string | null
  contracts: BuiltContract[]
}

export interface Checkout { dir: string; remove(): void }

/** Serializes git worktree operations and dependency installs across parallel builds. */
const setupLock = new Mutex()

export interface BuildOptions {
  /** Ignore cached results (tag builds must really rebuild). */
  fresh?: boolean
  /** Keep the checkout so a test chain can be deployed from it. */
  keepCheckout?: boolean
  log?: (s: string) => void
}

export class Builder {
  readonly src: SourceRepo
  readonly workDir: string

  constructor(src: SourceRepo, workDir: string) {
    this.src = src
    this.workDir = workDir
  }

  private resultPath(commit: string): string {
    return path.join(this.workDir, 'results', this.src.cfg.directory, `${commit}.json`)
  }

  logPath(commit: string, suffix = ''): string {
    return path.join(this.workDir, 'logs', this.src.cfg.directory, `${commit}${suffix}.log`)
  }

  profileHash(p: BuildProfile): string {
    return createHash('sha256').update(JSON.stringify({ p, v: GENERATOR_VERSION })).digest('hex').slice(0, 16)
  }

  cached(commit: string): BuildResult | null {
    const f = this.resultPath(commit)
    if (!fs.existsSync(f)) return null
    const r: BuildResult = JSON.parse(fs.readFileSync(f, 'utf8'))
    const p = profileFor(this.src.cfg, this.src.gitDir, commit)
    return r.ok && r.generatorVersion === GENERATOR_VERSION && r.profileHash === this.profileHash(p) ? r : null
  }

  /** Builds a commit (or returns the cached result) and fingerprints its deployed contracts. */
  async build(commit: string, opts: BuildOptions = {}): Promise<{ result: BuildResult; checkout?: Checkout }> {
    if (!opts.fresh && !opts.keepCheckout) {
      const c = this.cached(commit)
      if (c) return { result: c }
    }
    let attempt = 0
    for (;;) {
      attempt++
      const r = await this.buildOnce(commit, opts, attempt)
      // Retry once on a build failure, in case it was transient (network during install, etc.).
      if (r.result.ok || r.result.failure?.kind !== 'build-failure' || attempt >= 2) {
        if (r.result.ok && !opts.fresh) {
          fs.mkdirSync(path.dirname(this.resultPath(commit)), { recursive: true })
          fs.writeFileSync(this.resultPath(commit), JSON.stringify(r.result))
        }
        return r
      }
      r.checkout?.remove()
    }
  }

  private async buildOnce(commit: string, opts: BuildOptions, attempt: number): Promise<{ result: BuildResult; checkout?: Checkout }> {
    const profile = profileFor(this.src.cfg, this.src.gitDir, commit)
    const base: Omit<BuildResult, 'ok' | 'contracts'> = {
      generatorVersion: GENERATOR_VERSION, commit, profile: profile.name, profileHash: this.profileHash(profile), packageVersion: null,
    }
    const logFile = this.logPath(commit, opts.fresh ? '.fresh' : '')
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const logStream = fs.createWriteStream(logFile, { flags: attempt > 1 ? 'a' : 'w' })
    const log = (s: string) => logStream.write(s)
    const dir = path.join(this.workDir, 'checkouts', this.src.cfg.directory, `${commit.slice(0, 12)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    const checkout: Checkout = {
      dir,
      remove: () => {
        try { git(['worktree', 'remove', '--force', dir], this.src.gitDir) } catch { /* fall through */ }
        fs.rmSync(dir, { recursive: true, force: true })
        try { git(['worktree', 'prune'], this.src.gitDir) } catch { /* ignore */ }
      },
    }
    const done = (r: BuildResult) => {
      logStream.end()
      if (!opts.keepCheckout || !r.ok) checkout.remove()
      return { result: r, checkout: opts.keepCheckout && r.ok ? checkout : undefined }
    }
    try {
      opts.log?.(`build ${commit.slice(0, 12)} (${profile.name}${opts.fresh ? ', fresh' : ''})`)
      await setupLock.run(async () => {
        fs.mkdirSync(path.dirname(dir), { recursive: true })
        git(['worktree', 'add', '--detach', '--force', dir, commit], this.src.gitDir)
        for (const cmd of profile.setup) { log(`$ ${cmd}\n`); await sh(cmd, { cwd: dir, log }) }
      })
      const pkg = this.src.fileAt(commit, 'package.json')
      base.packageVersion = pkg ? (JSON.parse(pkg).version ?? null) : null
      for (const out of profile.outputs) {
        for (const cmd of out.commands) { log(`$ ${cmd}\n`); await sh(cmd, { cwd: dir, env: out.env, log }) }
      }
    } catch (e) {
      return done({ ...base, ok: false, failure: { kind: 'build-failure', message: (e as Error).message.slice(-4000) }, contracts: [] })
    }
    try {
      const deployed = new Map<string, ArtifactRef[]>()
      for (const out of profile.outputs.filter(o => o.deployed)) {
        const bis = loadBuildInfos(path.join(dir, out.buildInfo))
        const refs = selectArtifacts(bis, out.layout, out.artifacts ? path.join(dir, out.artifacts) : undefined)
        deployed.set(out.name, filterSources(refs, profile.include, profile.exclude))
      }
      const mismatches: string[] = []
      for (const out of profile.outputs.filter(o => o.parityWith)) {
        const theirs = loadBuildInfos(path.join(dir, out.buildInfo))
        for (const m of parityCheck(deployed.get(out.parityWith!) ?? [], theirs)) mismatches.push(`${m.fqName}: ${m.reason} (${out.parityWith} vs ${out.name})`)
      }
      if (mismatches.length) {
        return done({ ...base, ok: false, failure: { kind: 'parity-mismatch', message: mismatches.join('\n') }, contracts: [] })
      }
      const contracts: BuiltContract[] = []
      const seen = new Set<string>()
      for (const refs of deployed.values()) {
        for (const ref of refs) {
          if (seen.has(ref.fqName)) throw new Error(`${ref.fqName} produced by two deployed outputs`)
          seen.add(ref.fqName)
          const c = extractContract(ref)
          if (c) contracts.push({ ...c, package: packageOf(dir, ref.source) })
        }
      }
      contracts.sort((a, b) => a.fqName.localeCompare(b.fqName))
      opts.log?.(`built ${commit.slice(0, 12)}: ${contracts.length} contracts, ${new Set(contracts.map(c => c.fingerprint)).size} fingerprints`)
      return done({ ...base, ok: true, contracts })
    } catch (e) {
      return done({ ...base, ok: false, failure: { kind: 'build-failure', message: `extracting build output: ${(e as Error).message}` }, contracts: [] })
    }
  }
}
