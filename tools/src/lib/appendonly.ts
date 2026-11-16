import { git } from './exec.ts'
import { CONFIG_DIR, inputPath, parseDataPath } from './layout.ts'

/** The blob id of every file in a commit's tree, by path. */
export function treeBlobs(repoDir: string, rev: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rec of git(['ls-tree', '-r', '-z', rev], repoDir).split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    const [, type, oid] = rec.slice(0, tab).split(' ')
    if (type === 'blob') out.set(rec.slice(tab + 1), oid)
  }
  return out
}

/** The source ids configured in a tree: the directories under `config/` with a sources.json. */
export function configuredIds(tree: Map<string, string>): string[] {
  return [...tree.keys()].flatMap(p => {
    const m = new RegExp(`^${CONFIG_DIR}/([^/]+)/sources\\.json$`).exec(p)
    return m ? [m[1]] : []
  })
}

/**
 * entries/ and tags/ files are write-once. Compares content, not paths: every such file at the
 * base, in either layout (`<source>/<kind>/...`, before `registry/`, or
 * `registry/<source>/<kind>/...`), must be at HEAD with the same blob, at its place in the current
 * layout. So moving a file into `registry/` passes, and changing or deleting one fails, whether or
 * not it moved. `sources` are the ids whose top-level directories count as the old layout.
 */
export function appendOnlyViolations(base: Map<string, string>, head: Map<string, string>, sources: Iterable<string>): string[] {
  const ids = new Set(sources)
  const violations: string[] = []
  for (const [p, blob] of base) {
    const at = writeOnceFile(p, ids)
    if (!at) continue
    const target = inputPath(at.source, at.kind, at.name)
    const now = head.get(target)
    const moved = p === target ? '' : ` (moved to ${target})`
    if (now === undefined) violations.push(`deleted ${p}${p === target ? '' : ` (no ${target})`}`)
    else if (now !== blob) violations.push(`modified ${p}${moved}`)
  }
  return violations.sort()
}

function writeOnceFile(p: string, oldLayoutIds: Set<string>): { source: string; kind: 'entries' | 'tags'; name: string } | null {
  const d = parseDataPath(p)
  if (d && 'kind' in d) return d.kind === 'branches' ? null : { source: d.source, kind: d.kind, name: d.name }
  const m = /^([^/]+)\/(entries|tags)\/(.+)\.json$/.exec(p)
  return m && oldLayoutIds.has(m[1]) ? { source: m[1], kind: m[2] as 'entries' | 'tags', name: m[3] } : null
}
