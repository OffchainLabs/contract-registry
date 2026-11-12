import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LocalAlertSink, parseBodyItems, renderBody, title } from '../src/lib/alerts.ts'

test('issue bodies carry their items, so a later run can read them back', () => {
  const items = [{ key: 'abc', message: 'test-chain walk failed', commit: 'a'.repeat(40), refs: ['develop'], details: 'line 1\nline 2' }]
  const body = renderBody('nitro-contracts', 'test-chain-walk', items)
  assert.deepEqual(parseBodyItems(body), items)
  assert.equal(title('nitro-contracts', 'build-failure'), '[registry] nitro-contracts: build failure (build-failure)')
})

test('one alert per kind and source: repeats update it, close ends it, a new failure reopens it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'))
  const s = new LocalAlertSink(dir)
  const item = { key: 'x', message: 'm' }
  await s.upsert('nitro-contracts', 'build-failure', [item], [item], 'run 1')
  await s.upsert('nitro-contracts', 'build-failure', [item], [item], 'run 2')
  assert.equal(fs.readdirSync(dir).length, 1)
  assert.equal((await s.get('nitro-contracts', 'build-failure'))!.items.length, 1)
  await s.close('nitro-contracts', 'build-failure', 'fixed')
  assert.equal(await s.get('nitro-contracts', 'build-failure'), null)
  await s.upsert('nitro-contracts', 'build-failure', [item], [item], 'run 3')
  const a = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'))
  assert.equal(a.state, 'open')
  assert.equal(a.number, 2, 'reopened as a new issue number')
  fs.rmSync(dir, { recursive: true })
})
