// Ad-hoc test-chain check of one source commit: builds it, deploys the test chains, walks each
// with the registry in this working tree and prints the result. Reads nothing from, and writes
// nothing to, the data repo.
//   node tools/src/cli/check.ts --rev <tag|branch|sha> [--source nitro-contracts] [--out-of-scope <file>]
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { describeSelector, gitRefFacts, loadOutOfScope, loadSourceConfig, testChainsApply } from '../lib/config.ts'
import { SourceRepo } from '../lib/source.ts'
import { Builder } from '../lib/build.ts'
import { checkCommit, checkKey, loadDeployer } from '../lib/testcheck.ts'

const { values: a } = parseArgs({
  options: {
    'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    'work-dir': { type: 'string' },
    source: { type: 'string', default: 'nitro-contracts' },
    rev: { type: 'string' },
    'out-of-scope': { type: 'string' },
    'no-sync': { type: 'boolean', default: false },
  },
})
if (!a.rev) { console.error('usage: check --rev <rev>'); process.exit(2) }
const dataRepo = path.resolve(a['data-repo']!)
const workDir = path.resolve(a['work-dir'] ?? process.env.REGISTRY_WORK_DIR ?? path.join(dataRepo, '.work'))
const cfg = loadSourceConfig(dataRepo, a.source!)
if (!cfg.testChains) { console.error(`${a.source} has no test-chain deployer`); process.exit(2) }
const outOfScope = Object.keys(a['out-of-scope'] ? JSON.parse(fs.readFileSync(a['out-of-scope'], 'utf8')).getters : loadOutOfScope(dataRepo, cfg).getters)
const src = new SourceRepo(cfg, workDir)
if (!a['no-sync']) src.sync()
const commit = src.resolve(a.rev)
if (!testChainsApply(cfg, gitRefFacts(cfg, src.gitDir), commit)) {
  console.error(`${a.rev} (${commit.slice(0, 12)}) is outside testChains.when (${describeSelector(cfg.testChains.when ?? {})}); publish skips its test-chain check`)
  process.exit(2)
}
const log = (s: string) => console.error(s)
const { result, checkout } = await new Builder(src, workDir).build(commit, { keepCheckout: true, log })
if (!result.ok || !checkout) { console.error(`build failed: ${result.failure?.message}`); process.exit(1) }
try {
  const res = await checkCommit({
    commit, key: checkKey(outOfScope, cfg.testChains.deployer), checkoutDir: checkout.dir,
    commitFingerprints: new Set(result.contracts.map(c => c.fingerprint)), dataRepo, directory: cfg.directory, repo: cfg.repo,
    outOfScope, deployer: await loadDeployer(cfg.testChains.deployer), log, walkOutDir: path.join(workDir, 'walks', cfg.directory),
  })
  console.log(JSON.stringify(res, null, 2))
  process.exitCode = res.ok ? 0 : 1
} finally {
  checkout.remove()
}
