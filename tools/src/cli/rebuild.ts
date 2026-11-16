// Rebuilds published tags from scratch and checks each reproduces the fingerprints in its tag
// file (acceptance criterion 3). Writes nothing to the data.
//   node tools/src/cli/rebuild.ts --source <id> --tag <tag> [--tag <tag> ...]   e.g. --source nitro-contracts --tag v3.2.0
//   node tools/src/cli/rebuild.ts --source <id> --all                            every tag file of the source
// Prints one JSON report on stdout (progress on stderr). Exits 0 if every tag reproduced, 1 if
// any differs or fails to build, 2 if it can't run (bad arguments, unknown source or tag, no tag
// files). --source is required: tag names overlap across sources.
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { rebuild } from '../lib/rebuild.ts'

const { values: a } = parseArgs({
  options: {
    'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    'work-dir': { type: 'string' },
    source: { type: 'string' },
    tag: { type: 'string', multiple: true },
    all: { type: 'boolean', default: false },
    'no-sync': { type: 'boolean', default: false },
  },
})
if (!a.source || !a.tag === !a.all) { console.error('usage: rebuild --source <id> (--tag <tag> ... | --all)'); process.exit(2) }
const dataRepo = path.resolve(a['data-repo']!)
const workDir = path.resolve(a['work-dir'] ?? process.env.REGISTRY_WORK_DIR ?? path.join(dataRepo, '.work'))
try {
  const report = await rebuild({ dataRepo, workDir, source: a.source, tags: a.tag, sync: !a['no-sync'], log: s => console.error(s) })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.reproduced ? 0 : 1
} catch (e) {
  console.error(`rebuild: ${(e as Error).message}`)
  process.exitCode = 2
}
