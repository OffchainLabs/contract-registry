// Prints the version of the contract at an address (`Registry.getVersion`): a proxy with one
// implementation slot reports its implementation; everything else reports itself. Unknown code
// reports the implementation at its EIP-1967 slot, unless its secondary slot is set. One lookup
// across every source in the registry.
//   node tools/src/cli/version.ts --rpc <url> --address <address> [--address ...]
//        [--registry <dir | git:<path>@<rev> | github:<owner>/<repo>@<ref>>] [--block latest]
// One address: prints the version (exit 0), or "unknown" on stderr (exit 1).
// Several: prints "<address> <version|unknown>" per line; exit 1 if any is unknown.
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { openSource, Registry } from '../walker/registry.ts'
import { Rpc } from '../walker/rpc.ts'

const { values: a } = parseArgs({
  options: {
    rpc: { type: 'string' },
    address: { type: 'string', multiple: true },
    registry: { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    block: { type: 'string', default: 'latest' },
  },
})
if (!a.rpc || !a.address?.length) {
  console.error('usage: version.ts --rpc <url> --address <address> [--address ...] [--registry ...] [--block ...]')
  process.exit(2)
}
const registry = new Registry(await openSource(a.registry!))
const rpc = new Rpc(a.rpc)
let unknown = false
for (const address of a.address) {
  const v = await registry.getVersion(rpc, address, a.block!)
  unknown ||= v === null
  if (a.address.length > 1) console.log(`${address} ${v ?? 'unknown'}`)
  else if (v) console.log(v)
  else console.error('unknown')
}
process.exit(unknown ? 1 : 0)
