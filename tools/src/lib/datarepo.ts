import * as fs from 'node:fs'
import * as path from 'node:path'
import { listJsonFiles, readJson, sortedRecord, stableJson, writeFileIfChanged } from './json.ts'
import { compareTags } from './semver.ts'
import { SCHEMA_VERSION } from './types.ts'
import type { BranchFile, BuiltContract, ByLengthFile, Entry, Getter, Hex, IndexFile, RoleConfig, TagFile } from './types.ts'

/** Canonical key order for an entry file. */
export function canonicalEntry(e: Entry): Entry {
  const out: Entry = {
    schemaVersion: e.schemaVersion,
    fingerprint: e.fingerprint,
    repo: e.repo,
    contracts: [...e.contracts].sort(),
    ...(e.packages !== undefined ? { packages: sortedRecord(e.packages) } : {}),
    role: e.role,
    ...(e.implementationSlots !== undefined ? { implementationSlots: e.implementationSlots } : {}),
    codeLength: e.codeLength,
    maskedRanges: e.maskedRanges.map(r => ({ name: r.name, type: r.type, offsets: r.offsets, length: r.length })),
    cborMetadataLength: e.cborMetadataLength,
    getters: e.getters.map(g => ({ signature: g.signature, selector: g.selector, kind: g.kind })),
    selectors: e.selectors,
    compiler: e.compiler,
    firstCommit: e.firstCommit,
    firstBranch: e.firstBranch,
  }
  if (e.label !== undefined) out.label = e.label
  if (e.notes !== undefined) out.notes = e.notes
  return out
}

/**
 * The entry for one fingerprint's contracts from a build. `packages` lists the ones compiled from a
 * dependency package; the role comes from sources.json `contractRoles` (see `roleOf`).
 */
export function entryFromBuild(repo: string, contracts: BuiltContract[], firstCommit: string, firstBranch: string | null, roles: Record<string, RoleConfig>): Entry {
  const c = contracts[0]
  const packages = Object.fromEntries(contracts.filter(x => x.package !== null).map(x => [x.fqName, x.package!]))
  return canonicalEntry({
    schemaVersion: SCHEMA_VERSION,
    fingerprint: c.fingerprint,
    repo,
    contracts: contracts.map(x => x.fqName),
    ...(Object.keys(packages).length ? { packages } : {}),
    ...roleOf(roles, contracts.map(x => x.fqName)),
    codeLength: c.codeLength,
    maskedRanges: c.maskedRanges,
    cborMetadataLength: c.cborMetadataLength,
    getters: c.getters,
    selectors: c.selectors,
    compiler: c.compiler,
    firstCommit,
    firstBranch,
  })
}

/**
 * The role of contracts that share one fingerprint. They are the same code, so they must have the
 * same role in `contractRoles` (an unlisted contract is logic); a disagreement is a config error.
 */
export function roleOf(roles: Record<string, RoleConfig>, fqNames: string[]): Pick<Entry, 'role' | 'implementationSlots'> {
  const each = fqNames.map(n => roles[n] ?? { role: 'logic' as const })
  const describe = (r: RoleConfig | { role: 'logic' }) => r.role === 'proxy' ? `proxy [${r.implementationSlots.join(', ').toLowerCase()}]` : r.role
  if (new Set(each.map(describe)).size > 1) {
    throw new Error(`contracts with one fingerprint have different roles in contractRoles; list each with the same role: ${fqNames.map((n, i) => `${n}: ${describe(each[i])}`).join('; ')}`)
  }
  const r = each[0]
  return r.role === 'proxy' ? { role: 'proxy', implementationSlots: r.implementationSlots.map(x => x.toLowerCase() as Hex) } : { role: r.role }
}

/** Groups a build's contracts by fingerprint (several names can compile to the same code). */
export function byFingerprint(contracts: BuiltContract[]): Map<Hex, BuiltContract[]> {
  const m = new Map<Hex, BuiltContract[]>()
  for (const c of contracts) m.set(c.fingerprint, [...(m.get(c.fingerprint) ?? []), c])
  return m
}

export function contractsMap(contracts: BuiltContract[]): Record<string, Hex> {
  return sortedRecord(Object.fromEntries(contracts.map(c => [c.fqName, c.fingerprint])))
}

/** One source repo's directory in the data repo. */
export class SourceData {
  readonly root: string
  readonly repo: string
  readonly dir: string

  constructor(dataRepoRoot: string, directory: string, repo: string) {
    this.root = dataRepoRoot
    this.dir = path.join(dataRepoRoot, directory)
    this.repo = repo
  }

  entryPath(fp: string): string { return path.join(this.dir, 'entries', `${fp.toLowerCase()}.json`) }
  tagPath(tag: string): string { return path.join(this.dir, 'tags', `${tag}.json`) }
  /** Branch names containing `/` become nested paths. */
  branchPath(branch: string): string { return path.join(this.dir, 'branches', `${branch}.json`) }

