// The data repo's own CI (every push and PR): source configs agree with each other, schema
// validation, nothing outside the layout, generated files equal what the generator produces, one
// entry per fingerprint across sources and an entry for every fingerprint a tag or branch file
// lists, entries of one code length mask the same bytes across sources (so a lookup matches at
// most one entry), and entries/ and tags/ files are append-only relative to the base commit.
//   node tools/src/cli/ci-check.ts [--base <rev>]
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { appendOnlyViolations, configuredIds, treeBlobs } from '../lib/appendonly.ts'
import { listSources, loadSourceConfig } from '../lib/config.ts'
import { DataRepo } from '../lib/datarepo.ts'
import { git } from '../lib/exec.ts'
import { DATA_DIR } from '../lib/layout.ts'
import { rangeConflictReport } from '../lib/ranges.ts'
import { sourceConfigProblems, strayLayout, validateDataRepo } from '../lib/schema.ts'

const { values: a } = parseArgs({ options: { 'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') }, base: { type: 'string' } } })
const root = path.resolve(a['data-repo']!)
const configs = listSources(root).map(s => ({ configDir: s, cfg: loadSourceConfig(root, s) }))
const sources = configs.map(c => c.cfg)
let failed = false

const report = (what: string, problems: string[], ok: string) => {
  for (const p of problems) console.error(`${what}: ${p}`)
  console.error(problems.length ? `${what}: ${problems.length} problem(s)` : `${what}: ok${ok ? ` (${ok})` : ''}`)
  failed ||= problems.length > 0
}

report('sources', sourceConfigProblems(configs.map(c => ({ configDir: c.configDir, directory: c.cfg.directory, repo: c.cfg.repo }))), 'unique directories and repos')

const schemaErrors = validateDataRepo(root, sources)
for (const e of schemaErrors) console.error(`schema: ${e}`)
console.error(schemaErrors.length ? `schema validation: ${schemaErrors.length} error(s)` : 'schema validation: ok')
failed ||= schemaErrors.length > 0

report('layout', strayLayout(root, sources), `every data file under ${DATA_DIR}/`)

try {
  execFileSync(process.execPath, [path.join(import.meta.dirname, 'generate.ts'), '--check', '--data-repo', root], { stdio: 'inherit' })
} catch { failed = true }

const repo = new DataRepo(root, sources)
try {
  report('entries', repo.entryProblems(), 'one entry per fingerprint across sources; every tag and branch fingerprint has one')
} catch (e) {
  console.error(`entries: can't check: ${(e as Error).message}`)
  failed = true
}

// Every entry of every source, manual ones included, against the reviewed pairs of every config:
// a lookup searches all sources at once.
try {
  const found = repo.rangeConflicts()
  if (found.length) {
    for (const l of rangeConflictReport(found).split('\n')) console.error(`ranges: ${l}`)
    console.error(`ranges: ${found.length} conflicting pair(s)`)
  } else {
    console.error('ranges: ok (entries of one code length mask the same bytes, across sources)')
  }
  failed ||= found.length > 0
} catch (e) {
  console.error(`ranges: can't check: ${(e as Error).message}`)
  failed = true
}

if (a.base) {
  // Write-once: every entries/ or tags/ file at the merge base is at HEAD with the same content,
  // in the current layout (so a file moved into registry/ passes; a change or deletion fails).
  const mergeBase = git(['merge-base', a.base, 'HEAD'], root).trim()
  const base = treeBlobs(root, mergeBase)
  const ids = new Set([...sources.map(s => s.directory), ...configuredIds(base)])
  const violations = appendOnlyViolations(base, treeBlobs(root, 'HEAD'), ids)
  for (const v of violations) console.error(`append-only: ${v}`)
  console.error(violations.length ? `append-only: ${violations.length} violation(s)` : `append-only: ok (against ${a.base})`)
  failed ||= violations.length > 0
} else {
  console.error('append-only: skipped (no --base)')
}
process.exit(failed ? 1 : 0)
