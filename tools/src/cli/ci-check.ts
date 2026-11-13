// The data repo's own CI (every push and PR): schema validation, generated files equal what the
// generator produces, entries of one code length mask the same bytes (so a lookup matches at most
// one entry), and entries/ and tags/ are append-only relative to the base commit.
//   node tools/src/cli/ci-check.ts [--base <rev>]
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { listSources, loadSourceConfig } from '../lib/config.ts'
import { SourceData } from '../lib/datarepo.ts'
import { rangeConflictReport, rangeConflicts } from '../lib/ranges.ts'
import { validateDataRepo } from '../lib/schema.ts'

const { values: a } = parseArgs({ options: { 'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') }, base: { type: 'string' } } })
const root = path.resolve(a['data-repo']!)
const sources = listSources(root).map(s => loadSourceConfig(root, s))
let failed = false

const schemaErrors = validateDataRepo(root, sources)
for (const e of schemaErrors) console.error(`schema: ${e}`)
console.error(schemaErrors.length ? `schema validation: ${schemaErrors.length} error(s)` : 'schema validation: ok')
failed ||= schemaErrors.length > 0

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
  // Write-once: any modification, deletion or rename under entries/ or tags/ fails.
  const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', `${a.base}...HEAD`], { cwd: root, encoding: 'utf8' }).trim()
  const violations = diff ? diff.split('\n').filter(l => {
    const [status, file] = l.split('\t')
    return status !== 'A' && sources.some(s => file.startsWith(`${s.directory}/entries/`) || file.startsWith(`${s.directory}/tags/`))
  }) : []
  for (const v of violations) console.error(`append-only: ${v}`)
  console.error(violations.length ? `append-only: ${violations.length} violation(s)` : `append-only: ok (against ${a.base})`)
  failed ||= violations.length > 0
} else {
  console.error('append-only: skipped (no --base)')
}
process.exit(failed ? 1 : 0)
