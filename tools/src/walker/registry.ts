import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { keccak256 } from 'viem'
import { remoteRefCommits } from '../lib/exec.ts'
import { zeroRanges } from '../lib/fingerprint.ts'
import { hexToBytes } from '../lib/hex.ts'
import { INDEX_PATH, byLengthPath, outOfScopePath } from '../lib/layout.ts'
import { VIEW_SCHEMA_VERSION, type ByLengthEntry, type ByLengthFile, type Hex, type IndexFile } from '../lib/types.ts'
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT, beaconImplementation, slotAddress } from './proxy.ts'
import type { Rpc } from './rpc.ts'

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

/** What `Registry.getVersion` reports: an entry's `version`, and the repo it is a version of. */
export interface ContractVersion {
  version: string
  /** The matched entry's repo (`owner/repo`). Tag names overlap across repos, so a version alone is ambiguous. */
  repo: string
}

/** A registry snapshot: every source's entries, looked up together. */
export class Registry {
  readonly source: RegistrySource
  /** The code lengths present, and per source its repo and getters. Read once, by `open`. */
  readonly index: IndexFile
  /** Reads in progress or done: each shard, and every shard together. */
  private cache = new Map<string, Promise<unknown>>()

  private constructor(source: RegistrySource, index: IndexFile) {
    this.source = source
    this.index = index
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
    if (!this.index.codeLengths.includes(len)) return Promise.resolve([])
    return this.once(`by-length/${len}`, async () => {
      const t = await this.source.read(byLengthPath(len))
      if (!t) throw new Error(`${this.source.describe()}: ${INDEX_PATH} lists code length ${len}, but ${byLengthPath(len)} is missing`)
      return (JSON.parse(t) as ByLengthFile).entries
    })
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
   * The lookup (§5.5): the entry of the code's length whose `fingerprint` is the keccak256 of the
   * code with the entry's `fingerprintMask` zeroed, or null. Fetches the length's shard if the
   * index lists that length. At most one entry can match, because publish and CI require entries
   * of one length to mask the same bytes, in every source, apart from reviewed pairs (see
   * `rangeConflicts`). `decodeImmutables(code, entry)` reads the matched code's immutables.
   */
  async lookup(code: Uint8Array): Promise<ByLengthEntry | null> {
    return (await this.byLength(code.length)).find(e => keccak256(zeroRanges(code, e.fingerprintMask)) === e.fingerprint) ?? null
  }

  /**
   * The `version` and `repo` of the entry the code at `address` matches, or null. A
   * single-implementation proxy (one implementation slot, or a beacon proxy) reports its
   * implementation instead, whichever repo that comes from; so does unknown code, which may be a
   * proxy the registry doesn't have (e.g. Arbitrum One's, older than the registry's first tag).
   * Either way the implementation is the address in EIP-1967's implementation slot or, if that is
   * zero, what the beacon in EIP-1967's beacon slot returns, and gives null unless it is code the
   * registry knows. Publish and CI require every single-implementation proxy's entry to list that
   * slot. Unknown code whose secondary slot is set is a two-slot proxy (an old RollupProxy), with
   * no version of its own: null, not the version of the admin logic in its EIP-1967 slot.
   *
   * `rpc.call` is only used to ask a beacon for its implementation; it must throw an
   * `ExecutionError` when the call reverts (any other error is passed on).
   */
  async getVersion(rpc: Pick<Rpc, 'getCode' | 'getStorageAt' | 'call'>, address: string, block = 'latest'): Promise<ContractVersion | null> {
    const slot = async (s: Hex) => slotAddress(await rpc.getStorageAt(address, s, block))
    const entry = await this.lookup(hexToBytes(await rpc.getCode(address, block)))
    if (entry && !entry.isSingleImplementationProxy) return { version: entry.version, repo: entry.repo }
    if (!entry && await slot(SECONDARY_IMPLEMENTATION_SLOT)) return null
    const impl = await slot(EIP1967_IMPLEMENTATION_SLOT) ?? await beaconImplementation(rpc, await slot(EIP1967_BEACON_SLOT), block)
    const implEntry = impl && await this.lookup(hexToBytes(await rpc.getCode(impl, block)))
    return implEntry ? { version: implEntry.version, repo: implEntry.repo } : null
  }
}
