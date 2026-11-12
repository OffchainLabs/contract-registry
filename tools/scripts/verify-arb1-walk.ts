// Acceptance criterion 6: walking Arbitrum One (mostly unknown to the registry, since it predates
// v3.2.0) still reaches every core contract, including the OSP and its provers, and flags each
// unknown one. The expected addresses are read independently, straight from the Bridge.
//   node tools/scripts/verify-arb1-walk.ts [--registry <spec>]   (needs ALCHEMY_API_KEY)
import * as path from 'node:path'
import * as fs from 'node:fs'
import { parseArgs } from 'node:util'
import { toFunctionSelector } from 'viem'
import { openSource, Registry } from '../src/walker/registry.ts'
import { Rpc } from '../src/walker/rpc.ts'
import { walk } from '../src/walker/walk.ts'

const { values: a } = parseArgs({ options: { registry: { type: 'string', default: path.resolve(import.meta.dirname, '../..') }, out: { type: 'string' } } })
const rpc = new Rpc(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`)
const BRIDGE = '0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a' // Arbitrum One Bridge
const INBOX = '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f' // Arbitrum One Inbox: the walk's start
const blockNumber = await rpc.blockNumber()
const block = '0x' + blockNumber.toString(16)
const get = async (to: string, sig: string) => '0x' + (await rpc.call(to, toFunctionSelector(sig), block)).slice(26)
const rollup = await get(BRIDGE, 'rollup()')
const want: Record<string, string> = {
  Bridge: BRIDGE, Inbox: INBOX, Rollup: rollup,
  SequencerInbox: await get(BRIDGE, 'sequencerInbox()'),
  Outbox: await get(rollup, 'outbox()'),
  RollupEventInbox: await get(rollup, 'rollupEventInbox()'),
  ChallengeManager: await get(rollup, 'challengeManager()'),
}
want.OneStepProofEntry = await get(want.ChallengeManager, 'oneStepProofEntry()')
want.OneStepProver0 = await get(want.OneStepProofEntry, 'prover0()')
want.OneStepProverMemory = await get(want.OneStepProofEntry, 'proverMem()')
want.OneStepProverMath = await get(want.OneStepProofEntry, 'proverMath()')
want.OneStepProverHostIo = await get(want.OneStepProofEntry, 'proverHostIo()')

const registry = new Registry(await openSource(a.registry!), 'nitro-contracts')
const w = await walk({ start: INBOX, rpc, registry, repo: 'OffchainLabs/nitro-contracts', outOfScope: Object.keys((await registry.outOfScope())!), blockNumber })
if (a.out) fs.writeFileSync(a.out, JSON.stringify(w, null, 2))
let fail = 0
const rows = []
for (const [k, addr] of Object.entries(want)) {
  const n = w.nodes.find(x => x.address.toLowerCase() === addr.toLowerCase())
  if (!n) { rows.push({ contract: k, address: addr, status: 'MISSING' }); fail++; continue }
  const logic = n.implementation ? n.implementation.code : n.code
  const unknownFlagged = w.warnings.some(x => x.kind === 'unknown-code' && x.address === n.address)
  const anyUnknown = [n.code, n.implementation?.code, n.secondaryImplementation?.code].some(c => c?.status === 'unknown')
  const ok = n.inScope && (!anyUnknown || unknownFlagged)
  if (!ok) fail++
  rows.push({
    contract: k, address: n.address, status: ok ? 'ok' : 'FAIL', inScope: n.inScope, name: n.name,
    code: n.code?.status, implementation: n.implementation?.code.status ?? null, flaggedUnknown: unknownFlagged,
    closest: logic?.status === 'unknown' ? logic.closest?.contracts[0] ?? null : null,
    via: n.edges.filter(e => e.inScope).map(e => `${w.nodes.find(m => m.address === e.from)?.name}.${e.getter}`).slice(0, 3),
  })
}
console.log(JSON.stringify({ block: blockNumber.toString(), nodes: w.nodes.length, inScopeNodes: w.nodes.filter(n => n.inScope).length, warnings: w.warnings.length, summary: w.summary, rpcRequests: w.stats.rpcRequests, ms: w.stats.ms, reached: rows }, null, 2))
process.exit(fail ? 1 : 0)