  hasEntry(fp: string): boolean { return fs.existsSync(this.entryPath(fp)) }
  hasTag(tag: string): boolean { return fs.existsSync(this.tagPath(tag)) }

  /** Entries are write-once: refuses to overwrite. */
  writeEntry(e: Entry): void {
    const f = this.entryPath(e.fingerprint)
    if (fs.existsSync(f)) throw new Error(`entry ${e.fingerprint} already exists (entries are write-once)`)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, stableJson(canonicalEntry(e)))
  }

  /** Tag files are write-once: refuses to overwrite. */
  writeTag(t: TagFile): void {
    const f = this.tagPath(t.tag)
    if (fs.existsSync(f)) throw new Error(`tag file ${t.tag} already exists (tag files are write-once)`)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, stableJson({
      schemaVersion: t.schemaVersion, repo: t.repo, tag: t.tag, commit: t.commit, prerelease: t.prerelease,
      packageVersion: t.packageVersion, contracts: sortedRecord(t.contracts),
    }))
  }

  writeBranch(b: BranchFile): boolean {
    return writeFileIfChanged(this.branchPath(b.branch), stableJson({
      schemaVersion: b.schemaVersion, repo: b.repo, branch: b.branch, commit: b.commit, contracts: sortedRecord(b.contracts),
    }))
  }

  deleteBranch(branch: string): void {
    const f = this.branchPath(branch)
    fs.rmSync(f, { force: true })
    // Remove now-empty parent directories of nested branch paths.
    let d = path.dirname(f)
    const stop = path.join(this.dir, 'branches')
    while (d.startsWith(stop) && d !== stop && fs.existsSync(d) && fs.readdirSync(d).length === 0) {
      fs.rmdirSync(d)
      d = path.dirname(d)
    }
  }

  readEntry(fp: string): Entry { return readJson(this.entryPath(fp)) }
  entries(): Entry[] { return listJsonFiles(path.join(this.dir, 'entries')).map(f => readJson<Entry>(f)) }
  tags(): TagFile[] { return listJsonFiles(path.join(this.dir, 'tags')).map(f => readJson<TagFile>(f)) }
  branches(): BranchFile[] { return listJsonFiles(path.join(this.dir, 'branches')).map(f => readJson<BranchFile>(f)) }

  /** Every file that `generateViews` derives, keyed by path relative to the data repo root. */
  generateViews(): Map<string, string> {
    return generateViews(this.repo, path.relative(this.root, this.dir), this.entries(), this.tags())
  }

  /** Rewrites the generated views, deleting stale ones. Returns true if anything changed. */
  writeViews(): boolean {
    const views = this.generateViews()
    let changed = false
    for (const f of listJsonFiles(path.join(this.dir, 'by-length'))) {
      if (!views.has(path.relative(this.root, f))) { fs.rmSync(f); changed = true }
    }
    for (const [rel, content] of views) changed = writeFileIfChanged(path.join(this.root, rel), content) || changed
    return changed
  }
}

/**
 * Derives `by-length/<len>.json` (every entry of that length with its tags) and `index.json`
 * (code lengths present and every getter known) from the input files. Pure and deterministic.
 */
export function generateViews(repo: string, directory: string, entries: Entry[], tags: TagFile[]): Map<string, string> {
  const tagsByFp = new Map<string, string[]>()
  for (const t of tags) {
    for (const fp of new Set(Object.values(t.contracts).map(f => f.toLowerCase()))) {
      tagsByFp.set(fp, [...(tagsByFp.get(fp) ?? []), t.tag])
    }
  }
  const byLen = new Map<number, Entry[]>()
  for (const e of entries) byLen.set(e.codeLength, [...(byLen.get(e.codeLength) ?? []), e])
  const out = new Map<string, string>()
  const lengths = [...byLen.keys()].sort((a, b) => a - b)
  for (const len of lengths) {
    const file: ByLengthFile = {
      schemaVersion: SCHEMA_VERSION,
      repo,
      codeLength: len,
      entries: byLen.get(len)!
        .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
        .map(e => ({ ...canonicalEntry(e), tags: (tagsByFp.get(e.fingerprint.toLowerCase()) ?? []).sort(compareTags) })),
    }
    out.set(path.join(directory, 'by-length', `${len}.json`), stableJson(file))
  }
  const getters = new Map<string, Getter>()
  for (const e of entries) for (const g of e.getters) getters.set(g.signature, { signature: g.signature, selector: g.selector, kind: g.kind })
  const index: IndexFile = {
    schemaVersion: SCHEMA_VERSION,
    repo,
    codeLengths: lengths,
    getters: [...getters.values()].sort((a, b) => a.signature.localeCompare(b.signature)),
  }
  out.set(path.join(directory, 'index.json'), stableJson(index))
  return out
}
