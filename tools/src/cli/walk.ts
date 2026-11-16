// Walks a chain's contracts from one address and prints the result as JSON (spec §5.6).
//   node tools/src/cli/walk.ts --rpc <url> --start <address> [--source <id>]
//        [--registry <dir | git:<path>@<rev> | github:<owner>/<repo>@<ref>>]
//        [--out-of-scope <file>] [--block <number>] [--list-cap 64] [--verbose]
// --source is the source the walk belongs to (e.g. nitro-contracts): unknown code is probed with
// its getters, its out-of-scope list applies unless --out-of-scope is given, and the summary
// intersects its logic. By default it is the source of the start contract's logic (its
// implementation's match, else its own code's; see `WalkOptions.source`).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { Registry } from '../walker/registry.ts'
import { Rpc } from '../walker/rpc.ts'
import { walk } from '../walker/walk.ts'

const { values: a } = parseArgs({
  options: {
    rpc: { type: 'string' },
    start: { type: 'string' },
    registry: { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    source: { type: 'string' },
    'out-of-scope': { type: 'string' },
    block: { type: 'string' },
    'list-cap': { type: 'string', default: '64' },
    verbose: { type: 'boolean', default: false },
  },
})
if (!a.rpc || !a.start) { console.error('usage: walk --rpc <url> --start <address> [--source <id>] [--registry ...] [--out-of-scope <file>] [--block <number>]'); process.exit(2) }
const registry = await Registry.open(a.registry!)
const outOfScope = a['out-of-scope'] ? Object.keys(JSON.parse(fs.readFileSync(a['out-of-scope'], 'utf8')).getters) : undefined
try {
  const result = await walk({
    start: a.start, rpc: new Rpc(a.rpc), registry, source: a.source, outOfScope,
    listCap: Number(a['list-cap']), blockNumber: a.block ? BigInt(a.block) : undefined,
    log: a.verbose ? s => console.error(s) : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  // The message is enough for a usage problem (no source given and none inferred); --verbose shows the stack.
  console.error(a.verbose ? e : `walk: ${(e as Error).message}`)
  process.exit(1)
}
