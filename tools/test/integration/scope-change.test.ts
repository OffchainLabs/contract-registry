// Acceptance criteria 5 and 7, end to end, against a throwaway clone of the data repo:
//   - a rerun with nothing new produces no data repo diff and passes;
//   - removing stakeToken() from the out-of-scope list makes the publish run fail and opens
//     exactly one alert (the local stand-in for a GitHub issue);
//   - restoring it clears the failure and closes the alert.
// Needs network (source repo), yarn, forge and anvil. Reuses the main work dir's source clone and
// build cache, but its own test-chain check cache, so every walk really runs.
//   node --test tools/test/integration/scope-change.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { publish } from '../../src/lib/publish.ts'
import { LocalAlertSink } from '../../src/lib/alerts.ts'

const DATA = path.resolve(import.meta.dirname, '../../..')
const MAIN_WORK = process.env.REGISTRY_WORK_DIR ?? path.join(DATA, '.work')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('scope change fails the run with exactly one alert, and restoring it clears the alert', { timeout: 3 * 60 * 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-scope-'))
  const data = path.join(tmp, 'data')
  git(tmp, 'clone', '--quiet', DATA, data)
  const work = path.join(tmp, 'work')
  fs.mkdirSync(work)
  for (const d of ['sources', 'results']) fs.symlinkSync(path.join(MAIN_WORK, d), path.join(work, d))
  const alertsDir = path.join(tmp, 'alerts')
  const alerts = new LocalAlertSink(alertsDir)
  const openAlerts = () => (fs.existsSync(alertsDir) ? fs.readdirSync(alertsDir) : []).map(f => JSON.parse(fs.readFileSync(path.join(alertsDir, f), 'utf8'))).filter(a => a.state === 'open')
  const run = (label: string) => publish({ dataRepo: data, workDir: work, source: 'nitro-contracts', alerts, log: s => console.error(`[${label}] ${s}`) })

  // 0. Baseline: nothing new, current list. Passes, commits nothing.
  const head0 = git(data, 'rev-parse', 'HEAD')
  const r0 = await run('baseline')
  assert.equal(r0.commit, null, 'nothing new: no commit')
  assert.equal(git(data, 'status', '--porcelain'), '', 'nothing new: no diff')
  assert.equal(git(data, 'rev-parse', 'HEAD'), head0)
  assert.ok(r0.checks.length > 0, 'the newest tag (and any release or hotfix head) was checked')
  assert.ok(r0.ok, `baseline failed: ${JSON.stringify(r0.failures, null, 2)}`)
  assert.equal(openAlerts().length, 0)

  // 1. Remove stakeToken() from the out-of-scope list.
  const listFile = path.join(data, 'config/nitro-contracts/out-of-scope-getters.json')
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'))
  delete list.getters['stakeToken()']
  fs.writeFileSync(listFile, JSON.stringify(list, null, 2) + '\n')
  git(data, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-am', 'test: stakeToken() in scope')
  const r1 = await run('removed')
  assert.equal(r1.ok, false, 'the run fails')
  assert.deepEqual(Object.keys(r1.failures), ['test-chain-walk'])
  assert.ok(r1.failures['test-chain-walk']!.every(i => /stakeToken\(\)/.test(i.details ?? '')), 'the failure names the getter')
  assert.equal(openAlerts().length, 1, 'exactly one alert is open')
  assert.equal(openAlerts()[0].title, '[registry] nitro-contracts: test-chain walk failed (test-chain-walk)')
  assert.equal(r1.commit, null, 'no data changes')

  // A second failing run updates the same alert rather than opening another.
  const r1b = await run('removed-again')
  assert.equal(r1b.ok, false)
  assert.equal(openAlerts().length, 1)

  // 2. Restore it.
  git(data, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'revert', '--no-edit', 'HEAD')
  const r2 = await run('restored')
  assert.ok(r2.ok, `restored run failed: ${JSON.stringify(r2.failures, null, 2)}`)
  assert.equal(openAlerts().length, 0, 'the alert is closed')
  assert.ok(r2.alerts.some(a => a.kind === 'test-chain-walk' && a.action === 'closed'))
  assert.equal(git(data, 'status', '--porcelain'), '')

  fs.rmSync(tmp, { recursive: true, force: true })
})
