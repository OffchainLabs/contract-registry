// The test-chain machinery that isn't specific to one source: walks from each start the deployer
// gives, on its own node; the slots probed per source; the cache key; and the token bridge
// deployer's retryable replay (decoding and collecting the parent chain's retryables).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeAbiParameters, encodeEventTopics, encodePacked, getAddress, keccak256, parseAbi, type Hex } from 'viem'
import { loadSourceConfig } from '../src/lib/config.ts'
import { generateViews } from '../src/lib/datarepo.ts'
import { checkCommit, checkKey, KNOWN_SLOTS, probeSlots, type TestChainDeployer } from '../src/lib/testcheck.ts'
import { decodeRetryable, parentRetryables } from '../src/testchain/token-bridge-contracts.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)

/** A JSON-RPC server answering from `handle`; records every request. */
async function rpcServer(handle: (method: string, params: any[]) => unknown): Promise<{ url: string; requests: { method: string; params: any[] }[]; server: Server }> {
  const requests: { method: string; params: any[] }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body)
      requests.push({ method, params })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: handle(method, params) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, requests, server }
}

test('checkCommit walks each of the deployer\'s chains from its own start, on its own node', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'testchain-'))
  for (const [rel, content] of generateViews([{ id: 'fake', repo: 'Example/fake', entries: [], tags: [] }])) {
    fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true })
    fs.writeFileSync(path.join(data, rel), content)
  }
  // Two nodes with nothing deployed: each walk ends at its start, which has no code.
  const node = (chainId: number) => rpcServer(method => ({ eth_chainId: `0x${chainId.toString(16)}`, eth_blockNumber: '0x1', eth_getCode: '0x' } as Record<string, unknown>)[method] ?? null)
  const parent = await node(1), child = await node(2)
  let stopped = false
  const deployer: TestChainDeployer = {
    async deployTestChains() {
      return {
        rpcUrl: parent.url,
        chains: [{ name: 'parent:router', start: addr(1) }, { name: 'child:router', start: addr(2), rpcUrl: child.url }],
        stop: async () => { stopped = true },
      }
    },
  }
  try {
    const r = await checkCommit({ commit: 'c'.repeat(40), key: 'k', checkoutDir: data, commitFingerprints: new Set(), dataRepo: data, source: 'fake', outOfScope: [], deployer })
    assert.deepEqual(r.chains.map(c => [c.chain, c.start]), [['parent:router', addr(1)], ['child:router', addr(2)]])
    assert.deepEqual(r.problems, [
      `parent:router: in-scope edge start lands on ${addr(1)}, which has no code`,
      `child:router: in-scope edge start lands on ${addr(2)}, which has no code`,
    ])
    // A chain without its own rpcUrl is read on the deployment's.
    const codeReads = (s: typeof parent) => s.requests.filter(q => q.method === 'eth_getCode').map(q => getAddress(q.params[0]))
    assert.deepEqual(codeReads(parent), [addr(1)])
    assert.deepEqual(codeReads(child), [addr(2)])
    assert.ok(stopped)
  } finally {
    parent.server.close(); child.server.close()
    fs.rmSync(data, { recursive: true, force: true })
  }
})

test('probeSlots: the known slots, then any other slot a source\'s contractRoles lists', () => {
  for (const id of ['nitro-contracts', 'token-bridge-contracts']) assert.deepEqual(probeSlots(loadSourceConfig(ROOT, id).contractRoles), KNOWN_SLOTS, id)
  const other = `0x${'ab'.repeat(32)}` as Hex, otherBeacon = `0x${'cd'.repeat(32)}` as Hex
  assert.deepEqual(probeSlots({
    'src/P.sol:P': { role: 'proxy', implementationSlots: [KNOWN_SLOTS[0].slot, other] },
    'src/Q.sol:Q': { role: 'proxy', implementationSlots: [other] },
    'src/B.sol:B': { role: 'proxy', beaconSlot: otherBeacon },
    'src/A.sol:A': { role: 'proxy-admin' },
  }), [...KNOWN_SLOTS, { slot: other, kind: 'implementation' }, { slot: otherBeacon, kind: 'beacon' }])
})

test('checkKey covers the deployer module, the shared helpers and the scripts it runs in the checkout', () => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'testchain-key-'))
  try {
    const write = (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(tools, rel)), { recursive: true }); fs.writeFileSync(path.join(tools, rel), content) }
    write('src/testchain/fake.ts', 'driver')
    write('src/testchain/common.ts', 'helpers')
    write('src/testchain/other.ts', 'another deployer')
    write('testchain/fake/deploy.ts', 'script')
    const key = () => checkKey(['owner()'], 'fake', tools)
    const k0 = key()
    assert.equal(key(), k0)
    assert.notEqual(checkKey(['owner()', 'inbox()'], 'fake', tools), k0, 'the out-of-scope list')
    write('src/testchain/other.ts', 'another deployer, changed')
    assert.equal(key(), k0, "another deployer's module")
    for (const f of ['src/testchain/fake.ts', 'src/testchain/common.ts', 'testchain/fake/deploy.ts']) {
      const before = key()
      write(f, `${f} changed`)
      assert.notEqual(key(), before, f)
    }
    const before = key()
    write('testchain/fake/lib.ts', 'a new script')
    assert.notEqual(key(), before, 'a new script')
  } finally {
    fs.rmSync(tools, { recursive: true, force: true })
  }
})

