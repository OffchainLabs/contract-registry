import * as fs from 'node:fs'
import * as path from 'node:path'
import { git, gitOk } from './exec.ts'
import { refMatches } from './glob.ts'
import { compareTags, isPrerelease, isSemver } from './semver.ts'
import type { Hex, RoleConfig } from './types.ts'

/** Two fingerprints (in either order) and what the review found. */
export interface ReviewedRangePair { fingerprints: [Hex, Hex]; note: string }

export interface BuildOutput {
  name: string
  commands: string[]
  env?: Record<string, string>
  /** Directory of solc standard-JSON build-info files, relative to the checkout. */
  buildInfo: string
  /** How to tell which compilation job produced each artifact. */
  layout: 'hardhat' | 'standard-json'
  artifacts?: string
  /** Contracts from this output are fingerprinted (it is what the deploy scripts use). */
  deployed: boolean
  /** Name of the deployed output this one must agree with, byte for byte. */
  parityWith?: string
}

/**
 * Selects source commits. Every condition given must hold; an empty selector matches every commit.
 * - `descendantOf`: the commit is each of these refs or descends from it.
 * - `notDescendantOf`: the commit is none of these refs and descends from none of them.
 * - `refs`: the commit is what one of these refs points at.
 * - `tags`: one of the published tags pointing at the commit is a semver version with
 *   `from` <= version < `before` (semver precedence, so `v3.2.0-beta.0` is before `v3.2.0`).
 *   Either bound may be left out. A commit no published tag points at (a branch head) never
 *   matches.
 */
export interface RefSelector {
  descendantOf?: string[]
  notDescendantOf?: string[]
  refs?: string[]
  tags?: { from?: string; before?: string }
}

export interface BuildProfile {
  name: string
  /** Applies to commits matching this selector; the first matching profile wins. */
  when: RefSelector
  toolchain: Record<string, string>
  setup: string[]
  outputs: BuildOutput[]
  include: string[]
  exclude: string[]
}

/**
 * Which refs are published (see `tagInRange`). Tags and branch heads that contain `tag` are; with
 * `releasesFrom`, so is every release tag (no semver prerelease part) at or above that version,
 * wherever its commit is: old releases, and releases on side branches such as `v3.1.1`.
 */
export interface StartConfig {
  tag: string
  releasesFrom?: string
}

export interface SourceConfig {
  schemaVersion: number
  repo: string
  url: string
  directory: string
  start: StartConfig
  publishedRefs: { tags: string[]; branches: string[] }
  tagValidation: { rule: 'tag-equals-v-package-version'; allowlist: Record<string, string> }
  outOfScopeGetters: string
  /**
   * Proxies and proxy admins by fully qualified name; every other contract is logic. Read when an
   * entry is written, so a contract must be listed before its first build is published.
   */
  contractRoles: Record<string, RoleConfig>
  /**
   * Pairs of entries of one code length whose masked bytes differ, each reviewed by rebuilding both
   * and confirming that no code can match both. Every other such pair fails publish and CI (see
   * `rangeConflicts`).
   */
  reviewedRangePairs: ReviewedRangePair[]
  /**
   * How the test-chain check deploys chains, and which commits it applies to (`when`; absent
   * means every built commit). Published commits outside `when` are built and published without
   * the check, and each run reports them as skipped.
   */
  testChains: { deployer: string; when?: RefSelector } | null
  reconcileGraceMinutes: number
  builds: BuildProfile[]
}

export interface OutOfScopeList {
  schemaVersion: number
  repo: string
  getters: Record<string, string>
}

export function configDir(dataRepo: string): string {
  return path.join(dataRepo, 'config')
}

export function listSources(dataRepo: string): string[] {
  return fs.readdirSync(configDir(dataRepo)).filter(d => fs.existsSync(path.join(configDir(dataRepo), d, 'sources.json'))).sort()
}

export function loadSourceConfig(dataRepo: string, source: string): SourceConfig {
  return JSON.parse(fs.readFileSync(path.join(configDir(dataRepo), source, 'sources.json'), 'utf8'))
}

export function loadOutOfScope(dataRepo: string, cfg: SourceConfig): OutOfScopeList {
  return JSON.parse(fs.readFileSync(path.join(dataRepo, cfg.outOfScopeGetters), 'utf8'))
}

/**
 * Whether a published tag is in range: its commit contains `start.tag` (prereleases included), or,
 * with `start.releasesFrom`, it is a release (a semver version with no prerelease part) at or
 * above that version, wherever its commit is. `containsStart` is only called when needed.
 */
