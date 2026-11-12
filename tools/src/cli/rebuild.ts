// Rebuilds a published tag from scratch and checks it reproduces its recorded fingerprints
// (acceptance criterion 3). Writes nothing.
//   node tools/src/cli/rebuild.ts --tag v3.2.0 [--source nitro-contracts]
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { loadSourceConfig } from '../lib/config.ts'
import { SourceRepo } from '../lib/source.ts'
import { Builder } from '../lib/build.ts'
import { SourceData, contractsMap } from '../lib/datarepo.ts'
import { readJson } from '../lib/json.ts'
import type { TagFile } from '../lib/types.ts'

const { values: a } = parseArgs({
  options: {
    'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    'work-dir': { type: 'string' },
    source: { type: 'string', default: 'nitro-contracts' },
    tag: { type: 'string' },
  },
})
if (!a.tag) { console.error('usage: rebuild --tag <tag>'); process.exit(2) }
const dataRepo = path.resolve(a['data-repo']!)
const workDir = path.resolve(a['work-dir'] ?? process.env.REGISTRY_WORK_DIR ?? path.join(dataRepo, '.work'))
const cfg = loadSourceConfig(dataRepo, a.source!)
const recorded = readJson<TagFile>(new SourceData(dataRepo, cfg.directory, cfg.repo).tagPath(a.tag))
const src = new SourceRepo(cfg, workDir)
src.sync()
const { result } = await new Builder(src, workDir).build(recorded.commit, { fresh: true, log: s => console.error(s) })
if (!result.ok) { console.error(`build failed: ${result.failure?.message}`); process.exit(1) }
const rebuilt = contractsMap(result.contracts)
const diffs = [...new Set([...Object.keys(recorded.contracts), ...Object.keys(rebuilt)])].filter(k => recorded.contracts[k] !== rebuilt[k])
console.log(JSON.stringify({ tag: a.tag, commit: recorded.commit, contracts: Object.keys(rebuilt).length, reproduced: diffs.length === 0, differences: diffs.map(k => ({ contract: k, recorded: recorded.contracts[k] ?? null, rebuilt: rebuilt[k] ?? null })) }, null, 2))
process.exit(diffs.length ? 1 : 0)
