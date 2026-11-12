// Deploys nitro-contracts test chains on a local anvil node and prints their addresses as JSON.
//
//   node tools/src/testchain/nitro-contracts-cli.ts --checkout <dir> [--port <n>] [--keep] [--quiet]
//
// Without --keep, anvil is stopped before exiting. With --keep, anvil keeps running detached; its
// URL and pid are in the JSON (rpcUrl, anvilPid) and on stderr. Stop it with `kill <anvilPid>`.
// Progress goes to stderr (unless --quiet), the JSON to stdout.

import { parseArgs } from 'node:util'
import { deployTestChains } from './nitro-contracts.ts'

const { values } = parseArgs({
  options: {
    checkout: { type: 'string' },
    port: { type: 'string' },
    keep: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
})
if (!values.checkout) {
  console.error('usage: nitro-contracts-cli.ts --checkout <dir> [--port <n>] [--keep] [--quiet]')
  process.exit(2)
}

const started = Date.now()
const deployment = await deployTestChains({
  checkoutDir: values.checkout,
  port: values.port === undefined ? undefined : Number(values.port),
  log: values.quiet ? undefined : s => console.error(s),
  detach: values.keep,
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
const { stop, ...json } = deployment
console.log(JSON.stringify(json, null, 2))
console.error(`deployed ${deployment.chains.length} chains in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (values.keep) {
  console.error(`anvil left running at ${deployment.rpcUrl} (pid ${deployment.anvilPid}); stop it with: kill ${deployment.anvilPid}`)
} else {
  await stop()
}
