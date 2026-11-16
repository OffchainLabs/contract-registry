/**
 * Where data files live in the registry repo. Every path is relative to the repo root and uses
 * `/`, so the walker can read it from any snapshot (a directory, a commit, raw files over HTTP).
 *
 *   config/<source>/sources.json                  per source, unchanged location
 *   config/<source>/out-of-scope-getters.json
 *   registry/<source>/entries/<fingerprint>.json  inputs, per source
 *   registry/<source>/tags/<tag>.json
 *   registry/<source>/branches/<branch>.json
 *   registry/by-length/<codeLength>.json          generated, all sources
 *   registry/index.json                           generated, all sources
 *
 * `<source>` is a source's `directory` in its sources.json, e.g. `nitro-contracts`. The name of
 * the data directory lives here and nowhere else in the code.
 */
export const DATA_DIR = 'registry'
export const CONFIG_DIR = 'config'
const BY_LENGTH = 'by-length'
const INDEX = 'index.json'

/** Names under `registry/` that belong to the generated views, so no source can use them as its id. */
export const RESERVED_NAMES: readonly string[] = [BY_LENGTH, INDEX]

/** The kinds of input file a source has, each in its own directory under `registry/<source>/`. */
export const INPUT_KINDS = ['entries', 'tags', 'branches'] as const
export type InputKind = (typeof INPUT_KINDS)[number]

export const BY_LENGTH_DIR = `${DATA_DIR}/${BY_LENGTH}`
export const INDEX_PATH = `${DATA_DIR}/${INDEX}`

export function byLengthPath(codeLength: number): string {
  return `${BY_LENGTH_DIR}/${codeLength}.json`
}

/** A source's input directory, `registry/<source>`. */
export function sourceDir(source: string): string {
  return `${DATA_DIR}/${source}`
}

/** `registry/<source>/<kind>/<name>.json`. Branch names containing `/` become nested paths. */
export function inputPath(source: string, kind: InputKind, name: string): string {
  return `${sourceDir(source)}/${kind}/${name}.json`
}

export function sourcesConfigPath(source: string): string {
  return `${CONFIG_DIR}/${source}/sources.json`
}

export function outOfScopePath(source: string): string {
  return `${CONFIG_DIR}/${source}/out-of-scope-getters.json`
}

/** What a path under `registry/` is, or null if it is no part of the layout. */
export type DataPath =
  | { view: 'by-length'; codeLength: number }
  | { view: 'index' }
  | { source: string; kind: InputKind; name: string }

export function parseDataPath(rel: string): DataPath | null {
  const parts = rel.split(/[\\/]/)
  if (parts[0] !== DATA_DIR) return null
  if (parts.length === 2 && parts[1] === INDEX) return { view: 'index' }
  if (parts[1] === BY_LENGTH) {
    const m = parts.length === 3 ? /^(\d+)\.json$/.exec(parts[2]) : null
    return m ? { view: 'by-length', codeLength: Number(m[1]) } : null
  }
  const kind = parts[2] as InputKind
  if (parts.length < 4 || RESERVED_NAMES.includes(parts[1]) || !INPUT_KINDS.includes(kind) || !rel.endsWith('.json')) return null
  return { source: parts[1], kind, name: parts.slice(3).join('/').replace(/\.json$/, '') }
}
