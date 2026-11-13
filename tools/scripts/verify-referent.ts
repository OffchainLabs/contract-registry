// Acceptance criterion 2: every address in arbitrum-chain-actions' referentContractAddresses.json
// (v3.2.0) identifies as tag v3.2.0 with the right contract on every chain where it has code, and
// its immutables agree with its place in the list (ETH vs ERC20, delay-bufferable pairs,
// maxDataSize, host chain type, chain id).
//   node tools/scripts/verify-referent.ts [--registry <spec>] [--referent <file or URL>]
// RPCs: Alchemy (ALCHEMY_API_KEY) for most chains, public endpoints for the rest.
import { parseArgs } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { openSource, Registry } from '../src/walker/registry.ts'
import { Rpc } from '../src/walker/rpc.ts'
import { hexToBytes } from '../src/lib/hex.ts'
import { decodeImmutables } from '../src/lib/fingerprint.ts'

const { values: a } = parseArgs({
  options: {
    registry: { type: 'string', default: path.resolve(import.meta.dirname, '../..') },
    referent: { type: 'string', default: 'https://raw.githubusercontent.com/OffchainLabs/arbitrum-chain-actions/main/scripts/chain-versioner/referentContractAddresses.json' },
    tag: { type: 'string', default: 'v3.2.0' },
  },
})
const KEY = process.env.ALCHEMY_API_KEY
const alchemy = (net: string) => `https://${net}.g.alchemy.com/v2/${KEY}`
const CHAINS: { name: string; rpc: string }[] = [
  { name: 'Ethereum', rpc: alchemy('eth-mainnet') },
  { name: 'Sepolia', rpc: alchemy('eth-sepolia') },
  { name: 'Arbitrum One', rpc: alchemy('arb-mainnet') },
  { name: 'Arbitrum Nova', rpc: 'https://nova.arbitrum.io/rpc' },
  { name: 'Arbitrum Sepolia', rpc: alchemy('arb-sepolia') },
  { name: 'Base', rpc: alchemy('base-mainnet') },
  { name: 'Base Sepolia', rpc: alchemy('base-sepolia') },
  { name: 'BNB', rpc: alchemy('bnb-mainnet') },
  { name: 'Optimism', rpc: alchemy('opt-mainnet') },
  { name: 'Polygon', rpc: alchemy('polygon-mainnet') },
  { name: 'Avalanche', rpc: alchemy('avax-mainnet') },
  { name: 'Linea', rpc: alchemy('linea-mainnet') },
  { name: 'Blast', rpc: alchemy('blast-mainnet') },
  { name: 'Scroll', rpc: alchemy('scroll-mainnet') },
  { name: 'Gnosis', rpc: alchemy('gnosis-mainnet') },
  { name: 'Celo', rpc: alchemy('celo-mainnet') },
  { name: 'Mantle', rpc: alchemy('mantle-mainnet') },
  { name: 'Unichain', rpc: alchemy('unichain-mainnet') },
  { name: 'World Chain', rpc: alchemy('worldchain-mainnet') },
  { name: 'Ink', rpc: alchemy('ink-mainnet') },
  { name: 'Soneium', rpc: alchemy('soneium-mainnet') },
  { name: 'ApeChain', rpc: alchemy('apechain-mainnet') },
  { name: 'Zora', rpc: alchemy('zora-mainnet') },
  { name: 'opBNB', rpc: alchemy('opbnb-mainnet') },
  { name: 'Berachain', rpc: alchemy('berachain-mainnet') },
  { name: 'Sonic', rpc: alchemy('sonic-mainnet') },
]
// deploymentUtils.ts: on an L1 the templates use a real Reader4844; on Arbitrum, address zero;
// on any other chain, 0x…dead.
const L1_CHAIN_IDS = new Set([1, 11155111, 17000, 560048])
const EXPECTED: Record<string, { name: string; feeToken?: boolean }> = {
  'eth.Inbox': { name: 'Inbox' }, 'erc20.Inbox': { name: 'ERC20Inbox' },
  'eth.Outbox': { name: 'Outbox' }, 'erc20.Outbox': { name: 'ERC20Outbox' },
  'eth.SequencerInbox': { name: 'SequencerInbox', feeToken: false }, 'erc20.SequencerInbox': { name: 'SequencerInbox', feeToken: true },
  'eth.Bridge': { name: 'Bridge' }, 'erc20.Bridge': { name: 'ERC20Bridge' },
  'eth.RollupEventInbox': { name: 'RollupEventInbox' }, 'erc20.RollupEventInbox': { name: 'ERC20RollupEventInbox' },
  RollupAdminLogic: { name: 'RollupAdminLogic' }, RollupUserLogic: { name: 'RollupUserLogic' }, ChallengeManager: { name: 'EdgeChallengeManager' },
}

