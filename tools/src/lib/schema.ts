import * as fs from 'node:fs'
import * as path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { listJsonFiles, readJson } from './json.ts'
import { BY_LENGTH_DIR, CONFIG_DIR, DATA_DIR, INDEX_PATH, RESERVED_NAMES, outOfScopePath, parseDataPath, sourceDir } from './layout.ts'

const KINDS = ['entry', 'tag', 'branch', 'by-length', 'index', 'sources', 'out-of-scope'] as const
export type FileKind = (typeof KINDS)[number]

export class SchemaValidator {
  private readonly ajv: Ajv2020

  constructor(dataRepo: string) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false })
    const dir = path.join(dataRepo, 'schema')
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.schema.json'))) this.ajv.addSchema(readJson(path.join(dir, f)))
  }

  validate(kind: FileKind, data: unknown): string[] {
    const v = this.ajv.getSchema(`https://contract-registry/schema/${kind}.schema.json`)
    if (!v) throw new Error(`no schema for ${kind}`)
    return v(data) ? [] : (v.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`)
  }
}

/** Which schema a data repo file follows, from its path (relative to the root); null for files outside the layout. */
export function kindOf(rel: string): FileKind | null {
  const parts = rel.split(/[\\/]/)
  if (parts[0] === CONFIG_DIR) return parts.at(-1) === 'sources.json' ? 'sources' : parts.at(-1) === 'out-of-scope-getters.json' ? 'out-of-scope' : null
  const p = parseDataPath(rel)
  if (!p) return null
  if ('view' in p) return p.view
  return p.kind === 'entries' ? 'entry' : p.kind === 'tags' ? 'tag' : 'branch'
}

/**
 * Validates every config and data file, plus the invariants a schema can't express: file names
 * match their contents, an entry's packages name only its own contracts, and every file in a
 * source's directory has that source's repo. The combined views are checked against what the
 * inputs generate elsewhere (`DataRepo.viewProblems`).
 */
export function validateDataRepo(dataRepo: string, sources: { directory: string; repo: string }[]): string[] {
  const v = new SchemaValidator(dataRepo)
  const errors: string[] = []
  const files = [CONFIG_DIR, BY_LENGTH_DIR, ...sources.map(s => sourceDir(s.directory))].flatMap(d => listJsonFiles(path.join(dataRepo, d)))
  if (fs.existsSync(path.join(dataRepo, INDEX_PATH))) files.push(path.join(dataRepo, INDEX_PATH))
  for (const f of files) {
    const rel = path.relative(dataRepo, f).split(path.sep).join('/')
    const kind = kindOf(rel)
    if (!kind) { errors.push(`${rel}: unexpected file`); continue }
    let data: any
    try { data = readJson(f) } catch (e) { errors.push(`${rel}: invalid JSON: ${(e as Error).message}`); continue }
    for (const e of v.validate(kind, data)) errors.push(`${rel}: ${e}`)
    const p = parseDataPath(rel)
    if (!p) continue // config
    if ('view' in p) {
      if (p.view === 'by-length' && data.codeLength !== p.codeLength) errors.push(`${rel}: file name doesn't match codeLength`)
      continue
    }
    const src = sources.find(s => s.directory === p.source)!
    if (data.repo !== src.repo) errors.push(`${rel}: repo ${data.repo} != ${src.repo}`)
    if (kind === 'entry' && data.fingerprint !== p.name) errors.push(`${rel}: file name doesn't match fingerprint`)
    if (kind === 'entry') for (const c of Object.keys(data.packages ?? {})) if (!data.contracts?.includes(c)) errors.push(`${rel}: packages names ${c}, which isn't in contracts`)
    if (kind === 'tag' && data.tag !== p.name) errors.push(`${rel}: file name doesn't match tag`)
    if (kind === 'branch' && data.branch !== p.name) errors.push(`${rel}: file name doesn't match branch`)
  }
  return errors
}

/**
 * Rules across the source configs: each lives in `config/<its directory>/`, no two share a
 * `directory`, a `repo` or an npm package, and none uses a name the generated views need. Each
 * one's `outOfScopeGetters` is `config/<directory>/out-of-scope-getters.json`, the file the walker
 * reads (`outOfScopePath`): publish's test-chain check reads the field, so another file would
 * check walks against one list and leave the walker to use another. A package belongs to one
 * source: publish refuses it in every other source's builds (see `foreignOrigin`).
 */
export function sourceConfigProblems(configs: { configDir: string; directory: string; repo: string; outOfScopeGetters: string; npmPackages?: string[] }[]): string[] {
  const problems: string[] = []
  for (const c of configs) {
    if (c.directory !== c.configDir) problems.push(`${CONFIG_DIR}/${c.configDir}/sources.json: directory ${c.directory} must equal its config directory's name, ${c.configDir}`)
    if (RESERVED_NAMES.includes(c.directory)) problems.push(`${CONFIG_DIR}/${c.configDir}/sources.json: directory ${c.directory} is reserved for the generated views`)
    const walkerReads = outOfScopePath(c.directory)
    if (path.posix.normalize(c.outOfScopeGetters) !== walkerReads) problems.push(`${CONFIG_DIR}/${c.configDir}/sources.json: outOfScopeGetters is ${c.outOfScopeGetters}, but the walker reads ${walkerReads}; make it that file`)
  }
  for (const key of ['directory', 'repo'] as const) {
    const seen = new Map<string, string[]>()
    for (const c of configs) seen.set(c[key], [...(seen.get(c[key]) ?? []), c.configDir])
    for (const [value, dirs] of seen) if (dirs.length > 1) problems.push(`${key} ${value} is configured by more than one source: ${dirs.map(d => `${CONFIG_DIR}/${d}/sources.json`).join(', ')}`)
  }
  const listedBy = new Map<string, string[]>()
  for (const c of configs) for (const p of new Set(c.npmPackages ?? [])) listedBy.set(p, [...(listedBy.get(p) ?? []), c.configDir])
  for (const [p, dirs] of listedBy) if (dirs.length > 1) problems.push(`npm package ${p} is in the npmPackages of more than one source: ${dirs.map(d => `${CONFIG_DIR}/${d}/sources.json`).join(', ')}`)
  return problems
}

/**
 * Data outside the layout: a configured source's directory at the top of the repo (the layout
 * before `registry/`), and anything under `registry/` other than a configured source's directory,
 * `by-length/` and `index.json`. Catches data written by tools that predate the layout.
 */
export function strayLayout(dataRepo: string, sources: { directory: string }[]): string[] {
  const problems: string[] = []
  const ids = new Set(sources.map(s => s.directory))
  for (const d of fs.readdirSync(dataRepo, { withFileTypes: true })) {
    if (ids.has(d.name)) problems.push(`${d.name}${d.isDirectory() ? '/' : ''}: a source's data at the top of the repo; it belongs in ${sourceDir(d.name)}/`)
  }
  const data = path.join(dataRepo, DATA_DIR)
  if (!fs.existsSync(data)) return problems
  for (const d of fs.readdirSync(data, { withFileTypes: true })) {
    const ok = d.isDirectory() ? ids.has(d.name) || `${DATA_DIR}/${d.name}` === BY_LENGTH_DIR : `${DATA_DIR}/${d.name}` === INDEX_PATH
    if (!ok) problems.push(`${DATA_DIR}/${d.name}${d.isDirectory() ? '/' : ''}: not a configured source's directory, ${BY_LENGTH_DIR}/ or ${INDEX_PATH}`)
  }
  return problems
}
