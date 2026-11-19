// Another source's code in a build. A source's build compiles its dependencies too, and some are
// other sources: the token bridge installs @arbitrum/nitro-contracts and
// @offchainlabs/upgrade-executor, and has nitro-contracts as a git submodule. A source never
// publishes that code: it would get entries with this source's repo and versions, built with this
// source's settings. Each source lists its npm package names (`npmPackages` in sources.json), and
// publish and add-entry refuse a contract from another source's package or repo; ci-check checks
// the data already published.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { git } from './exec.ts'
import { normalizeSource, packageRootOf } from './extract.ts'
import { sourcesConfigPath } from './layout.ts'

/** What another source's code is recognised by: its repo and its npm package names. */
export interface SourceIdentity { id: string; repo: string; npmPackages: string[] }

/** A git submodule of a checkout: its path there, and the GitHub repo (`owner/name`) it clones, or null. */
export interface Submodule { path: string; repo: string | null }

/** A contract whose code is another source's. */
export interface ForeignCode {
  /** Fully qualified name. */
  contract: string
  /** The id of the source whose package or repo the code is in. */
  owner: string
  /** How: `package @arbitrum/nitro-contracts@3.1.0` or `git submodule lib/nitro-contracts (OffchainLabs/nitro-contracts)`. */
  via: string
  /** The build profile exclude that leaves it out: the package or submodule directory, then `/**`. */
  exclude: string
}

/** The source file of a fully qualified name, `<file>:<contract>`. */
export function sourceFileOf(fqName: string): string {
  return fqName.slice(0, fqName.lastIndexOf(':'))
}

/** `@scope/pkg@1.2.3` -> `@scope/pkg`. */
export function packageName(pkg: string): string {
  const i = pkg.lastIndexOf('@')
  return i > 0 ? pkg.slice(0, i) : pkg
}

/**
 * Whether a contract's code is another source's, and whose. It is when its file is anywhere inside
 * another source's package or repo:
 * - `pkg`, the installed package it was compiled from (`packageOf`, `<name>@<version>`), is one of
 *   the other source's `npmPackages`. The name is the package's own, so an npm alias counts.
 * - The path names one of those packages, at its start (a Hardhat import name, or a copy at the
 *   top of the repo) or after a `node_modules/` directory (Foundry's names; nested installs).
 * - The file is in a git submodule (nested ones included) that clones the other source's `repo`.
 * The outermost such directory gives the exclude, since excluding it leaves out everything inside.
 */
export function foreignOrigin(contract: string, pkg: string | null, submodules: Submodule[], others: SourceIdentity[]): ForeignCode | null {
  const file = sourceFileOf(contract)
  const found: { dir: string; owner: string; via: string }[] = []
  const ownerOfPackage = (name: string) => others.find(o => o.npmPackages.includes(name))
  if (pkg) {
    const owner = ownerOfPackage(packageName(pkg))
    if (owner) found.push({ dir: packageRootOf(file), owner: owner.id, via: `package ${pkg}` })
  }
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && parts[i - 1] !== 'node_modules') continue
    const n = parts[i].startsWith('@') ? 2 : 1
    if (i + n >= parts.length) continue // a package is a directory
    const name = parts.slice(i, i + n).join('/')
    const owner = ownerOfPackage(name)
    if (owner) found.push({ dir: parts.slice(0, i + n).join('/'), owner: owner.id, via: `package ${pkg && packageName(pkg) === name ? pkg : name}` })
  }
  for (const s of submodules) {
    const owner = s.repo && others.find(o => o.repo.toLowerCase() === s.repo!.toLowerCase())
    if (owner && file.startsWith(`${s.path}/`)) found.push({ dir: s.path, owner: owner.id, via: `git submodule ${s.path} (${s.repo})` })
  }
  if (!found.length) return null
  const outer = found.sort((a, b) => a.dir.length - b.dir.length)[0]
  return { contract, owner: outer.owner, via: outer.via, exclude: `${normalizeSource(outer.dir)}/**` }
}

/** The contracts of a build that are another source's code (see `foreignOrigin`). */
export function foreignCode(contracts: { fqName: string; package: string | null }[], submodules: Submodule[], others: SourceIdentity[]): ForeignCode[] {
  return contracts.flatMap(c => foreignOrigin(c.fqName, c.package, submodules, others) ?? [])
}

