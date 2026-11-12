import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { SourceData } from '../src/lib/datarepo.ts'
import type { Entry } from '../src/lib/types.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLI = path.join(ROOT, 'tools/src/cli/ci-check.ts')
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const entry = (n: number): Entry => ({
  schemaVersion: 1, fingerprint: fp(n), repo: 'OffchainLabs/nitro-contracts', contracts: [`src/X${n}.sol:X${n}`], codeLength: 100 + n,
  immutables: [], cborMetadataLength: 12, getters: [], selectors: [],
  compiler: { language: 'Solidity', version: '0.8.17', evmVersion: 'london', optimizer: { enabled: true, runs: 2000 }, viaIR: false, metadata: { bytecodeHash: 'none', appendCBOR: true } },
  firstCommit: n.toString(16).padStart(40, '0'), firstBranch: 'develop',
})

function setup(): { dir: string; data: SourceData; commit: (m: string) => void; check: (base?: string) => { ok: boolean; out: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-ci-'))
  for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  const data = new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts')
  return {
    dir, data,
    commit: m => { g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', m) },
    check: base => {
      const r = spawnSync(process.execPath, [CLI, '--data-repo', dir, ...(base ? ['--base', base] : [])], { encoding: 'utf8' })
      return { ok: r.status === 0, out: r.stderr + r.stdout }
    },
  }
}

test('ci-check: appends pass; modified or deleted entries fail; hand-edited views fail', () => {
  const t = setup()
  t.data.writeEntry(entry(1)); t.data.writeViews(); t.commit('one')
  assert.ok(t.check('HEAD').ok)

  t.data.writeEntry(entry(2)); t.data.writeViews(); t.commit('append')
  const append = t.check('HEAD~1')
  assert.ok(append.ok, append.out)

  // Modify an entry (and regenerate, so only the append-only rule can catch it).
  const f = t.data.entryPath(fp(1))
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"develop"', '"main"'))
  t.data.writeViews(); t.commit('modify')
  const mod = t.check('HEAD~1')
  assert.ok(!mod.ok)
  assert.match(mod.out, /append-only: M\tnitro-contracts\/entries\//)

  fs.rmSync(t.data.entryPath(fp(2))); t.data.writeViews(); t.commit('delete')
  assert.match(t.check('HEAD~1').out, /append-only: D\tnitro-contracts\/entries\//)

  // A hand-edited generated file.
  const shard = path.join(t.dir, 'nitro-contracts/by-length/101.json')
  fs.writeFileSync(shard, fs.readFileSync(shard, 'utf8').replace('"tags": []', '"tags": ["v9.9.9"]'))
  const edited = t.check()
  assert.ok(!edited.ok)
  assert.match(edited.out, /by-length\/101\.json differs/)

  // A schema violation.
  fs.mkdirSync(path.join(t.dir, 'nitro-contracts/tags'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, 'nitro-contracts/tags/v1.0.0.json'), '{"tag": "v1.0.0"}\n')
  assert.match(t.check().out, /schema: nitro-contracts\/tags\/v1\.0\.0\.json/)
  fs.rmSync(t.dir, { recursive: true })
})
