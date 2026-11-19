// Deploys token bridge test chains on local anvil nodes and prints their addresses as JSON.
//
//   node tools/src/testchain/token-bridge-contracts-cli.ts --checkout <dir> [--keep] [--quiet]
//
// Without --keep, every anvil is stopped before exiting. With --keep, they keep running detached;
// their URLs and pids are in the JSON (rpcUrl and anvilPid for the parent chain, childRpcUrl and
// childAnvilPid per variant). Stop them with `kill <pid> ...`. Progress goes to stderr (unless
// --quiet), the JSON to stdout.

import { parseArgs } from 'node:util'
import { deployTestChains } from './token-bridge-contracts.ts'

const { values } = parseArgs({
  options: {
    checkout: { type: 'string' },
    keep: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
})
if (!values.checkout) {
  console.error('usage: token-bridge-contracts-cli.ts --checkout <dir> [--keep] [--quiet]')
  process.exit(2)
}

const started = Date.now()
const deployment = await deployTestChains({
  checkoutDir: values.checkout,
  log: values.quiet ? undefined : s => console.error(s),
  detach: values.keep,
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
const { stop, ...json } = deployment
console.log(JSON.stringify(json, null, 2))
console.error(`deployed ${deployment.variants.length} token bridges (${deployment.chains.length} walks) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (values.keep) {
  const pids = [deployment.anvilPid, ...deployment.variants.map(v => v.childAnvilPid)]
  console.error(`anvils left running (pids ${pids.join(' ')}); stop them with: kill ${pids.join(' ')}`)
} else {
  await stop()
}
