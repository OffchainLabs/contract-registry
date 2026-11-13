import * as fs from 'node:fs'
import * as path from 'node:path'
import { git, gitOk, mapLimit } from './exec.ts'
import { loadOutOfScope, loadSourceConfig, type SourceConfig } from './config.ts'
import { SourceRepo } from './source.ts'
import { Builder, type BuildResult, type Checkout } from './build.ts'
import { SourceData, byFingerprint, contractsMap, entryFromBuild } from './datarepo.ts'
import { validateDataRepo } from './schema.ts'
import { rangeConflictReport, rangeConflicts } from './ranges.ts'
import { compareTags, isPrerelease } from './semver.ts'
import { ALERT_KINDS, type AlertItem, type AlertKind, type AlertSink } from './alerts.ts'
import { CheckCache, checkCommit, checkKey, loadDeployer, type CheckResult } from './testcheck.ts'
import { SCHEMA_VERSION } from './types.ts'

export interface PublishOptions {
  dataRepo: string
  workDir: string
  /** Source repo directory name, e.g. `nitro-contracts`. */
  source: string
  alerts: AlertSink
  /** Also verify that every published ref has been processed, and alert on gaps (§5.7 reconcile job). */
  reconcile?: boolean
  concurrency?: number
  /** Skip the test-chain walk (only for local experiments; CI never sets this). */
  skipTestChains?: boolean
  /** Identity for the data repo commit. */
  committer?: { name: string; email: string }
  /** Read the source repo from here instead of the configured URL (tests use a local repo). */
  sourceUrl?: string
  now?: number
  log?: (s: string) => void
}

export interface PublishOutcome {
  ok: boolean
  commit: string | null
  newEntries: number
  branchesUpdated: string[]
  branchesDeleted: string[]
  tagsAdded: string[]
  failures: Partial<Record<AlertKind, AlertItem[]>>
  checks: CheckResult[]
  alerts: { kind: AlertKind; action: 'opened-or-updated' | 'closed'; ref?: string }[]
}

interface PlannedCommit { commit: string; branch: string }

/**
 * One publish run for one source repo (§5.7). Everything lands in the data repo as one commit;
 * a run that crashes before committing publishes nothing, and a rerun with nothing new is a no-op.
 */
