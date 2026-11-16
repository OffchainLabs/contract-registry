import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { remoteRefCommits } from '../lib/exec.ts'
import { matches } from '../lib/fingerprint.ts'
import { hexToBytes } from '../lib/hex.ts'
import { INDEX_PATH, byLengthPath, outOfScopePath } from '../lib/layout.ts'
import { isPrerelease } from '../lib/semver.ts'
import { VIEW_SCHEMA_VERSION, type ByLengthEntry, type ByLengthFile, type IndexFile } from '../lib/types.ts'
import { readImplementations, reportsImplementation } from './proxy.ts'
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

/** The commit a branch or tag points at in a remote repo; a branch wins over a tag of the same name. */
export function resolveRemote(url: string, ref: string): string {
  const { branch, tag } = remoteRefCommits(url, ref)
  const sha = branch ?? tag
  if (!sha) throw new Error(`can't resolve ${ref} in ${url}`)
  return sha
}

/**
 * A version string for an entry: its first release tag (tags are in semver order), else its first
 * prerelease tag, else `<ref>@<first 12 hex digits of commit>` for code in no tag (built only as a
 * release or hotfix branch head, e.g. `release-3.3.0@abcdef012345`). A manual entry with no tag
 * gives its label.
 */
export function versionOf(entry: ByLengthEntry): string {
  const releases = entry.tags.filter(t => !isPrerelease(t))
  if (releases.length) return releases[0]
  if (entry.tags.length) return entry.tags[0]
  if (entry.label !== undefined) return entry.label
  if (entry.ref === null || entry.commit === null) return entry.contracts[0] // the schema requires a label here
  return `${entry.ref}@${entry.commit.slice(0, 12)}`
}

/** What `Registry.getVersion` reports: a version (see `versionOf`) and the repo it is a version of. */
export interface ContractVersion {
  version: string
  /** The matched entry's repo (`owner/repo`). Tag names overlap across repos, so a version alone is ambiguous. */
  repo: string
}

function contractVersion(entry: ByLengthEntry): ContractVersion {
  return { version: versionOf(entry), repo: entry.repo }
}

/** A registry snapshot: every source's entries, looked up together. */
export class Registry {
  readonly source: RegistrySource
  private shards = new Map<number, Promise<ByLengthEntry[]>>()
  private indexP?: Promise<IndexFile>
  private allP?: Promise<ByLengthEntry[]>

  constructor(source: RegistrySource) {
    this.source = source
  }

  /** Opens a snapshot (see `openSource`); by default this repo's `main`, resolved to a commit once. */
  static async open(spec = 'github:OffchainLabs/contract-registry@main'): Promise<Registry> {
    return new Registry(await openSource(spec))
  }

  /**
   * The code lengths present, and per source its repo and getters. Read once. A snapshot without
   * it (the old layout, or not a registry at all) throws, so lookups can't quietly answer null
   * for everything.
   */
  index(): Promise<IndexFile> {
    this.indexP ??= this.source.read(INDEX_PATH).then(t => {
      if (!t) throw new Error(`${this.source.describe()} is not a layout-v2 registry snapshot: it has no ${INDEX_PATH}`)
      const ix = JSON.parse(t) as IndexFile
      if (ix.schemaVersion !== VIEW_SCHEMA_VERSION) throw new Error(`${this.source.describe()}: ${INDEX_PATH} has schemaVersion ${ix.schemaVersion}; this client reads ${VIEW_SCHEMA_VERSION}`)
      return ix
    })
    return this.indexP
  }

  /** Every entry of one code length, of every source: one small static fetch, and none for a length the index doesn't list. */
  byLength(len: number): Promise<ByLengthEntry[]> {
    let p = this.shards.get(len)
    if (!p) {
      p = this.index().then(async ix => {
        if (!ix.codeLengths.includes(len)) return []
        const t = await this.source.read(byLengthPath(len))
        if (!t) throw new Error(`${this.source.describe()}: ${INDEX_PATH} lists code length ${len}, but ${byLengthPath(len)} is missing`)
        return (JSON.parse(t) as ByLengthFile).entries
      })
      this.shards.set(len, p)
    }
    return p
  }

  /** Every entry (fetches every shard; only needed to find the closest entry for unknown code). */
  all(): Promise<ByLengthEntry[]> {
    this.allP ??= this.index().then(async ix => (await Promise.all(ix.codeLengths.map(l => this.byLength(l)))).flat())
    return this.allP
  }

  /** A source's out-of-scope getters (signature -> reason), or null if the snapshot has none for it. */
  async outOfScope(source: string): Promise<Record<string, string> | null> {
    const t = await this.source.read(outOfScopePath(source))
    return t ? JSON.parse(t).getters : null
  }

  /**
   * The lookup (§5.5): the entry of the code's length that passes the match rule, or null. Reads
   * the index, then the length's shard if the index lists that length. At most one entry can
   * pass, because publish and CI require entries of one length to mask the same bytes, in every
   * source, apart from reviewed pairs (see `rangeConflicts`). `decodeImmutables(code, entry)`
   * reads the matched code's immutables.
   */
  async lookup(code: Uint8Array): Promise<ByLengthEntry | null> {
    return (await this.byLength(code.length)).find(e => matches(code, e)) ?? null
  }

  /**
   * The version of the contract at `address` (see `versionOf`) and the repo it is a version of,
   * or null. A proxy with one implementation slot reports its implementation, whichever repo that
   * comes from (null if the slot is zero or its code missing or unknown). Everything else the
   * registry knows reports its own code: logic, proxy admins, and proxies with two slots
   * (RollupProxy, AdminFallbackProxy), whose own version can lag the logic behind them.
   *
   * Unknown code may be a proxy the registry doesn't have (e.g. Arbitrum One's, older than the
   * registry's first tag), so it is probed as `readImplementations` says. If its secondary slot is
   * set, it's a two-slot proxy, with no version of its own: null. Otherwise it reports the
   * implementation at the EIP-1967 slot, as a one-slot proxy does, and so gives null unless that
   * slot holds code the registry knows.
   */
  async getVersion(rpc: Pick<Rpc, 'getCode' | 'getStorageAt'>, address: string, block = 'latest'): Promise<ContractVersion | null> {
    const entry = await this.lookup(hexToBytes(await rpc.getCode(address, block)))
    if (entry && !reportsImplementation(entry)) return contractVersion(entry)
    const impls = await readImplementations(rpc, address, entry, block)
    // Only unknown code gives a secondary here. An unknown two-slot proxy (an old RollupProxy)
    // gives null, not the version of the admin logic in its EIP-1967 slot.
    if (impls.some(i => i.role === 'secondaryImplementation')) return null
    const impl = impls.find(i => i.role === 'implementation')
    if (!impl) return null
    const implEntry = await this.lookup(hexToBytes(await rpc.getCode(impl.address, block)))
    return implEntry && contractVersion(implEntry)
  }
}
