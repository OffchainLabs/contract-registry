import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { remoteRefCommits } from '../lib/exec.ts'
import { INDEX_PATH, outOfScopePath } from '../lib/layout.ts'
import { VIEW_SCHEMA_VERSION, type ByLengthEntry, type IndexFile } from '../lib/types.ts'
import { getVersion, lookup, readByLength, type ContractVersion, type RegistryFiles, type VersionRpc } from './get-version.ts'

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

/**
 * Static files over HTTP at a fixed commit, e.g. raw.githubusercontent.com/<owner>/<repo>/<sha>.
 * An error status other than 404, and a request that fails outright (DNS, a dropped connection),
 * are retried with backoff, five attempts in all.
 */
export class HttpSource implements RegistrySource {
  readonly base: string
  constructor(base: string) { this.base = base.replace(/\/$/, '') }
  describe() { return this.base }
  async read(rel: string) {
    const url = `${this.base}/${rel}`
    for (let attempt = 0; ; attempt++) {
      let failure: string
      try {
        const res = await fetch(url)
        if (res.status === 404) return null
        if (res.ok) return await res.text()
        failure = `HTTP ${res.status}`
      } catch (e) {
        const cause = (e as Error & { cause?: Error }).cause?.message
        failure = `${(e as Error).message}${cause ? ` (${cause})` : ''}`
      }
      if (attempt >= 4) throw new Error(`GET ${url}: ${failure}`)
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

/** The commit a branch or tag points at in a remote repo; a branch wins over a tag of the same name. */
export function resolveRemote(url: string, ref: string): string {
  const { branch, tag } = remoteRefCommits(url, ref)
  const sha = branch ?? tag
  if (!sha) throw new Error(`can't resolve ${ref} in ${url}`)
  return sha
}

/** A registry snapshot: every source's entries, looked up together. */
export class Registry {
  readonly source: RegistrySource
  /** The code lengths present, and per source its repo and getters. Read once, by `open`. */
  readonly index: IndexFile
  /** Reads in progress or done: each file, and every shard together. */
  private cache = new Map<string, Promise<unknown>>()
  /** The snapshot as `get-version.ts` reads it: the index, and each file read once. */
  private readonly files: RegistryFiles

  private constructor(source: RegistrySource, index: IndexFile) {
    this.source = source
    this.index = index
    this.files = { index, read: rel => this.once(rel, () => source.read(rel)) }
  }

  /**
   * Opens a snapshot, given as a spec (see `openSource`; by default this repo's `main`, resolved to
   * a commit once) or a source, and reads its index. A snapshot this client can't read throws
   * here, so no lookup can answer wrongly, or null for everything: one with no index, or whose
   * views have a `schemaVersion` other than the one this client reads.
   */
  static async open(spec: string | RegistrySource = 'github:OffchainLabs/contract-registry@main'): Promise<Registry> {
    const source = typeof spec === 'string' ? await openSource(spec) : spec
    const cannot = (why: string) => new Error(`${source.describe()} is not a registry snapshot this client can read: ${why}`)
    const text = await source.read(INDEX_PATH)
    if (!text) throw cannot(`it has no ${INDEX_PATH}`)
    const index = JSON.parse(text) as IndexFile
    if (index.schemaVersion !== VIEW_SCHEMA_VERSION) throw cannot(`${INDEX_PATH} has schemaVersion ${index.schemaVersion}; this client reads ${VIEW_SCHEMA_VERSION}`)
    return new Registry(source, index)
  }

  /**
   * `read()`'s promise, made once per key and shared. One that rejects is dropped, so a failed read
   * (a network error, say) fails only the calls that were waiting on it: the next call reads again.
   */
  private once<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key) as Promise<T> | undefined
    if (cached) return cached
    const p = read()
    this.cache.set(key, p)
    p.catch(() => { if (this.cache.get(key) === p) this.cache.delete(key) })
    return p
  }

  /** Every entry of one code length, of every source: one small static fetch, and none for a length the index doesn't list. */
  byLength(len: number): Promise<ByLengthEntry[]> {
    // The by-length files have every field of a ByLengthEntry; get-version.ts types only those it reads.
    return readByLength(this.files, len) as Promise<ByLengthEntry[]>
  }

  /** Every entry (fetches every shard; only needed to find the closest entry for unknown code). */
  all(): Promise<ByLengthEntry[]> {
    return this.once('all', async () => (await Promise.all(this.index.codeLengths.map(l => this.byLength(l)))).flat())
  }

  /** A source's out-of-scope getters (signature -> reason), or null if the snapshot has none for it. */
  async outOfScope(source: string): Promise<Record<string, string> | null> {
    const t = await this.source.read(outOfScopePath(source))
    return t ? JSON.parse(t).getters : null
  }

  /**
   * The entry of the code's length whose `fingerprint` is the keccak256 of the code with the
   * entry's `fingerprintMask` zeroed, or null (`lookup` in `get-version.ts`). At most one entry can
   * match, because publish and CI require entries of one length to mask the same bytes, in every
   * source, apart from reviewed pairs (see `rangeConflicts`). `decodeImmutables(code, entry)` reads
   * the matched code's immutables.
   */
  lookup(code: Uint8Array): Promise<ByLengthEntry | null> {
    return lookup(this.files, code) as Promise<ByLengthEntry | null>
  }

  /**
   * The `version` and `repo` of the entry the code at `address` matches, following a
   * single-implementation proxy, or unknown code, to its implementation (`getVersion` in
   * `get-version.ts`, where each case is described). `rpc.call` must throw an `ExecutionError`
   * when the call reverts (any other error is passed on).
   */
  getVersion(rpc: VersionRpc, address: string, block = 'latest'): Promise<ContractVersion | null> {
    return getVersion(rpc, this.files, address, block)
  }
}