const referent = JSON.parse(a.referent!.startsWith('http') ? await (await fetch(a.referent!)).text() : fs.readFileSync(a.referent!, 'utf8'))[a.tag!]
const list: [string, string][] = []
const flatten = (o: any, p: string) => { if (Array.isArray(o)) o.forEach(x => list.push([p, x])); else for (const k in o) flatten(o[k], p ? `${p}.${k}` : k) }
flatten(referent, '')
const registry = new Registry(await openSource(a.registry!), 'nitro-contracts')

let problems = 0
const seenAnywhere = new Set<string>()
const report: any[] = []
for (const chain of CHAINS) {
  const rpc = new Rpc(chain.rpc, { retries: 2 })
  let chainId: number
  try { chainId = await rpc.chainId() } catch (e) { report.push({ chain: chain.name, skipped: (e as Error).message.slice(0, 80) }); continue }
  let isArbitrum = false
  // Arbitrum chains answer ArbSys.arbOSVersion(); anything else (revert, no code, other precompile) isn't Arbitrum.
  try { isArbitrum = (await rpc.call('0x0000000000000000000000000000000000000064', '0x051038f2', 'latest')).length >= 66 } catch { /* not Arbitrum */ }
  const parent = L1_CHAIN_IDS.has(chainId) ? 'l1' : isArbitrum ? 'arbitrum' : 'other'
  const rows: any[] = []
  const bufferable: Record<string, boolean[]> = { eth: [], erc20: [] }
  const maxDataSizes = new Set<string>()
  for (const [key, address] of list) {
    const code = hexToBytes(await rpc.getCode(address, 'latest'))
    if (!code.length) continue
    seenAnywhere.add(address)
    const want = EXPECTED[key]
    const m = await registry.lookup(code)
    const v = m ? decodeImmutables(code, m) : null
    const errs: string[] = []
    if (!m) errs.push('no match')
    if (m && v) {
      if (!m.tags.includes(a.tag!)) errs.push(`tags [${m.tags}] lack ${a.tag}`)
      if (!m.contracts.some(c => c.endsWith(`:${want.name}`))) errs.push(`is ${m.contracts.join(',')}, expected ${want.name}`)
      if (want.feeToken !== undefined && v.isUsingFeeToken !== want.feeToken) errs.push(`isUsingFeeToken ${v.isUsingFeeToken}`)
      if ('deployTimeChainId' in v && v.deployTimeChainId !== String(chainId)) errs.push(`deployTimeChainId ${v.deployTimeChainId} on chain ${chainId}`)
      for (const k of ['hostChainIsArbitrum', '_hostChainIsArbitrum']) if (k in v && v[k] !== isArbitrum) errs.push(`${k} ${v[k]} on ${parent} chain`)
      if ('maxDataSize' in v) maxDataSizes.add(v.maxDataSize as string)
      if ('reader4844' in v) {
        const r = (v.reader4844 as string).toLowerCase()
        const ok = parent === 'arbitrum' ? r === '0x0000000000000000000000000000000000000000' : parent === 'other' ? r === '0x000000000000000000000000000000000000dead' : r !== '0x0000000000000000000000000000000000000000' && r !== '0x000000000000000000000000000000000000dead'
        if (!ok) errs.push(`reader4844 ${r} on ${parent} chain`)
        if (parent === 'l1') {
          const rm = await registry.lookup(hexToBytes(await rpc.getCode(r, 'latest')))
          if (!rm?.contracts.some(c => c.endsWith(':Reader4844'))) errs.push(`reader4844 ${r} isn't the registry's Reader4844`)
        }
      }
      if (key.endsWith('SequencerInbox')) bufferable[key.split('.')[0]].push(v.isDelayBufferable as boolean)
    }
    problems += errs.length
    rows.push({ key, address, contract: m?.contracts.find(c => c.endsWith(`:${want.name}`)) ?? m?.contracts[0] ?? null, tags: m?.tags ?? [], immutables: v, ok: errs.length === 0, errors: errs })
  }
  if (!rows.length) { report.push({ chain: chain.name, chainId, parent, deployed: 0 }); continue }
  const chainErrs: string[] = []
  for (const fee of ['eth', 'erc20']) {
    const b = bufferable[fee].sort()
    if (b.length && JSON.stringify(b) !== JSON.stringify([false, true])) chainErrs.push(`${fee} SequencerInbox delay-bufferable variants with code: [${b}], expected one of each`)
  }
  if (maxDataSizes.size > 1) chainErrs.push(`maxDataSize differs across templates: ${[...maxDataSizes]}`)
  problems += chainErrs.length
  report.push({ chain: chain.name, chainId, parent, deployed: rows.length, maxDataSize: [...maxDataSizes], ok: rows.every(r => r.ok) && !chainErrs.length, chainErrors: chainErrs, addresses: rows })
}
const neverDeployed = list.filter(([, x]) => !seenAnywhere.has(x)).map(([k, x]) => `${k} ${x}`)
console.log(JSON.stringify({ tag: a.tag, registry: registry.source.describe(), problems, neverDeployedOnCheckedChains: neverDeployed, chains: report }, null, 2))
process.exit(problems ? 1 : 0)