export async function publish(opts: PublishOptions): Promise<PublishOutcome> {
  const log = opts.log ?? ((s: string) => console.error(s))
  const now = opts.now ?? Date.now()
  const cfg: SourceConfig = loadSourceConfig(opts.dataRepo, opts.source)
  const outOfScope = Object.keys(loadOutOfScope(opts.dataRepo, cfg).getters)
  const failures: Partial<Record<AlertKind, AlertItem[]>> = {}
  const fail = (kind: AlertKind, item: AlertItem) => { (failures[kind] ??= []).push(item); log(`FAILURE ${kind}: ${item.key}: ${item.message}`) }
  const outcome: PublishOutcome = { ok: false, commit: null, newEntries: 0, branchesUpdated: [], branchesDeleted: [], tagsAdded: [], failures, checks: [], alerts: [] }

  const lock = acquireLock(opts.workDir, opts.source)
  const checkouts: Checkout[] = []
  try {
    const src = new SourceRepo(opts.sourceUrl ? { ...cfg, url: opts.sourceUrl } : cfg, opts.workDir)
    log(`syncing ${cfg.url}`)
    src.sync(log)
    const data = new SourceData(opts.dataRepo, cfg.directory, cfg.repo)
    const builder = new Builder(src, opts.workDir)
    const start = src.resolve(cfg.start.tag)
    const startExclusions = src.parents(start)
    const inRange = (commit: string) => commit === start || src.isAncestor(start, commit)

    // --- Refs -------------------------------------------------------------------------------
    const branches = src.publishedBranches()
    const recorded = new Map(data.branches().map(b => [b.branch, b.commit]))
    const deleted = [...recorded.keys()].filter(b => !branches.has(b)).sort()
    const processedHeads = [...recorded.values()].filter(c => src.exists(c))

    const plan: PlannedCommit[] = []
    const planned = new Set<string>()
    const changedBranches: [string, string][] = []
    for (const [branch, head] of branches) {
      if (!inRange(head)) { log(`skip branch ${branch}: doesn't contain ${cfg.start.tag}`); continue }
      if (recorded.get(branch) === head) continue
      changedBranches.push([branch, head])
      for (const c of src.revList(head, [...processedHeads, ...startExclusions])) {
        if (!planned.has(c)) { planned.add(c); plan.push({ commit: c, branch }) }
      }
    }
    const tags = src.publishedTags()
    const newTags = [...tags].filter(([t, c]) => !data.hasTag(t) && inRange(c)).sort((a, b) => compareTags(a[0], b[0]))
    const skippedTags = [...tags].filter(([t, c]) => !data.hasTag(t) && !inRange(c)).map(([t]) => t)
    if (skippedTags.length) log(`${skippedTags.length} tag(s) not descended from ${cfg.start.tag} are out of range (not published)`)
    log(`plan: ${plan.length} new branch commit(s), ${changedBranches.length} changed branch(es), ${newTags.length} new tag(s), ${deleted.length} deleted branch(es)`)

    if (opts.reconcile) {
      const grace = cfg.reconcileGraceMinutes * 60_000
      for (const [branch, head] of changedBranches) {
        if (now - src.refTime(head) > grace) fail('reconcile-gap', { key: `branch:${branch}`, message: `branch ${branch} head ${head.slice(0, 12)} was not processed`, commit: head, refs: [branch] })
      }
      for (const [t, c] of newTags) {
        if (now - src.refTime(`refs/tags/${t}`) > grace) fail('reconcile-gap', { key: `tag:${t}`, message: `tag ${t} has no tags/ file`, commit: c, refs: [t] })
      }
    }

    // --- Which commits need a test-chain check ----------------------------------------------
    const deployerName = cfg.testChains?.deployer
    const key = deployerName ? checkKey(outOfScope, deployerName) : ''
    const checkCache = new CheckCache(opts.workDir, cfg.directory)
    const checkTargets = new Map<string, string[]>() // commit -> refs
    const addTarget = (c: string, ref: string) => checkTargets.set(c, [...new Set([...(checkTargets.get(c) ?? []), ref])])
    if (deployerName && !opts.skipTestChains) {
      for (const [branch, head] of branches) if (inRange(head)) {
        if (recorded.get(branch) !== head || !checkCache.get(head, key)) addTarget(head, branch)
      }
      for (const [t, c] of newTags) addTarget(c, t)
      const open = await opts.alerts.get(cfg.directory, 'test-chain-walk')
      for (const i of open?.items ?? []) if (i.commit && src.exists(i.commit)) for (const r of i.refs ?? ['(open alert)']) addTarget(i.commit, r)
    }
    const needsCheck = (c: string) => checkTargets.has(c) && !checkCache.get(c, key)

    // --- Builds -----------------------------------------------------------------------------
    const results = new Map<string, BuildResult>()
    const checkoutFor = new Map<string, Checkout>()
    const toBuild = [...new Set([...plan.map(p => p.commit), ...changedBranches.map(([, h]) => h), ...[...checkTargets.keys()].filter(needsCheck)])]
    const tagCommits = new Set(newTags.map(([, c]) => c))
    const concurrency = opts.concurrency ?? 3
    let done = 0
    await mapLimit(toBuild, concurrency, async c => {
      // A new tag's commit is rebuilt fresh below; keep this checkout only if nothing else will.
      const keep = needsCheck(c) && !tagCommits.has(c)
      const { result, checkout } = await builder.build(c, { keepCheckout: keep, log })
      results.set(c, result)
      if (checkout) { checkouts.push(checkout); checkoutFor.set(c, checkout) }
      if (++done % 10 === 0 || done === toBuild.length) log(`built ${done}/${toBuild.length}`)
    })

    // --- Apply branch commits in history order ----------------------------------------------
    for (const { commit, branch } of plan) {
      const r = results.get(commit)!
      if (!r.ok) {
        const head = branches.get(branch) === commit
        fail(r.failure!.kind, { key: commit, commit, refs: [branch], head, message: `${r.failure!.kind} at ${commit.slice(0, 12)} on ${branch}${head ? ' (branch head)' : ''}`, details: r.failure!.message })
        continue
      }
      for (const [fp, cs] of byFingerprint(r.contracts)) {
        if (!data.hasEntry(fp)) { data.writeEntry(entryFromBuild(cfg.repo, cs, commit, branch, cfg.contractRoles)); outcome.newEntries++ }
      }
    }
    for (const [branch, head] of changedBranches) {
      const r = results.get(head)!
      if (!r.ok) {
        if (!planned.has(head)) fail(r.failure!.kind, { key: head, commit: head, refs: [branch], head: true, message: `${r.failure!.kind} at ${head.slice(0, 12)}, head of ${branch}`, details: r.failure!.message })
        continue
      }
      if (!planned.has(head)) {
        const missing = r.contracts.filter(c => !data.hasEntry(c.fingerprint))
        if (missing.length) {
          fail('tag-nondeterministic', { key: `branch:${branch}@${head}`, commit: head, refs: [branch], message: `rebuilding ${head.slice(0, 12)} (head of ${branch}, processed before) produced ${missing.length} fingerprint(s) with no entry`, details: missing.map(m => `${m.fqName} ${m.fingerprint}`).join('\n') })
          continue
        }
      }
      if (data.writeBranch({ schemaVersion: SCHEMA_VERSION, repo: cfg.repo, branch, commit: head, contracts: contractsMap(r.contracts) })) outcome.branchesUpdated.push(branch)
    }
    for (const b of deleted) { data.deleteBranch(b); outcome.branchesDeleted.push(b) }
    const publishedHeads = data.branches().map(b => b.commit).filter(c => src.exists(c))
    const onPublishedBranch = (c: string) => publishedHeads.some(h => h === c || src.isAncestor(c, h))

    // --- Tags: always a fresh build, which must reproduce the branch build ---------------------
    for (const [tag, commit] of newTags) {
      const { result: r, checkout } = await builder.build(commit, { fresh: true, keepCheckout: needsCheck(commit), log })
      if (checkout) { checkouts.push(checkout); checkoutFor.set(commit, checkout) }
      if (!r.ok) {
        fail(r.failure!.kind, { key: `tag:${tag}`, commit, refs: [tag], head: true, tag, message: `${r.failure!.kind} building tag ${tag} at ${commit.slice(0, 12)}`, details: r.failure!.message })
        continue
      }
      if (!results.has(commit)) results.set(commit, r)
      const expected = `v${r.packageVersion}`
      if (tag !== expected && !(tag in cfg.tagValidation.allowlist)) {
        fail('tag-version-mismatch', { key: `tag:${tag}`, commit, refs: [tag], tag, message: `tag ${tag} but package.json version at ${commit.slice(0, 12)} is ${r.packageVersion}` })
      }
      if (onPublishedBranch(commit)) {
        const branchBuild = builder.cached(commit)
        const mine = contractsMap(r.contracts)
        const diffs = branchBuild
          ? diffMaps(contractsMap(branchBuild.contracts), mine)
          : r.contracts.filter(c => !data.hasEntry(c.fingerprint)).map(c => `${c.fqName}: ${c.fingerprint} has no entry`)
        if (diffs.length) {
          fail('tag-nondeterministic', { key: `tag:${tag}`, commit, refs: [tag], tag, message: `tag ${tag} build doesn't reproduce the fingerprints of ${commit.slice(0, 12)} built through a branch; tag file not written`, details: diffs.join('\n') })
          continue
        }
      }
      for (const [fp, cs] of byFingerprint(r.contracts)) {
        if (!data.hasEntry(fp)) { data.writeEntry(entryFromBuild(cfg.repo, cs, commit, null, cfg.contractRoles)); outcome.newEntries++ }
      }
      data.writeTag({ schemaVersion: SCHEMA_VERSION, repo: cfg.repo, tag, commit, prerelease: isPrerelease(tag), packageVersion: r.packageVersion, contracts: contractsMap(r.contracts) })
      outcome.tagsAdded.push(tag)
    }

    // --- Range invariant: no code may match two entries ------------------------------------
    // Over every entry of the source, so new entries are checked against existing ones and
    // against each other. A conflict fails the whole run: the catch below discards everything.
    const conflicts = rangeConflicts(data.entries(), cfg.reviewedRangePairs)
    if (conflicts.length) throw new Error(`range invariant broken; nothing published. ${rangeConflictReport(cfg.directory, conflicts)}`)

    // --- Generated views and validation -----------------------------------------------------
    data.writeViews()
    const errors = validateDataRepo(opts.dataRepo, [{ directory: cfg.directory, repo: cfg.repo }])
    if (errors.length) throw new Error(`schema validation failed; nothing committed:\n${errors.slice(0, 50).join('\n')}`)

    // --- Test-chain checks (entries are published even if these fail) -----------------------
    if (deployerName && checkTargets.size) {
      const deployer = await loadDeployer(deployerName)
      for (const [commit, refs] of checkTargets) {
        let res = checkCache.get(commit, key)
        if (!res) {
          const r = results.get(commit)
          const co = checkoutFor.get(commit)
          if (!r?.ok || !co) {
            log(`no successful build of ${commit.slice(0, 12)}; test-chain check skipped (the build failure is reported)`)
            continue
          }
          res = await checkCommit({
            commit, key, checkoutDir: co.dir, commitFingerprints: new Set(r.contracts.map(c => c.fingerprint)),
            dataRepo: opts.dataRepo, directory: cfg.directory, repo: cfg.repo, outOfScope, deployer, log,
            walkOutDir: path.join(opts.workDir, 'walks', cfg.directory),
          })
          checkCache.put(res)
        }
        outcome.checks.push(res)
        if (!res.ok) fail('test-chain-walk', { key: commit, commit, refs, message: `test-chain walk failed at ${commit.slice(0, 12)} (${refs.join(', ')}): ${res.problems.length} problem(s)`, details: res.problems.join('\n') })
      }
    }

    // --- One commit ----------------------------------------------------------------------------
    outcome.commit = commitDataRepo(opts.dataRepo, cfg.directory, summarize(cfg, outcome, plan.length), opts.committer)
    if (outcome.commit) log(`committed ${outcome.commit.slice(0, 12)}`)
    else log('no changes')

    // --- Alerts ----------------------------------------------------------------------------------
    outcome.alerts = await reconcileAlerts(opts.alerts, cfg, data, src, failures, outcome.checks, !!opts.reconcile, key)
  } catch (e) {
    fail('publish-error', { key: 'run', message: (e as Error).message.split('\n')[0], details: (e as Error).stack })
    // Discard the run's uncommitted changes so a failure midway publishes nothing.
    try { git(['checkout', '--', cfg.directory], opts.dataRepo) } catch { /* nothing committed there yet */ }
    try { git(['clean', '-fdq', '--', cfg.directory], opts.dataRepo) } catch { /* nothing to discard */ }
    outcome.alerts = await reconcileAlerts(opts.alerts, cfg, null, null, failures, [], false, '').catch(() => [])
  } finally {
    for (const c of checkouts) c.remove()
    lock.release()
  }
  outcome.ok = Object.keys(failures).length === 0
  return outcome
}

