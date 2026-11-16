import * as fs from 'node:fs'
import * as path from 'node:path'
import { listSources, loadSourceConfig, type ReviewedRangePair } from './config.ts'
import { listJsonFiles, readJson, sortedRecord, stableJson, writeFileIfChanged } from './json.ts'
import { BY_LENGTH_DIR, INDEX_PATH, byLengthPath, inputPath, sourceDir } from './layout.ts'
import { rangeConflicts, type RangeConflict } from './ranges.ts'
import { compareTags } from './semver.ts'
import { SCHEMA_VERSION, VIEW_SCHEMA_VERSION } from './types.ts'
import type { BranchFile, BuiltContract, ByLengthEntry, ByLengthFile, ContractRole, Entry, Getter, Hex, IndexFile, RoleConfig, TagFile } from './types.ts'

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
    ...(e.beaconSlot !== undefined ? { beaconSlot: e.beaconSlot } : {}),
    codeLength: e.codeLength,
    maskedRanges: e.maskedRanges.map(r => ({ name: r.name, type: r.type, offsets: r.offsets, length: r.length })),
    cborMetadataLength: e.cborMetadataLength,
    getters: e.getters.map(g => ({ signature: g.signature, selector: g.selector, kind: g.kind })),
    selectors: e.selectors,
    compiler: e.compiler,
    ref: e.ref,
    commit: e.commit,
  }
  if (e.label !== undefined) out.label = e.label
  if (e.notes !== undefined) out.notes = e.notes
  return out
}

/**
 * The entry for one fingerprint's contracts from a build of `from.commit`, reached through
 * `from.ref` (a tag, or a branch whose head it is). A manual entry also has a `label` (and maybe
 * `notes`), and its `ref` and `commit` may be null. `packages` lists the contracts compiled from a
 * dependency package; the role comes from sources.json `contractRoles` (see `roleOf`).
 */
export function entryFromBuild(repo: string, contracts: BuiltContract[], from: Pick<Entry, 'ref' | 'commit' | 'label' | 'notes'>, roles: Record<string, RoleConfig>): Entry {
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
    ref: from.ref,
    commit: from.commit,
    label: from.label,
    notes: from.notes,
  })
}

/**
 * The role of contracts that share one fingerprint. They are the same code, so they must have the
 * same role in `contractRoles` (an unlisted contract is logic), slots and beacon slot included; a
 * disagreement is a config error.
 */
export function roleOf(roles: Record<string, RoleConfig>, fqNames: string[]): Pick<Entry, 'role' | 'implementationSlots' | 'beaconSlot'> {
  const each = fqNames.map(n => roles[n] ?? { role: 'logic' as const })
  if (new Set(each.map(describeRole)).size > 1) {
    throw new Error(`contracts with one fingerprint have different roles in contractRoles; list each with the same role: ${fqNames.map((n, i) => `${n}: ${describeRole(each[i])}`).join('; ')}`)
  }
  const r = each[0]
  if (r.role !== 'proxy') return { role: r.role }
  return 'beaconSlot' in r
    ? { role: 'proxy', beaconSlot: r.beaconSlot.toLowerCase() as Hex }
    : { role: 'proxy', implementationSlots: r.implementationSlots.map(x => x.toLowerCase() as Hex) }
}

/**
 * A role as people read it, and as roles are compared (`roleOf`, and publish's check of code
 * another source owns): `logic`, `proxy-admin`, `proxy [<slots>]`, or `proxy [beacon <slot>]` for
 * a beacon proxy. Takes a `contractRoles` value, or an entry's `role`, `implementationSlots` and
 * `beaconSlot`.
 */
