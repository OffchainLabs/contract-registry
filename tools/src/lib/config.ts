import * as fs from 'node:fs'
import * as path from 'node:path'
import { gitOk } from './exec.ts'
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

export interface BuildProfile {
  name: string
  /** Applies to commits matching this selector; the first matching profile wins. */
  when: { descendantOf?: string[]; notDescendantOf?: string[]; refs?: string[] }
  toolchain: Record<string, string>
  setup: string[]
  outputs: BuildOutput[]
  include: string[]
  exclude: string[]
}

export interface SourceConfig {
  schemaVersion: number
  repo: string
  url: string
  directory: string
  start: { tag: string }
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
  testChains: { deployer: string } | null
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

/** Chooses the build profile for a commit (settings can vary by ref range for later backfill). */
export function profileFor(cfg: SourceConfig, sourceGitDir: string, commit: string): BuildProfile {
  for (const p of cfg.builds) {
    const w = p.when
    if (w.refs && !w.refs.some(r => resolvesTo(sourceGitDir, r, commit))) continue
    if (w.descendantOf && !w.descendantOf.every(r => isAncestor(sourceGitDir, r, commit))) continue
    if (w.notDescendantOf && w.notDescendantOf.some(r => isAncestor(sourceGitDir, r, commit))) continue
    return p
  }
  throw new Error(`no build profile matches commit ${commit}`)
}

function isAncestor(gitDir: string, ref: string, commit: string): boolean {
  return gitOk(['merge-base', '--is-ancestor', `${ref}^{commit}`, commit], gitDir)
}

function resolvesTo(gitDir: string, ref: string, commit: string): boolean {
  try {
    return gitOk(['rev-parse', '--verify', `${ref}^{commit}`], gitDir) && isAncestor(gitDir, ref, commit) && isAncestor(gitDir, commit, ref)
  } catch { return false }
}
