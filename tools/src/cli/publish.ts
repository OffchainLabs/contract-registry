// Publish run (and reconcile job) for some or every configured source repo, one at a time in
// source id order, each landing as its own commit.
//   node tools/src/cli/publish.ts [--source <id> ...] [--reconcile] [--push]
//        [--work-dir .work] [--alerts local:<dir> | github:<owner/repo>] [--concurrency 3]
// --source (repeatable) defaults to every source configured under config/.
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { git } from '../lib/exec.ts'
import { listSources } from '../lib/config.ts'
import { publish } from '../lib/publish.ts'
import { GitHubAlertSink, LocalAlertSink, type AlertSink } from '../lib/alerts.ts'

const { values: a } = parseArgs({
  options: {
    'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    'work-dir': { type: 'string' },
    source: { type: 'string', multiple: true },
    reconcile: { type: 'boolean', default: false },
    push: { type: 'boolean', default: false },
    alerts: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    'skip-test-chains': { type: 'boolean', default: false },
  },
})
const dataRepo = path.resolve(a['data-repo']!)
const workDir = path.resolve(a['work-dir'] ?? process.env.REGISTRY_WORK_DIR ?? path.join(dataRepo, '.work'))

function sink(spec: string | undefined): AlertSink {
  const s = spec ?? process.env.REGISTRY_ALERTS ?? `local:${path.join(workDir, 'alerts')}`
  if (s.startsWith('github:')) {
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('github alerts need GITHUB_TOKEN')
    return new GitHubAlertSink(s.slice(7), token)
  }
  return new LocalAlertSink(path.resolve(s.replace(/^local:/, '')))
}

const alerts = sink(a.alerts)
// In id order, as listSources gives them, so a run's order never depends on how it was invoked.
const sources = a.source ? [...new Set(a.source)].sort() : listSources(dataRepo)
let ok = true
for (const source of sources) {
  // Serialized runs: if the push is rejected because another run landed first, start over on the new tip.
  for (let attempt = 1; ; attempt++) {
    const o = await publish({
      dataRepo, workDir, source, alerts, reconcile: a.reconcile, concurrency: Number(a.concurrency),
      skipTestChains: a['skip-test-chains'],
    })
    console.log(JSON.stringify({ source, ...o, checks: o.checks.map(c => ({ commit: c.commit, ok: c.ok, problems: c.problems })) }, null, 2))
    ok &&= o.ok
    if (!a.push || !o.commit) break
    try {
      git(['push', 'origin', 'HEAD:main'], dataRepo)
      break
    } catch (e) {
      if (attempt >= 5) throw e
      console.error(`push rejected; retrying on the new tip (${(e as Error).message.split('\n')[0]})`)
      git(['fetch', 'origin', 'main'], dataRepo)
      git(['reset', '--hard', 'origin/main'], dataRepo)
    }
  }
}
process.exit(ok ? 0 : 1)
