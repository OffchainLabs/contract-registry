// Regenerates registry/by-length/ and registry/index.json from every configured source's input
// files (registry/<source>/entries/, tags/ and branches/).
//   node tools/src/cli/generate.ts [--check]
// With --check, writes nothing and exits 1 if the committed files differ from what the inputs give.
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { DataRepo } from '../lib/datarepo.ts'

const { values: a } = parseArgs({ options: { 'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') }, check: { type: 'boolean', default: false } } })
const data = DataRepo.open(path.resolve(a['data-repo']!))
if (!a.check) {
  data.writeViews()
  process.exit(0)
}
const problems = data.viewProblems()
for (const p of problems) console.error(p)
console.error(problems.length ? `${problems.length} generated file(s) out of date` : 'generated files match their inputs')
process.exit(problems.length ? 1 : 0)
