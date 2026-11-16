// The data repo's own CI (every push and PR): source configs agree with each other, schema
// validation, nothing outside the layout, generated files equal what the generator produces,
// entries of one code length mask the same bytes (so a lookup matches at most one entry), and
// entries/ and tags/ files are append-only relative to the base commit.
//   node tools/src/cli/ci-check.ts [--base <rev>]
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { appendOnlyViolations, configuredIds, treeBlobs } from '../lib/appendonly.ts'
import { listSources, loadSourceConfig } from '../lib/config.ts'
import { SourceData } from '../lib/datarepo.ts'
import { git } from '../lib/exec.ts'
import { rangeConflictReport, rangeConflicts } from '../lib/ranges.ts'
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

report('layout', strayLayout(root, sources), 'every data file under registry/')

try {
  execFileSync(process.execPath, [path.join(import.meta.dirname, 'generate.ts'), '--check', '--data-repo', root], { stdio: 'inherit' })
} catch { failed = true }

// Every entry of each source, manual ones included, against the reviewed pairs in its config.
let conflicts = 0, unchecked = 0
for (const s of sources) {
  try {
    const found = rangeConflicts(new SourceData(root, s.directory, s.repo).entries(), s.reviewedRangePairs ?? [])
    if (found.length) for (const l of rangeConflictReport(s.directory, found).split('\n')) console.error(`ranges: ${l}`)
    conflicts += found.length
  } catch (e) {
    console.error(`ranges: ${s.directory}: can't check: ${(e as Error).message}`)
    unchecked++
  }
}
if (conflicts || unchecked) console.error(`ranges: ${conflicts} conflicting pair(s)${unchecked ? `, ${unchecked} source(s) not checked` : ''}`)
else console.error('ranges: ok (entries of one code length mask the same bytes)')
failed ||= conflicts > 0 || unchecked > 0

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