export function describeRole(r: { role: ContractRole; implementationSlots?: Hex[]; beaconSlot?: Hex }): string {
  if (r.role !== 'proxy') return r.role
  const slots = [...(r.implementationSlots ?? []), ...(r.beaconSlot !== undefined ? [`beacon ${r.beaconSlot}`] : [])]
  return `proxy [${slots.join(', ').toLowerCase()}]`
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

/** One source's input files, under `registry/<source>/` (see `layout.ts`). */
export class SourceData {
  readonly root: string
  /** The source's id: its `directory` in sources.json, e.g. `nitro-contracts`. */
  readonly id: string
  readonly repo: string
  /** `<data repo>/registry/<source>`. */
  readonly dir: string

  constructor(dataRepoRoot: string, id: string, repo: string) {
    this.root = dataRepoRoot
    this.id = id
    this.dir = path.join(dataRepoRoot, sourceDir(id))
    this.repo = repo
  }

  entryPath(fp: string): string { return path.join(this.root, inputPath(this.id, 'entries', fp.toLowerCase())) }
  tagPath(tag: string): string { return path.join(this.root, inputPath(this.id, 'tags', tag)) }
  /** Branch names containing `/` become nested paths. */
  branchPath(branch: string): string { return path.join(this.root, inputPath(this.id, 'branches', branch)) }

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

  inputs(): SourceInputs {
    return { id: this.id, repo: this.repo, entries: this.entries(), tags: this.tags(), branches: this.branches() }
  }
}

/**
 * The whole data repo: every configured source's inputs, and the views generated from all of
 * them together (`registry/by-length/`, `registry/index.json`).
 */
export class DataRepo {
  readonly root: string
  /** In source id order. */
  readonly sources: SourceData[]

  /** Every source's reviewed range pairs, in source id order. */
  private readonly pairs: ReviewedRangePair[]

  constructor(root: string, sources: { directory: string; repo: string; reviewedRangePairs?: ReviewedRangePair[] }[]) {
    this.root = root
    const ordered = [...sources].sort((a, b) => compareIds(a.directory, b.directory))
    this.sources = ordered.map(s => new SourceData(root, s.directory, s.repo))
    this.pairs = ordered.flatMap(s => s.reviewedRangePairs ?? [])
  }

  /** The data repo with the sources configured under `config/`. */
  static open(root: string): DataRepo {
    return new DataRepo(root, listSources(root).map(s => loadSourceConfig(root, s)))
  }

  source(id: string): SourceData {
    const s = this.sources.find(x => x.id === id)
    if (!s) throw new Error(`no configured source ${id} (configured: ${this.sources.map(x => x.id).join(', ') || 'none'})`)
    return s
  }

  /**
   * The source whose `entries/` holds the fingerprint's entry (its owner), or null if none does.
   * A fingerprint has at most one entry in the whole registry (see `entryProblems`), so publish
   * and `add-entry` look it up here, across every source, before writing one.
   */
  ownerOf(fp: string): SourceData | null {
    return this.sources.find(s => s.hasEntry(fp)) ?? null
  }

  /** Every source's entries, each with its source's id, in source id order. */
  allEntries(): SourcedEntry[] {
    return this.sources.flatMap(s => s.entries().map(e => ({ ...e, source: s.id })))
  }

  /** The union of every source's `reviewedRangePairs`: a pair counts whichever config lists it. */
  reviewedRangePairs(): ReviewedRangePair[] {
    return [...this.pairs]
  }

  /**
   * The range invariant across every source (see `rangeConflicts`): every entry on disk, plus
   * `extra` (entries about to be written), against the union of reviewed pairs. Throws if an
   * entry's ranges lie outside its code.
   */
  rangeConflicts(extra: SourcedEntry[] = []): RangeConflict<SourcedEntry>[] {
    return rangeConflicts([...this.allEntries(), ...extra], this.pairs)
  }

  /**
   * The rules that tie the sources' files together: no fingerprint has an entry in two sources'
   * directories, and every fingerprint a tag or branch file lists has an entry in some source
   * (code that several sources build has one entry, in the source that published it first).
   */
  entryProblems(): string[] {
    const problems: string[] = []
    const owners = new Map<string, string[]>()
    for (const s of this.sources) {
      for (const e of s.entries()) {
        const fp = String(e.fingerprint).toLowerCase()
        owners.set(fp, [...(owners.get(fp) ?? []), s.id])
      }
    }
    for (const [fp, ids] of owners) {
      if (ids.length > 1) problems.push(`${fp} has an entry in more than one source: ${ids.map(id => inputPath(id, 'entries', fp)).join(', ')}`)
    }
    for (const s of this.sources) {
      const files = [
        ...s.tags().map(t => ({ path: inputPath(s.id, 'tags', t.tag), contracts: t.contracts })),
        ...s.branches().map(b => ({ path: inputPath(s.id, 'branches', b.branch), contracts: b.contracts })),
      ]
      for (const f of files) {
        for (const [contract, fp] of Object.entries(f.contracts ?? {})) {
          if (!owners.has(String(fp).toLowerCase())) problems.push(`${f.path}: ${contract} has fingerprint ${fp}, which has no entry in any source`)
        }
      }
    }
    return problems.sort()
  }

  /** Every generated file, keyed by its path relative to the data repo root. */
  generateViews(): Map<string, string> {
    return generateViews(this.sources.map(s => s.inputs()))
  }

  /** Rewrites the generated views, deleting stale shards. Returns true if anything changed. */
  writeViews(): boolean {
    const views = this.generateViews()
    let changed = false
    for (const f of listJsonFiles(path.join(this.root, BY_LENGTH_DIR))) {
      if (!views.has(relPath(this.root, f))) { fs.rmSync(f); changed = true }
    }
    for (const [rel, content] of views) changed = writeFileIfChanged(path.join(this.root, rel), content) || changed
    return changed
  }

  /** How the views on disk differ from what the inputs generate; empty if they match. */
  viewProblems(): string[] {
    const problems: string[] = []
    const have = new Set(listJsonFiles(path.join(this.root, BY_LENGTH_DIR)).map(f => relPath(this.root, f)))
    if (fs.existsSync(path.join(this.root, INDEX_PATH))) have.add(INDEX_PATH)
    for (const [rel, content] of this.generateViews()) {
      if (!have.has(rel)) problems.push(`missing generated file ${rel}`)
      else if (fs.readFileSync(path.join(this.root, rel), 'utf8') !== content) problems.push(`${rel} differs from what the input files generate`)
      have.delete(rel)
    }
    for (const rel of have) problems.push(`stale generated file ${rel}`)
    return problems
  }
}

/**
 * An entry and the id of the source whose directory holds it (its owner). `source` is not part of
 * the entry file: `writeEntry` leaves it out.
 */
export type SourcedEntry = Entry & { source: string }

/** One source's input files, as `generateViews` reads them. */
export interface SourceInputs {
  /** The source's id (its `directory`). */
  id: string
  repo: string
  entries: Entry[]
  tags: TagFile[]
  branches?: BranchFile[]
}

/**
 * Derives the views from every source's input files. Pure and deterministic.
 * - `registry/by-length/<len>.json`: every entry of that length, of every source, sorted by
 *   fingerprint, each with the tags of its own source's tag files (tag names overlap across
 *   sources, so one source's tags never label another's entry).
 * - `registry/index.json`: the code lengths present, and per source its repo and getters: those
 *   of its own entries and of every entry its tag and branch files reference.
 */
export function generateViews(sources: SourceInputs[]): Map<string, string> {
  const ordered = [...sources].sort((a, b) => compareIds(a.id, b.id))
  const byFp = new Map<string, Entry>()
  for (const s of ordered) for (const e of s.entries) if (!byFp.has(e.fingerprint.toLowerCase())) byFp.set(e.fingerprint.toLowerCase(), e)

  const byLen = new Map<number, ByLengthEntry[]>()
  const index: IndexFile = { schemaVersion: VIEW_SCHEMA_VERSION, codeLengths: [], sources: {} }
  for (const s of ordered) {
    const tagsByFp = new Map<string, string[]>()
    for (const t of s.tags) {
      for (const fp of new Set(Object.values(t.contracts).map(f => f.toLowerCase()))) tagsByFp.set(fp, [...(tagsByFp.get(fp) ?? []), t.tag])
    }
    for (const e of s.entries) {
      const row: ByLengthEntry = { ...canonicalEntry(e), tags: (tagsByFp.get(e.fingerprint.toLowerCase()) ?? []).sort(compareTags) }
      byLen.set(e.codeLength, [...(byLen.get(e.codeLength) ?? []), row])
    }
    const referenced = new Set([...s.tags, ...(s.branches ?? [])].flatMap(f => Object.values(f.contracts).map(fp => fp.toLowerCase())))
    const getters = new Map<string, Getter>()
    for (const e of [...s.entries, ...[...referenced].flatMap(fp => byFp.get(fp) ?? [])]) {
      for (const g of e.getters) getters.set(g.signature, { signature: g.signature, selector: g.selector, kind: g.kind })
    }
    index.sources[s.id] = { repo: s.repo, getters: [...getters.values()].sort((a, b) => a.signature.localeCompare(b.signature)) }
  }

  const out = new Map<string, string>()
  index.codeLengths = [...byLen.keys()].sort((a, b) => a - b)
  for (const len of index.codeLengths) {
    const entries = byLen.get(len)!.sort((a, b) => compareIds(a.fingerprint, b.fingerprint) || compareIds(a.repo, b.repo))
    const file: ByLengthFile = { schemaVersion: VIEW_SCHEMA_VERSION, codeLength: len, entries }
    out.set(byLengthPath(len), stableJson(file))
  }
  out.set(INDEX_PATH, stableJson(index))
  return out
}

/** Plain code-unit order, independent of locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `f`'s path relative to `root`, with `/` separators as in `layout.ts`. */
function relPath(root: string, f: string): string {
  return path.relative(root, f).split(path.sep).join('/')
}
