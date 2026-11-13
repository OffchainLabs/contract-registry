import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abbreviate, collapseData, truncateMiddle } from '../src/lib/abbrev.ts'
import { CommandFailed, startLogged } from '../src/testchain/nitro-contracts.ts'

// The shape of the error that hid the cause in CI: an ethers v5 estimateGas failure whose message
// embeds the transaction's init code as hex and again as a JSON byte map.
const initCode = '61018060405230608052' + 'ab'.repeat(22_000)
const byteMap = JSON.stringify(Object.fromEntries([...Buffer.from(initCode, 'hex')].map((b, i) => [String(i), b])))
const ethersError =
  'Error: cannot estimate gas; transaction may fail or may require manual gas limit ' +
  `(error={"reason":"execution reverted","code":"UNPREDICTABLE_GAS_LIMIT","method":"estimateGas","transaction":{"to":"0x4e59b44847b379578588920cA78FbF26c0B4956C","data":"0x${initCode}"}}, ` +
  `tx={"to":{},"data":${byteMap}}, code=UNPREDICTABLE_GAS_LIMIT, version=abstract-signer/5.7.0)\n` +
  '    at Logger.makeError (node_modules/@ethersproject/logger/src.ts/index.ts:269:28)\n' +
  '    at create2 (scripts/deploymentUtils.ts:181:30)'

test('collapseData drops long hex and byte maps, keeps addresses and hashes', () => {
  const short = collapseData(ethersError)
  assert.ok(short.length < 1000, `${short.length} chars`)
  assert.match(short, /^Error: cannot estimate gas/)
  assert.match(short, /"reason":"execution reverted"/)
  assert.match(short, /"to":"0x4e59b44847b379578588920cA78FbF26c0B4956C"/)
  assert.match(short, /"data":"0x6101806040523060…\[22010 bytes\]"/)
  assert.match(short, /"data":\{…\[22010 numbers\]…\}/)
  assert.match(short, /at create2 \(scripts\/deploymentUtils\.ts:181:30\)$/)
  const hash = '0x' + 'cd'.repeat(32)
  assert.equal(collapseData(`slot ${hash} of 0x${'ef'.repeat(20)}`), `slot ${hash} of 0x${'ef'.repeat(20)}`)
  assert.equal(collapseData('[1, 2, 3]'), '[1, 2, 3]')
})

test('collapseData handles a byte map inside an escaped JSON string', () => {
  const escaped = JSON.stringify({ details: `failed: ${byteMap.slice(1000)}` })
  assert.match(collapseData(escaped), /^\{"details":"failed: …\[\d+ numbers\]…\}"\}$/)
})

test('truncateMiddle keeps the head and the tail', () => {
  assert.equal(truncateMiddle('abcdef', 10), 'abcdef')
  assert.equal(truncateMiddle('a'.repeat(50) + 'z'.repeat(50), 30), `${'a'.repeat(20)}…[70 chars]…${'z'.repeat(10)}`)
})

test('abbreviate keeps the first and last lines within the budget', () => {
  assert.equal(abbreviate('short\ntext'), 'short\ntext')
  const text = ['head: the actual error', ...Array.from({ length: 500 }, (_, i) => `progress line ${i}`), 'last line'].join('\n')
  const short = abbreviate(text, { max: 600 })
  assert.ok(short.length <= 600 + 40, `${short.length} chars`)
  assert.match(short, /^head: the actual error\nprogress line 0\n/)
  assert.match(short, /\n…\[\d+ line\(s\) omitted\]…\n/)
  assert.match(short, /\nprogress line 499\nlast line$/)
  // The CI error, one line of 140 KB: its start survives.
  assert.match(abbreviate(ethersError, { max: 3000 }), /^Error: cannot estimate gas; transaction may fail .*"reason":"execution reverted"/)
})

test('startLogged keeps output split across chunks and reports the error head', async () => {
  // Prints a progress line, then one stderr line of ~240 KB (an ethers error, built in the child:
  // an argument that long is over Linux's limit) written in pieces, so it arrives in several
  // chunks. Then exits 1 right away, as the deploy script does.
  const script = `
    const data = '61018060405230608052' + 'ab'.repeat(22000)
    const byteMap = JSON.stringify(Object.fromEntries([...Buffer.from(data, 'hex')].map((b, i) => [i, b])))
    const big = 'Error: cannot estimate gas (error={"reason":"execution reverted","data":"0x' + data + '"}, tx={"data":' + byteMap + '})'
    console.log('Deploy RollupCreator')
    for (let i = 0; i < big.length; i += 4096) process.stderr.write(big.slice(i, i + 4096))
    process.stderr.write('\\n    at create2 (scripts/deploymentUtils.ts:181:30)\\n', () => process.exit(1))
  `
  const logged: string[] = []
  const run = startLogged(process.execPath, ['-e', script], process.cwd(), {}, 30_000, s => logged.push(s))
  const err = await run.done.then(() => assert.fail('should fail'), (e: unknown) => e)
  assert.ok(err instanceof CommandFailed)
  assert.equal(logged.length, 3, logged.map(l => l.slice(0, 80)).join('\n'))
  assert.equal(logged[0], 'Deploy RollupCreator')
  assert.equal(logged[1], 'Error: cannot estimate gas (error={"reason":"execution reverted","data":"0x6101806040523060…[22010 bytes]"}, tx={"data":{…[22010 numbers]…}})')
  assert.equal(logged[2], '    at create2 (scripts/deploymentUtils.ts:181:30)')
  assert.match(err.message, /exited 1:\nDeploy RollupCreator\nError: cannot estimate gas.*\n    at create2 \(scripts\/deploymentUtils\.ts:181:30\)$/)
  assert.deepEqual(err.stdoutTail, ['Deploy RollupCreator'])
})