// --- Token bridge: retryables ------------------------------------------------------------------

const SENDER = addr(0x1111), TARGET = addr(0x2222), REFUND = addr(0x3333), BENEFICIARY = addr(0x4444)

function retryableMessage(to: Hex, data: Hex, l2CallValue = 5n): Hex {
  return encodePacked(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    [BigInt(to), l2CallValue, 7n, 11n, BigInt(REFUND), BigInt(BENEFICIARY), 1_000_000n, 100_000_000n, BigInt((data.length - 2) / 2), data],
  )
}

test('decodeRetryable reads the Inbox\'s encoding; a zero destination is a contract creation', () => {
  const r = decodeRetryable(3n, SENDER, retryableMessage(TARGET, '0xdeadbeef'))
  assert.deepEqual(r, {
    messageIndex: 3n, sender: SENDER, to: TARGET, l2CallValue: 5n, deposit: 7n, maxSubmissionCost: 11n,
    excessFeeRefundAddress: REFUND, callValueRefundAddress: BENEFICIARY, gasLimit: 1_000_000n, maxFeePerGas: 100_000_000n, data: '0xdeadbeef',
  })
  assert.equal(decodeRetryable(0n, SENDER, retryableMessage(addr(0), '0x6000')).to, null)
  assert.equal(decodeRetryable(0n, SENDER, retryableMessage(TARGET, '0x')).data, '0x')
  assert.throws(() => decodeRetryable(1n, SENDER, `${retryableMessage(TARGET, '0xdeadbeef')}00`), /data length 4 doesn't match the message \(293 bytes\)/)
  assert.throws(() => decodeRetryable(1n, SENDER, '0x1234'), /too short/)
  const notAddress = `0x${'ff'.repeat(32)}${retryableMessage(TARGET, '0x').slice(66)}` as Hex
  assert.throws(() => decodeRetryable(1n, SENDER, notAddress), /word 0 isn't an address/)
})

const BRIDGE_ABI = parseAbi(['event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)'])
const INBOX_ABI = parseAbi(['event InboxMessageDelivered(uint256 indexed messageNum, bytes data)'])
const BRIDGE = addr(0xb1), INBOX = addr(0x1b), OTHER_INBOX = addr(0x2b)

/** A parent chain whose Bridge and Inboxes logged `messages`. */
async function parentChain(messages: { index: bigint; inbox: Hex; kind: number; data: Hex; hash?: Hex }[]) {
  const logs = (address: string, topic: string) => {
    if (getAddress(address) === BRIDGE && topic === encodeEventTopics({ abi: BRIDGE_ABI, eventName: 'MessageDelivered' })[0]) {
      return messages.map(m => ({
        topics: encodeEventTopics({ abi: BRIDGE_ABI, eventName: 'MessageDelivered', args: { messageIndex: m.index, beforeInboxAcc: `0x${'00'.repeat(32)}` } }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'uint8' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }], [m.inbox, m.kind, SENDER, m.hash ?? keccak256(m.data), 1n, 2n]),
      }))
    }
    return messages.filter(m => getAddress(address) === m.inbox && topic === encodeEventTopics({ abi: INBOX_ABI, eventName: 'InboxMessageDelivered' })[0]).map(m => ({
      topics: encodeEventTopics({ abi: INBOX_ABI, eventName: 'InboxMessageDelivered', args: { messageNum: m.index } }),
      data: encodeAbiParameters([{ type: 'bytes' }], [m.data]),
    }))
  }
  return rpcServer((method, params) => (method === 'eth_getLogs' ? logs(params[0].address, params[0].topics[0]) : null))
}

test("parentRetryables joins the Bridge's records with the Inbox's data, in order, for one inbox", async () => {
  const a = retryableMessage(addr(0), '0x6000'), b = retryableMessage(TARGET, '0xabcd')
  const chain = await parentChain([
    { index: 4n, inbox: INBOX, kind: 9, data: b },
    { index: 2n, inbox: OTHER_INBOX, kind: 12, data: '0x' }, // another inbox's message: not ours
    { index: 1n, inbox: INBOX, kind: 9, data: a },
  ])
  try {
    const rs = await parentRetryables(chain.url, BRIDGE, INBOX)
    assert.deepEqual(rs.map(r => [r.messageIndex, r.sender, r.to, r.data]), [[1n, SENDER, null, '0x6000'], [4n, SENDER, TARGET, '0xabcd']])
  } finally {
    chain.server.close()
  }
})

test('parentRetryables fails on a message that is not a retryable, or whose data the Bridge did not record', async () => {
  for (const [messages, error] of [
    [[{ index: 0n, inbox: INBOX, kind: 12, data: '0x' as Hex }], /message 0 has kind 12; the replay handles only retryables \(9\)/],
    [[{ index: 0n, inbox: INBOX, kind: 9, data: retryableMessage(TARGET, '0x'), hash: keccak256('0x01') }], /message 0: data doesn't match the hash the Bridge recorded/],
  ] as const) {
    const chain = await parentChain([...messages])
    try {
      await assert.rejects(parentRetryables(chain.url, BRIDGE, INBOX), error)
    } finally {
      chain.server.close()
    }
  }
})