function diffMaps(a: Record<string, string>, b: Record<string, string>): string[] {
  const out: string[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push(`${k}: branch build ${a[k] ?? '(none)'} vs tag build ${b[k] ?? '(none)'}`)
  return out.sort()
}

function summarize(cfg: SourceConfig, o: PublishOutcome, planned: number): string {
  const parts = [`${o.newEntries} new entr${o.newEntries === 1 ? 'y' : 'ies'} from ${planned} commit(s)`]
  if (o.tagsAdded.length) parts.push(`tags ${o.tagsAdded.join(', ')}`)
  if (o.branchesUpdated.length) parts.push(`branches ${o.branchesUpdated.join(', ')}`)
  if (o.branchesDeleted.length) parts.push(`deleted ${o.branchesDeleted.join(', ')}`)
  return `${cfg.directory}: ${parts.join('; ')}`
}

function commitDataRepo(dataRepo: string, directory: string, message: string, who?: { name: string; email: string }): string | null {
  git(['add', '-A', '--', directory], dataRepo)
  if (gitOk(['diff', '--cached', '--quiet', '--', directory], dataRepo)) return null
  const id = who ?? { name: 'contract-registry-bot', email: 'contract-registry-bot@users.noreply.github.com' }
  git(['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '--quiet', '-m', message, '--', directory], dataRepo)
  return git(['rev-parse', 'HEAD'], dataRepo).trim()
}

/**
 * Brings each alert in line with this run: new failures are added, items that are now resolved
 * are dropped, and an alert with no items left is closed. Items resolve as follows:
 * - build/parity failures and tag reproduction failures: when the ref they blocked is published
 *   (a branch whose file now points at that commit, or a tag whose file now exists). Failures on
 *   intermediate commits are never retried, so a person closes those after triage.
 * - tag/version mismatches: when the tag is added to the allowlist.
 * - test-chain walks: when the commit's check passes with the current out-of-scope list.
 * - reconcile gaps: when the ref has been processed.
 * - publish errors: when a run gets as far as committing.
 */
async function reconcileAlerts(
  sink: AlertSink, cfg: SourceConfig, data: SourceData | null, src: SourceRepo | null,
  failures: Partial<Record<AlertKind, AlertItem[]>>, checks: CheckResult[], reconcileRun: boolean, key: string,
): Promise<PublishOutcome['alerts']> {
  const out: PublishOutcome['alerts'] = []
  const branchCommits = new Map(data?.branches().map(b => [b.branch, b.commit]) ?? [])
  const refPublished = (i: AlertItem) => !!data && !!(i.tag ? data.hasTag(i.tag) : i.refs?.some(r => branchCommits.get(r) === i.commit))
  const checkPassed = (i: AlertItem) => checks.some(c => c.commit === i.commit && c.key === key && c.ok)
  for (const kind of ALERT_KINDS) {
    const open = await sink.get(cfg.directory, kind)
    const fresh = failures[kind] ?? []
    if (!open && !fresh.length) continue
    const resolved = (i: AlertItem): boolean => {
      if (!data) return false
      switch (kind) {
        case 'build-failure': case 'parity-mismatch': return !!i.head && refPublished(i)
        case 'tag-nondeterministic': return refPublished(i)
        case 'tag-version-mismatch': return !!i.tag && i.tag in cfg.tagValidation.allowlist
        case 'test-chain-walk': return checkPassed(i)
        case 'reconcile-gap': return reconcileRun && (refPublished(i) || (!!i.refs && !!src && i.refs.every(r => !src.publishedBranches().has(r) && !src.publishedTags().has(r))))
        case 'publish-error': return true
      }
    }
    const items = new Map<string, AlertItem>()
    for (const i of open?.items ?? []) if (!resolved(i)) items.set(i.key, i)
    for (const i of fresh) items.set(i.key, i)
    const runNote = `publish run ${new Date().toISOString()}`
    if (items.size) {
      const ref = await sink.upsert(cfg.directory, kind, [...items.values()], fresh, runNote)
      out.push({ kind, action: 'opened-or-updated', ref })
    } else if (open) {
      await sink.close(cfg.directory, kind, `${runNote}: every item resolved`)
      out.push({ kind, action: 'closed', ref: open.ref })
    }
  }
  return out
}

function acquireLock(workDir: string, source: string): { release(): void } {
  const f = path.join(workDir, `publish-${source}.lock`)
  fs.mkdirSync(workDir, { recursive: true })
  if (fs.existsSync(f)) {
    const pid = Number(fs.readFileSync(f, 'utf8'))
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* stale */ }
    if (alive && pid !== process.pid) throw new Error(`another publish run for ${source} holds ${f} (pid ${pid})`)
  }
  fs.writeFileSync(f, String(process.pid))
  return { release: () => fs.rmSync(f, { force: true }) }
}
