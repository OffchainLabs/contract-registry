// Walks a chain's contracts from one address and prints the result as JSON (spec §5.6).
//   node tools/src/cli/walk.ts --rpc <url> --start <address>
//        [--registry <dir | git:<path>@<rev> | github:<owner>/<repo>@<ref>>] [--source nitro-contracts]
//        [--out-of-scope <file>] [--block <number>] [--list-cap 64]
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { openSource, Registry } from '../walker/registry.ts'
import { Rpc } from '../walker/rpc.ts'
import { walk } from '../walker/walk.ts'

const { values: a } = parseArgs({
  options: {
    rpc: { type: 'string' },
    start: { type: 'string' },
    registry: { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    source: { type: 'string', default: 'nitro-contracts' },
    repo: { type: 'string' },
    'out-of-scope': { type: 'string' },
    block: { type: 'string' },
    'list-cap': { type: 'string', default: '64' },
    verbose: { type: 'boolean', default: false },
  },
})
if (!a.rpc || !a.start) { console.error('usage: walk --rpc <url> --start <address> [--registry ...]'); process.exit(2) }
const source = await openSource(a.registry!)
const registry = new Registry(source, a.source!)
const ix = await registry.index()
const oos = a['out-of-scope'] ? JSON.parse(fs.readFileSync(a['out-of-scope'], 'utf8')).getters : await registry.outOfScope()
if (!oos) { console.error(`no out-of-scope list in the registry for ${a.source}; pass --out-of-scope`); process.exit(2) }
const result = await walk({
  start: a.start, rpc: new Rpc(a.rpc), registry, repo: a.repo ?? ix.repo, outOfScope: Object.keys(oos),
  listCap: Number(a['list-cap']), blockNumber: a.block ? BigInt(a.block) : undefined,
  log: a.verbose ? s => console.error(s) : undefined,
})
console.log(JSON.stringify(result, null, 2))