/**
 * Why publish refuses a build: `where` (e.g. `tag v1.2.0 (0123456789ab)`) of `source`, built with
 * `profile`, has another source's code. The first line names the first contract, whose code it is
 * and the exclude to add; the rest list every contract and every exclude.
 */
export function foreignCodeRefusal(source: string, where: string, profile: string, found: ForeignCode[]): string {
  const [f] = found
  const excludes = [...new Set(found.map(x => `"${x.exclude}"`))]
  return [
    `${where}: ${f.contract} is ${describeForeign(f)}, and a source never publishes another source's code; nothing published. ` +
      `Add ${excludes.join(', ')} to the exclude list of build profile ${profile} in ${sourcesConfigPath(source)}` +
      (found.length > 1 ? ` (${found.length} contracts, listed below).` : '.'),
    ...found.map(x => `  ${x.contract}: ${describeForeign(x)}; exclude "${x.exclude}"`),
  ].join('\n')
}

/** `code from <owner> (<via>; see config/<owner>/sources.json)`. */
export function describeForeign(f: ForeignCode): string {
  return `code from ${f.owner} (${f.via}; see ${sourcesConfigPath(f.owner)})`
}

/**
 * Why a built commit's own package isn't covered: its package.json `name` must be in its source's
 * `npmPackages`, so other sources' builds that install the package are refused. Null if it is, or
 * if the commit has no package.json or the package.json has no name.
 */
export function unlistedOwnPackage(source: { directory: string; npmPackages?: string[] }, where: string, packageJson: string | null): string | null {
  if (!packageJson) return null
  let name: unknown
  try { name = JSON.parse(packageJson).name } catch { return null }
  if (typeof name !== 'string' || !name || (source.npmPackages ?? []).includes(name)) return null
  return `${where}: package.json names the package ${name}, which npmPackages in ${sourcesConfigPath(source.directory)} doesn't list; nothing published. ` +
    "List it there: another source's build that installs it is then refused instead of publishing its code."
}

/**
 * Every git submodule of a checkout, nested ones included, from its `.gitmodules` files. `repo` is
 * the checkout's own (`owner/name`), against which relative URLs (`../x.git`) resolve. Reads the
 * files, not git's state, so a submodule that setup didn't initialise is still listed.
 */
export function submodulesOf(checkoutDir: string, repo: string | null): Submodule[] {
  const out: Submodule[] = []
  const visit = (dir: string, superRepo: string | null) => {
    const file = path.join(checkoutDir, dir, '.gitmodules')
    if (!fs.existsSync(file)) return
    for (const s of readGitmodules(file)) {
      const p = path.posix.join(dir, s.path).replace(/\/+$/, '')
      const r = githubRepoOf(s.url, superRepo)
      out.push({ path: p, repo: r })
      visit(p, r)
    }
  }
  visit('', repo)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The `path` and `url` of each submodule in a `.gitmodules` file (read by git, which knows its syntax). */
function readGitmodules(file: string): { path: string; url: string }[] {
  let listed: string
  try {
    listed = git(['config', '--file', file, '--null', '--get-regexp', '^submodule\\..*\\.(path|url)$'])
  } catch {
    return [] // no submodule entries
  }
  const byName = new Map<string, { path?: string; url?: string }>()
  // With --null, each setting is `<key>\n<value>\0`, so names and values may hold spaces.
  for (const item of listed.split('\0').filter(Boolean)) {
    const newline = item.indexOf('\n')
    const key = item.slice(0, newline)
    const dot = key.lastIndexOf('.')
    const name = key.slice('submodule.'.length, dot)
    byName.set(name, { ...byName.get(name), [key.slice(dot + 1)]: item.slice(newline + 1) })
  }
  return [...byName.values()].filter((s): s is { path: string; url: string } => !!s.path && !!s.url)
}

/**
 * The GitHub repo (`owner/name`) a git URL names, or null for another host: `https://`, `ssh://`
 * and `git://` URLs, and `git@github.com:owner/name`, with or without `.git`. A relative URL
 * (`../name.git`) is resolved against `superRepo`, the repo whose `.gitmodules` has it.
 */
export function githubRepoOf(url: string, superRepo: string | null): string | null {
  let u = url.trim()
  if (u.startsWith('./') || u.startsWith('../')) {
    if (!superRepo) return null
    u = new URL(u, `https://github.com/${superRepo}/`).href
  }
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/|[^@\s/]+@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u)
  return m ? `${m[1]}/${m[2]}` : null
}
