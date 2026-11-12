import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { generateViews, SourceData } from '../src/lib/datarepo.ts'
import { SchemaValidator } from '../src/lib/schema.ts'
import type { Entry, TagFile } from '../src/lib/types.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const commit = (n: number) => n.toString(16).padStart(40, '0')

function entry(n: number, len: number, extra: Partial<Entry> = {}): Entry {
  return {
    schemaVersion: 1, fingerprint: fp(n), repo: 'OffchainLabs/nitro-contracts', contracts: [`src/X${n}.sol:X${n}`], codeLength: len,
    immutables: [], cborMetadataLength: 12,
    getters: [{ signature: 'bridge()', selector: '0xe78cea92', kind: 'single' }], selectors: ['0xe78cea92'],
    compiler: { language: 'Solidity', version: '0.8.17+commit.8df45f5f', evmVersion: 'london', optimizer: { enabled: true, runs: 2000 }, viaIR: false, metadata: { bytecodeHash: 'none', appendCBOR: true } },
    firstCommit: commit(n), firstBranch: 'develop', ...extra,
  }
}
function tag(name: string, contracts: Record<string, `0x${string}`>): TagFile {
  return { schemaVersion: 1, repo: 'OffchainLabs/nitro-contracts', tag: name, commit: commit(99), prerelease: name.includes('-'), packageVersion: name.slice(1), contracts }
}

test('a fingerprint produced by several tags lists all of them, in release order', () => {
  const views = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts',
    [entry(1, 100), entry(2, 100), entry(3, 200)],
    [tag('v3.10.0', { 'src/X1.sol:X1': fp(1) }), tag('v3.2.0', { 'src/X1.sol:X1': fp(1), 'src/X3.sol:X3': fp(3) }), tag('v3.2.0-beta.0', { 'src/X1.sol:X1': fp(1) })])
  const shard = JSON.parse(views.get('nitro-contracts/by-length/100.json')!)
  assert.deepEqual(shard.entries.map((e: any) => [e.fingerprint, e.tags]), [[fp(1), ['v3.2.0-beta.0', 'v3.2.0', 'v3.10.0']], [fp(2), []]])
  assert.deepEqual(JSON.parse(views.get('nitro-contracts/index.json')!).codeLengths, [100, 200])
})

test('generation is deterministic regardless of input order', () => {
  const es = [entry(1, 100), entry(2, 100), entry(3, 200)]
  const ts = [tag('v1.0.0', { 'src/X1.sol:X1': fp(1) }), tag('v1.1.0', { 'src/X2.sol:X2': fp(2) })]
  const a = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', es, ts)
  const b = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', [...es].reverse(), [...ts].reverse())
  assert.deepEqual([...a], [...b])
})

test('schemas accept generated files and manual entries, and reject a manual entry without a label', () => {
  const v = new SchemaValidator(ROOT)
  assert.deepEqual(v.validate('entry', entry(1, 100)), [])
  const manual = entry(5, 100, { firstCommit: null, firstBranch: null, compiler: null, label: 'Arbitrum One Bridge (patched v3.0.0)', notes: 'one-off build' })
  assert.deepEqual(v.validate('entry', manual), [])
  const { label, ...unlabelled } = manual
  assert.notDeepEqual(v.validate('entry', unlabelled), [])
  assert.notDeepEqual(v.validate('entry', { ...entry(1, 100), surprise: 1 }), [], 'unknown fields are rejected')
  const views = generateViews('OffchainLabs/nitro-contracts', 'nitro-contracts', [entry(1, 100), manual], [tag('v1.0.0', { 'src/X1.sol:X1': fp(1) })])
  assert.deepEqual(v.validate('by-length', JSON.parse(views.get('nitro-contracts/by-length/100.json')!)), [])
  assert.deepEqual(v.validate('index', JSON.parse(views.get('nitro-contracts/index.json')!)), [])
})

test('entries and tag files are write-once; nested branch paths are cleaned up on delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'))
  const d = new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts')
  d.writeEntry(entry(1, 100))
  assert.throws(() => d.writeEntry(entry(1, 100)), /write-once/)
  d.writeTag(tag('v1.0.0', {}))
  assert.throws(() => d.writeTag(tag('v1.0.0', {})), /write-once/)
  d.writeBranch({ schemaVersion: 1, repo: 'OffchainLabs/nitro-contracts', branch: 'hotfix/x', commit: commit(1), contracts: {} })
  assert.ok(fs.existsSync(path.join(dir, 'nitro-contracts/branches/hotfix/x.json')))
  d.deleteBranch('hotfix/x')
  assert.ok(!fs.existsSync(path.join(dir, 'nitro-contracts/branches/hotfix')))
  fs.rmSync(dir, { recursive: true })
})
