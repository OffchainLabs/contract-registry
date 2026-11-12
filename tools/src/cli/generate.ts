// Regenerates by-length/ and index.json from entries/ and tags/ for every source repo.
//   node tools/src/cli/generate.ts [--check]
// With --check, writes nothing and exits 1 if the committed files differ from what the inputs give.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { listSources, loadSourceConfig } from '../lib/config.ts'
import { SourceData } from '../lib/datarepo.ts'
import { listJsonFiles } from '../lib/json.ts'

const { values: a } = parseArgs({ options: { 'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') }, check: { type: 'boolean', default: false } } })
const root = path.resolve(a['data-repo']!)
let bad = 0
for (const s of listSources(root)) {
  const cfg = loadSourceConfig(root, s)
  const data = new SourceData(root, cfg.directory, cfg.repo)
  if (!a.check) { data.writeViews(); continue }
  const want = data.generateViews()
  const have = new Set([...listJsonFiles(path.join(root, cfg.directory, 'by-length')), path.join(root, cfg.directory, 'index.json')].filter(f => fs.existsSync(f)).map(f => path.relative(root, f)))
  for (const [rel, content] of want) {
    if (!have.has(rel)) { console.error(`missing generated file ${rel}`); bad++ }
    else if (fs.readFileSync(path.join(root, rel), 'utf8') !== content) { console.error(`${rel} differs from what entries/ and tags/ generate`); bad++ }
    have.delete(rel)
  }
  for (const rel of have) { console.error(`stale generated file ${rel}`); bad++ }
}
if (a.check) console.error(bad ? `${bad} generated file(s) out of date` : 'generated files match their inputs')
process.exit(bad ? 1 : 0)