export function tagInRange(start: StartConfig, tag: string, containsStart: () => boolean): boolean {
  if (start.releasesFrom && isSemver(tag) && !isPrerelease(tag) && compareTags(tag, start.releasesFrom) >= 0) return true
  return containsStart()
}

/** What a `RefSelector` needs to know about the source repo. */
export interface RefFacts {
  /** Whether `commit` is `ref`'s commit or descends from it. */
  contains(ref: string, commit: string): boolean
  /** Whether `ref` points at `commit`. */
  pointsAt(ref: string, commit: string): boolean
  /** The published tags pointing at `commit`. */
  tagsAt(commit: string): string[]
}

/** Whether a tag is a semver version in `[from, before)`, by semver precedence. */
export function tagInSemverRange(tag: string, range: { from?: string; before?: string }): boolean {
  return isSemver(tag) && (!range.from || compareTags(tag, range.from) >= 0) && (!range.before || compareTags(tag, range.before) < 0)
}

export function selectorMatches(sel: RefSelector, facts: RefFacts, commit: string): boolean {
  if (sel.refs && !sel.refs.some(r => facts.pointsAt(r, commit))) return false
  if (sel.descendantOf && !sel.descendantOf.every(r => facts.contains(r, commit))) return false
  if (sel.notDescendantOf && sel.notDescendantOf.some(r => facts.contains(r, commit))) return false
  if (sel.tags && !facts.tagsAt(commit).some(t => tagInSemverRange(t, sel.tags!))) return false
  return true
}

/** A short description of a selector, for logs and outcomes. */
export function describeSelector(sel: RefSelector): string {
  const parts: string[] = []
  if (sel.descendantOf) parts.push(`descendant of ${sel.descendantOf.join(' and ')}`)
  if (sel.notDescendantOf) parts.push(`not descendant of ${sel.notDescendantOf.join(' or ')}`)
  if (sel.refs) parts.push(`at ${sel.refs.join(' or ')}`)
  if (sel.tags) {
    const bounds = [sel.tags.from && `>= ${sel.tags.from}`, sel.tags.before && `< ${sel.tags.before}`].filter(Boolean)
    parts.push(`tagged ${bounds.length ? bounds.join(' and ') : 'with a semver version'}`)
  }
  return parts.length ? parts.join(', ') : 'every commit'
}

/** `RefFacts` read from a source repo's git directory. */
export function gitRefFacts(cfg: Pick<SourceConfig, 'publishedRefs'>, gitDir: string): RefFacts {
  return {
    contains: (ref, commit) => isAncestor(gitDir, ref, commit),
    pointsAt: (ref, commit) => resolvesTo(gitDir, ref, commit),
    tagsAt: commit => {
      const out = git(['for-each-ref', `--points-at=${commit}`, '--format=%(refname:strip=2)', 'refs/tags'], gitDir).trim()
      return (out ? out.split('\n') : []).filter(t => refMatches(t, cfg.publishedRefs.tags))
    },
  }
}

/**
 * Chooses the build profile for a commit: the first whose `when` matches. Settings vary by ref
 * range, so old releases are built with their own toolchain and outputs.
 */
export function selectProfile(builds: BuildProfile[], facts: RefFacts, commit: string): BuildProfile {
  const p = builds.find(b => selectorMatches(b.when, facts, commit))
  if (!p) throw new Error(`no build profile matches commit ${commit}`)
  return p
}

export function profileFor(cfg: SourceConfig, sourceGitDir: string, commit: string): BuildProfile {
  return selectProfile(cfg.builds, gitRefFacts(cfg, sourceGitDir), commit)
}

/** Whether the test-chain check applies to a commit: `testChains.when`, or every commit without it. */
export function testChainsApply(cfg: Pick<SourceConfig, 'testChains'>, facts: RefFacts, commit: string): boolean {
  return !!cfg.testChains && selectorMatches(cfg.testChains.when ?? {}, facts, commit)
}

function isAncestor(gitDir: string, ref: string, commit: string): boolean {
  return gitOk(['merge-base', '--is-ancestor', `${ref}^{commit}`, commit], gitDir)
}

function resolvesTo(gitDir: string, ref: string, commit: string): boolean {
  try {
    return gitOk(['rev-parse', '--verify', `${ref}^{commit}`], gitDir) && isAncestor(gitDir, ref, commit) && isAncestor(gitDir, commit, ref)
  } catch { return false }
}
