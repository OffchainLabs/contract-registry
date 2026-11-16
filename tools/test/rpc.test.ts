import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ExecutionError, Rpc, RpcError } from '../src/walker/rpc.ts'

/**
 * eth_call errors as RPCs give them: what the call's data maps to here. The revert and halt forms
 * are those of the RPCs this repo uses (Alchemy's Ethereum and Arbitrum One endpoints, and anvil
 * for test chains); the others are node failures that mention execution.
 */
const ERRORS: { error: { code: number; message: string }; revert: boolean; what: string }[] = [
  { error: { code: 3, message: 'execution reverted' }, revert: true, what: 'a revert (every RPC)' },
  { error: { code: 3, message: 'execution reverted: Ownable: caller is not the owner' }, revert: true, what: 'a revert with a reason' },
  { error: { code: -32003, message: 'EVM error: InvalidFEOpcode' }, revert: true, what: 'Alchemy Ethereum: invalid opcode' },
  { error: { code: -32003, message: 'EVM error: PrecompileError' }, revert: true, what: 'Alchemy Ethereum: a failing precompile' },
  { error: { code: -32003, message: 'out of gas: gas required exceeds: 100000' }, revert: true, what: 'Alchemy Ethereum: out of gas' },
  { error: { code: -32003, message: 'EVM error InvalidFEOpcode' }, revert: true, what: 'anvil: invalid opcode' },
  { error: { code: -32003, message: 'EVM error PrecompileError' }, revert: true, what: 'anvil: a failing precompile' },
  { error: { code: -32003, message: 'EVM error OutOfGas' }, revert: true, what: 'anvil: out of gas' },
  { error: { code: -32000, message: 'invalid opcode: INVALID' }, revert: true, what: 'Arbitrum One (Nitro): invalid opcode' },
  { error: { code: -32000, message: 'stack underflow (0 <=> 2)' }, revert: true, what: 'Arbitrum One: stack underflow' },
  { error: { code: -32000, message: 'invalid jump destination' }, revert: true, what: 'Arbitrum One: bad jump' },
  { error: { code: -32000, message: 'out of gas' }, revert: true, what: 'Arbitrum One: out of gas' },
  { error: { code: -32000, message: 'execution aborted (timeout = 5s)' }, revert: false, what: "geth's eth_call timeout" },
  { error: { code: -32000, message: 'execution timeout' }, revert: false, what: 'an execution timeout' },
  { error: { code: -32603, message: 'execution failed: internal error' }, revert: false, what: 'a node failure' },
]

test('Rpc.call: reverts and exceptional halts throw ExecutionError; node failures that mention execution throw RpcError', async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const r = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: ERRORS[Number(r.params[0].data)].error }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const rpc = new Rpc(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { retries: 0 })
    for (const [i, { error, revert, what }] of ERRORS.entries()) {
      const e = await rpc.call('0x' + '11'.repeat(20), String(i), 'latest').then(() => null, (x: Error) => x)
      assert.ok(e instanceof (revert ? ExecutionError : RpcError), `${what} (${error.message}): got ${e?.constructor.name}`)
      assert.ok(e!.message.includes(error.message))
    }
  } finally {
    server.close()
  }
})
