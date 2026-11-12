import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { matches, variantValues, type VariantValue } from '../lib/fingerprint.ts'
import type { ByLengthEntry, ByLengthFile, IndexFile } from '../lib/types.ts'

/** Where registry files come from. Every implementation reads one fixed snapshot. */
export interface RegistrySource {
  describe(): string
  /** Contents of a file at the snapshot, or null if it doesn't exist. */
  read(rel: string): Promise<string | null>
}

/** A working tree on disk (the publish run's check reads uncommitted files this way). */
export class DirSource implements RegistrySource {
  readonly root: string
  constructor(root: string) { this.root = root }
  describe() { return `dir:${this.root}` }
  async read(rel: string) {
    const f = path.join(this.root, rel)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
  }
}

/** A commit of a local clone of the data repo. */
export class GitSource implements RegistrySource {
  readonly repoDir: string
  readonly commit: string
  constructor(repoDir: string, rev: string) {
    this.repoDir = repoDir
    this.commit = execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], { cwd: repoDir, encoding: 'utf8' }).trim()
  }
  describe() { return `git:${this.repoDir}@${this.commit}` }
  async read(rel: string) {
    try {
      return execFileSync('git', ['show', `${this.commit}:${rel}`], { cwd: this.repoDir, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return null }
  }
}

/** Static files over HTTP at a fixed commit, e.g. raw.githubusercontent.com/<owner>/<repo>/<sha>. */
export class HttpSource implements RegistrySource {
  readonly base: string
  constructor(base: string) { this.base = base.replace(/\/$/, '') }
  describe() { return this.base }
  async read(rel: string) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}/${rel}`)
      if (res.status === 404) return null
      if (res.ok) return res.text()
      if (attempt >= 4) throw new Error(`GET ${this.base}/${rel}: HTTP ${res.status}`)
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
    }
  }
}

/**
 * Opens a registry snapshot. Branch names are resolved to a commit hash once, so a walk never
 * mixes files from before and after a push.
 *   - `<path>` or `dir:<path>`: a directory as it is now
 *   - `git:<path>[@<rev>]`: a local clone at a commit (default HEAD)
 *   - `github:<owner>/<repo>[@<ref>]`: the public repo at a commit (default main)
 */
export async function openSource(spec: string): Promise<RegistrySource> {
  if (spec.startsWith('git:')) {
    const [p, rev] = splitAt(spec.slice(4))
    return new GitSource(p, rev ?? 'HEAD')
  }
  if (spec.startsWith('github:')) {
    const [slug, ref] = splitAt(spec.slice(7))
    const commit = /^[0-9a-f]{40}$/.test(ref ?? '') ? ref! : resolveRemote(`https://github.com/${slug}.git`, ref ?? 'main')
    return new HttpSource(`https://raw.githubusercontent.com/${slug}/${commit}`)
  }
  return new DirSource(spec.startsWith('dir:') ? spec.slice(4) : spec)
}

function splitAt(s: string): [string, string | undefined] {
  const i = s.lastIndexOf('@')
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, undefined]
}

function resolveRemote(url: string, ref: string): string {
  const out = execFileSync('git', ['-c', 'credential.helper=', 'ls-remote', url, ref, `refs/heads/${ref}`, `refs/tags/${ref}`], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  const sha = out.split('\n').find(Boolean)?.split('\t')[0]
  if (!sha) throw new Error(`can't resolve ${ref} in ${url}`)
  return sha
}

export interface Match { entry: ByLengthEntry; variants: Record<string, VariantValue> }

/** One source repo's part of a registry snapshot. */
export class Registry {
  readonly source: RegistrySource
  readonly directory: string
  private shards = new Map<number, Promise<ByLengthEntry[]>>()
  private indexP?: Promise<IndexFile>
  private allP?: Promise<ByLengthEntry[]>

  constructor(source: RegistrySource, directory: string) {
    this.source = source
    this.directory = directory
  }

  /** Every entry of one code length (one small static fetch). */
  byLength(len: number): Promise<ByLengthEntry[]> {
    let p = this.shards.get(len)
    if (!p) {
      p = this.source.read(`${this.directory}/by-length/${len}.json`).then(t => (t ? (JSON.parse(t) as ByLengthFile).entries : []))
      this.shards.set(len, p)
    }
    return p
  }

  index(): Promise<IndexFile> {
    this.indexP ??= this.source.read(`${this.directory}/index.json`).then(t => {
      if (!t) throw new Error(`${this.source.describe()}: no ${this.directory}/index.json`)
      return JSON.parse(t) as IndexFile
    })
    return this.indexP
  }

  /** Every entry (fetches every shard; only needed to find the closest entry for unknown code). */
  all(): Promise<ByLengthEntry[]> {
    this.allP ??= this.index().then(async ix => (await Promise.all(ix.codeLengths.map(l => this.byLength(l)))).flat())
    return this.allP
  }

  async outOfScope(): Promise<Record<string, string> | null> {
    const t = await this.source.read(`config/${this.directory}/out-of-scope-getters.json`)
    return t ? JSON.parse(t).getters : null
  }

  /** The lookup (§5.5): test every entry of the code's length with the match rule. */
  async lookup(code: Uint8Array): Promise<Match[]> {
    const out: Match[] = []
    for (const e of await this.byLength(code.length)) {
      if (matches(code, e)) out.push({ entry: e, variants: variantValues(code, e.immutables) })
    }
    return out
  }
}
