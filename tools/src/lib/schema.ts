import * as fs from 'node:fs'
import * as path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { listJsonFiles, readJson } from './json.ts'

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

/** Which schema a data repo file follows, from its path; null for files outside the data layout. */
export function kindOf(rel: string): FileKind | null {
  const parts = rel.split(path.sep)
  if (parts[0] === 'config') return parts.at(-1) === 'sources.json' ? 'sources' : parts.at(-1) === 'out-of-scope-getters.json' ? 'out-of-scope' : null
  if (parts.length === 2 && parts[1] === 'index.json') return 'index'
  if (parts[1] === 'entries') return 'entry'
  if (parts[1] === 'tags') return 'tag'
  if (parts[1] === 'branches') return 'branch'
  if (parts[1] === 'by-length') return 'by-length'
  return null
}

/**
 * Validates every config and data file, plus the invariants a schema can't express: file names
 * match their contents, and every source directory belongs to a configured source.
 */
export function validateDataRepo(dataRepo: string, sources: { directory: string; repo: string }[]): string[] {
  const v = new SchemaValidator(dataRepo)
  const errors: string[] = []
  const dirs = [path.join(dataRepo, 'config'), ...sources.map(s => path.join(dataRepo, s.directory))]
  for (const dir of dirs) {
    for (const f of listJsonFiles(dir)) {
      const rel = path.relative(dataRepo, f)
      const kind = kindOf(rel)
      if (!kind) { errors.push(`${rel}: unexpected file`); continue }
      let data: any
      try { data = readJson(f) } catch (e) { errors.push(`${rel}: invalid JSON: ${(e as Error).message}`); continue }
      for (const e of v.validate(kind, data)) errors.push(`${rel}: ${e}`)
      const src = sources.find(s => rel.startsWith(s.directory + path.sep))
      if (src && data.repo !== src.repo) errors.push(`${rel}: repo ${data.repo} != ${src.repo}`)
      const base = path.basename(f, '.json')
      if (kind === 'entry' && data.fingerprint !== base) errors.push(`${rel}: file name doesn't match fingerprint`)
      if (kind === 'tag' && data.tag !== path.relative(path.join(dataRepo, src!.directory, 'tags'), f).replace(/\.json$/, '')) errors.push(`${rel}: file name doesn't match tag`)
      if (kind === 'branch' && data.branch !== path.relative(path.join(dataRepo, src!.directory, 'branches'), f).replace(/\.json$/, '')) errors.push(`${rel}: file name doesn't match branch`)
      if (kind === 'by-length' && String(data.codeLength) !== base) errors.push(`${rel}: file name doesn't match codeLength`)
    }
  }
  return errors
}
