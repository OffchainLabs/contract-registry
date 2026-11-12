// Identifies one piece of runtime code (spec §5.5).
//   node tools/src/cli/lookup.ts --rpc <url> --address <address> [--registry ...] [--source nitro-contracts]
//   node tools/src/cli/lookup.ts --code <0x...>
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { keccak256 } from 'viem'
import { hexToBytes } from '../lib/hex.ts'
import { openSource, Registry } from '../walker/registry.ts'
import { Rpc } from '../walker/rpc.ts'

const { values: a } = parseArgs({
  options: {
    rpc: { type: 'string' }, address: { type: 'string', multiple: true }, code: { type: 'string' }, block: { type: 'string', default: 'latest' },
    registry: { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    source: { type: 'string', default: 'nitro-contracts' },
  },
})
const registry = new Registry(await openSource(a.registry!), a.source!)
const targets: { address?: string; code: string }[] = []
if (a.code) targets.push({ code: a.code })
if (a.address?.length) {
  if (!a.rpc) { console.error('--address needs --rpc'); process.exit(2) }
  const rpc = new Rpc(a.rpc)
  for (const address of a.address) targets.push({ address, code: await rpc.getCode(address, a.block!) })
}
const out = []
for (const t of targets) {
  const code = hexToBytes(t.code)
  const ms = await registry.lookup(code)
  out.push({
    ...(t.address ? { address: t.address } : {}),
    codeLength: code.length,
    codeHash: keccak256(code),
    matches: ms.map(m => ({ contracts: m.entry.contracts, fingerprint: m.entry.fingerprint, tags: m.entry.tags, firstCommit: m.entry.firstCommit, firstBranch: m.entry.firstBranch, variants: m.variants })),
  })
}
console.log(JSON.stringify(out, null, 2))
