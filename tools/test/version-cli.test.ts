// The `version` CLI end to end: a registry directory on disk and a stub JSON-RPC server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { keccak256 } from 'viem'
import { generateViews } from '../src/lib/datarepo.ts'
import type { Entry, Hex, TagFile } from '../src/lib/types.ts'
import { EIP1967_IMPLEMENTATION_SLOT as EIP1967 } from '../src/walker/walk.ts'

const CLI = path.join(import.meta.dirname, '../src/cli/version.ts')
const REPO = 'OffchainLabs/nitro-contracts'
const PROXY_CODE: Hex = '0x6001600201'
const LOGIC_CODE: Hex = '0x6001600202'
const UNKNOWN_CODE: Hex = '0x6001600203'
const PROXY = '0x' + '1'.repeat(40)
const IMPL = '0x' + '2'.repeat(40)
const OTHER = '0x' + '3'.repeat(40)
const UNKNOWN_PROXY = '0x' + '4'.repeat(40) // unknown code, EIP-1967 slot -> IMPL

function entry(c: Hex, contract: string, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: keccak256(c), repo: REPO, contracts: [contract], role: 'logic', codeLength: (c.length - 2) / 2,
    maskedRanges: [], cborMetadataLength: 0, getters: [], selectors: [], compiler: null, ref: 'v1.0.0', commit: '1'.repeat(40), ...extra,
  }
}

function registryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-cli-'))
  const entries = [
    entry(PROXY_CODE, 'P.sol:TransparentUpgradeableProxy', { role: 'proxy', implementationSlots: [EIP1967] }),
    entry(LOGIC_CODE, 'src/bridge/Bridge.sol:Bridge'),
  ]
  const tags: TagFile[] = [
    { schemaVersion: 1, repo: REPO, tag: 'v3.2.0', commit: '2'.repeat(40), prerelease: false, packageVersion: '3.2.0', contracts: { 'P.sol:P': keccak256(PROXY_CODE) } },
    { schemaVersion: 1, repo: REPO, tag: 'v3.3.0', commit: '3'.repeat(40), prerelease: false, packageVersion: '3.3.0', contracts: { 'B.sol:B': keccak256(LOGIC_CODE) } },
  ]
  for (const [rel, content] of generateViews(REPO, 'nitro-contracts', entries, tags)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

async function stubRpc(): Promise<{ url: string; close(): void }> {
  const code: Record<string, Hex> = { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE, [OTHER]: UNKNOWN_CODE, [UNKNOWN_PROXY]: UNKNOWN_CODE }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body)
      let result: string
      if (method === 'eth_getCode') result = code[params[0].toLowerCase()] ?? '0x'
      else if (method === 'eth_getStorageAt' && [PROXY, UNKNOWN_PROXY].includes(params[0].toLowerCase()) && params[1] === EIP1967) result = '0x' + IMPL.slice(2).padStart(64, '0')
      else result = '0x' + '0'.repeat(64)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args])
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('version CLI: a proxy, known or not, reports its implementation; unknown code exits 1; several addresses print one line each', async () => {
  const dir = registryDir()
  const rpc = await stubRpc()
  try {
    const base = ['--rpc', rpc.url, '--registry', dir]
    assert.deepEqual(await run([...base, '--address', PROXY]), { status: 0, stdout: 'v3.3.0\n', stderr: '' })
    assert.deepEqual(await run([...base, '--address', UNKNOWN_PROXY]), { status: 0, stdout: 'v3.3.0\n', stderr: '' })
    assert.deepEqual(await run([...base, '--address', IMPL]), { status: 0, stdout: 'v3.3.0\n', stderr: '' })
    assert.deepEqual(await run([...base, '--address', OTHER]), { status: 1, stdout: '', stderr: 'unknown\n' })
    assert.deepEqual(await run([...base, '--address', PROXY, '--address', OTHER]), { status: 1, stdout: `${PROXY} v3.3.0\n${OTHER} unknown\n`, stderr: '' })
    assert.equal((await run(['--registry', dir])).status, 2)
  } finally {
    rpc.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
