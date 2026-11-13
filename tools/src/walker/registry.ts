import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { matches } from '../lib/fingerprint.ts'
import { hexToBytes } from '../lib/hex.ts'
import { isPrerelease } from '../lib/semver.ts'
import type { ByLengthEntry, ByLengthFile, IndexFile } from '../lib/types.ts'
import type { Rpc } from './rpc.ts'
import { EIP1967_IMPLEMENTATION_SLOT, SECONDARY_IMPLEMENTATION_SLOT } from './walk.ts'

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

  /**
   * The lookup (§5.5): the entry of the code's length that passes the match rule, or null. At most
   * one entry can pass, because publish and CI require entries of one length to mask the same
   * bytes, apart from reviewed pairs (see `rangeConflicts`). `decodeImmutables(code, entry)` reads
   * the matched code's immutables.
   */
  async lookup(code: Uint8Array): Promise<ByLengthEntry | null> {
    return (await this.byLength(code.length)).find(e => matches(code, e)) ?? null
  }

  /**
   * The version of the contract at `address` (see `versionOf`), or null. A proxy with one
   * implementation slot reports its implementation's version (null if the slot is zero or its code
   * missing or unknown). Everything else the registry knows reports its own code's version: logic,
   * proxy admins, and proxies with two slots (RollupProxy, AdminFallbackProxy), whose own version
   * can lag the logic behind them.
   *
   * Unknown code may be a proxy the registry doesn't have (e.g. Arbitrum One's, older than the
   * registry's first tag). If its secondary slot is set, it's a two-slot proxy, with no version of
   * its own: null. Otherwise it reports the implementation at the EIP-1967 slot, as a one-slot
   * proxy does, and so gives null unless that slot holds code the registry knows.
   */
  async getVersion(rpc: Pick<Rpc, 'getCode' | 'getStorageAt'>, address: string, block = 'latest'): Promise<string | null> {
    const entry = await this.lookup(hexToBytes(await rpc.getCode(address, block)))
    if (!entry) {
      // Unknown code: maybe a proxy the registry doesn't have. Secondary slot first, so an unknown
      // two-slot proxy (an old RollupProxy) gives null rather than its admin logic's version.
      if (!/^(0x)?0*$/.test(await rpc.getStorageAt(address, SECONDARY_IMPLEMENTATION_SLOT, block))) return null
      return this.implementationVersion(rpc, address, EIP1967_IMPLEMENTATION_SLOT, block)
    }
    if (entry.role === 'proxy' && entry.implementationSlots?.length === 1) return this.implementationVersion(rpc, address, entry.implementationSlots[0], block)
    return versionOf(entry)
  }

  /** The version of the code at the address in `slot` of `proxy`; null if the slot is zero, or that code is missing or unknown. */
  private async implementationVersion(rpc: Pick<Rpc, 'getCode' | 'getStorageAt'>, proxy: string, slot: string, block: string): Promise<string | null> {
    const word = (await rpc.getStorageAt(proxy, slot, block)).replace(/^0x/, '').padStart(64, '0')
    const impl = `0x${word.slice(-40)}`
    if (/^0x0{40}$/.test(impl)) return null
    const code = hexToBytes(await rpc.getCode(impl, block))
    if (!code.length) return null
    const implEntry = await this.lookup(code)
    return implEntry ? versionOf(implEntry) : null
  }
}
