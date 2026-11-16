import { listSources, loadSourceConfig } from './config.ts'
import { SourceRepo } from './source.ts'
import { Builder, type BuildFailure } from './build.ts'
import { SourceData, contractsMap } from './datarepo.ts'
import { compareTags } from './semver.ts'
import type { Hex } from './types.ts'

export interface RebuildOptions {
  dataRepo: string
  workDir: string
  /** The source's id (its `directory`), e.g. `nitro-contracts`. */
  source: string
  /** The tags to rebuild; every tag file of the source if omitted. */
  tags?: string[]
  /** Fetch the source repo first (default true). Without it, the clone in `workDir` must exist. */
  sync?: boolean
  /** Read the source repo from here instead of the configured URL (tests use a local repo). */
  sourceUrl?: string
  log?: (s: string) => void
}

export interface TagRebuild {
  tag: string
  /** The commit the tag file records, which is what is rebuilt. */
  commit: string
  /** The build profile the commit selected, or null if none could be selected. */
  profile: string | null
  /** How many contracts the rebuild fingerprinted. */
  contracts: number
  reproduced: boolean
  /** Why the commit didn't build. Absent when it built. */
  failure?: { kind: BuildFailure['kind'] | 'error'; message: string }
  /** Contracts whose fingerprint differs from the tag file's, or that only one side has. */
  differences: { contract: string; recorded: Hex | null; rebuilt: Hex | null }[]
}

export interface RebuildReport {
  source: string
  repo: string
  /** True when every tag reproduced. */
  reproduced: boolean
  /** In semver order. */
  tags: TagRebuild[]
}

type CommitBuild = Pick<TagRebuild, 'profile' | 'failure'> & { contracts: Record<string, Hex> | null }

/**
 * Rebuilds a source's tags from scratch, each at the commit its tag file records with the build
 * profile that commit selects, and compares the fingerprints with the tag file. Writes nothing to
 * the data repo; builds go under `workDir` as for publish (logs in `logs/<source>/<commit>.fresh.log`).
 * A commit that several tags point at is built once. A failed build is reported, not thrown, so
 * one bad tag doesn't hide the others.
 */
export async function rebuild(opts: RebuildOptions): Promise<RebuildReport> {
  const log = opts.log ?? (() => {})
  const configured = listSources(opts.dataRepo)
  if (!configured.includes(opts.source)) throw new Error(`no configured source ${opts.source} (configured: ${configured.join(', ') || 'none'})`)
  const cfg = loadSourceConfig(opts.dataRepo, opts.source)
  const data = new SourceData(opts.dataRepo, cfg.directory, cfg.repo)
  const all = data.tags()
  if (!all.length) throw new Error(`${cfg.directory} has no tag files`)
  const files = opts.tags
    ? [...new Set(opts.tags)].map(t => all.find(f => f.tag === t) ?? fail(`${cfg.directory} has no tag file for ${t}`))
    : all
  files.sort((a, b) => compareTags(a.tag, b.tag))

  const src = new SourceRepo(opts.sourceUrl ? { ...cfg, url: opts.sourceUrl } : cfg, opts.workDir)
  if (opts.sync ?? true) {
    log(`syncing ${src.cfg.url}`)
    src.sync(log)
  }
  const builder = new Builder(src, opts.workDir)
  const builds = new Map<string, CommitBuild>()
  const tags: TagRebuild[] = []
  for (const t of files) {
    let b = builds.get(t.commit)
    if (!b) {
      log(`rebuilding ${files.filter(f => f.commit === t.commit).map(f => f.tag).join(', ')} at ${t.commit.slice(0, 12)}`)
      b = await buildCommit(builder, t.commit, log)
      builds.set(t.commit, b)
    }
    const rebuilt = b.contracts ?? {}
    const differences = b.contracts
      ? [...new Set([...Object.keys(t.contracts), ...Object.keys(rebuilt)])].sort()
        .filter(k => t.contracts[k] !== rebuilt[k])
        .map(k => ({ contract: k, recorded: t.contracts[k] ?? null, rebuilt: rebuilt[k] ?? null }))
      : []
    const reproduced = !b.failure && differences.length === 0
    tags.push({
      tag: t.tag, commit: t.commit, profile: b.profile, contracts: Object.keys(rebuilt).length, reproduced,
      ...(b.failure ? { failure: b.failure } : {}), differences,
    })
    log(`${t.tag}: ${reproduced ? 'reproduced' : b.failure ? b.failure.kind : `${differences.length} contract(s) differ`}`)
  }
  return { source: cfg.directory, repo: cfg.repo, reproduced: tags.every(t => t.reproduced), tags }
}

async function buildCommit(builder: Builder, commit: string, log: (s: string) => void): Promise<CommitBuild> {
  try {
    const { result } = await builder.build(commit, { fresh: true, log })
    return result.ok
      ? { profile: result.profile, contracts: contractsMap(result.contracts) }
      : { profile: result.profile, contracts: null, failure: result.failure! }
  } catch (e) {
    // Thrown before the build starts, e.g. no build profile matches the commit. (A commit missing
    // from the source repo fails its checkout, a build failure.)
    return { profile: null, contracts: null, failure: { kind: 'error', message: (e as Error).message } }
  }
}

function fail(message: string): never {
  throw new Error(message)
}
