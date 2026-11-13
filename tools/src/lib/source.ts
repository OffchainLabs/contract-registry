import * as fs from 'node:fs'
import * as path from 'node:path'
import { git, gitOk } from './exec.ts'
import { refMatches } from './glob.ts'
import type { SourceConfig } from './config.ts'

/** A bare clone of a public source repo, read anonymously. */
export class SourceRepo {
  readonly cfg: SourceConfig
  readonly gitDir: string

  constructor(cfg: SourceConfig, workDir: string) {
    this.cfg = cfg
    this.gitDir = path.join(workDir, 'sources', `${cfg.directory}.git`)
  }

  sync(log: (s: string) => void = () => {}): void {
    if (!fs.existsSync(this.gitDir)) {
      log(`cloning ${this.cfg.url}`)
      fs.mkdirSync(path.dirname(this.gitDir), { recursive: true })
      git(['clone', '--bare', '--quiet', this.cfg.url, this.gitDir])
    }
    git(['fetch', '--quiet', '--prune', '--prune-tags', '--force', this.cfg.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], this.gitDir)
  }

  git(args: string[]): string {
    return git(args, this.gitDir)
  }

  /** Published branches and their head commits, sorted by the config's pattern order, then name. */
  publishedBranches(): Map<string, string> {
    const out = this.git(['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads']).trim()
    const all = out ? out.split('\n').map(l => l.split(' ') as [string, string]) : []
    const pats = this.cfg.publishedRefs.branches
    const rank = (b: string) => pats.findIndex(p => refMatches(b, [p]))
    return new Map(all.filter(([b]) => rank(b) >= 0).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])))
  }

  /** Published tags and the commits they point at. */
  publishedTags(): Map<string, string> {
    const out = this.git(['for-each-ref', '--format=%(refname:strip=2) %(objectname) %(*objectname)', 'refs/tags']).trim()
    const m = new Map<string, string>()
    for (const l of out ? out.split('\n') : []) {
      const [name, obj, peeled] = l.split(' ')
      if (refMatches(name, this.cfg.publishedRefs.tags)) m.set(name, peeled || obj)
    }
    return new Map([...m].sort((a, b) => a[0].localeCompare(b[0])))
  }

  resolve(ref: string): string {
    return this.git(['rev-parse', '--verify', `${ref}^{commit}`]).trim()
  }

  exists(commit: string): boolean {
    return gitOk(['cat-file', '-e', `${commit}^{commit}`], this.gitDir)
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return gitOk(['merge-base', '--is-ancestor', ancestor, descendant], this.gitDir)
  }

  fileAt(commit: string, file: string): string | null {
    try { return this.git(['show', `${commit}:${file}`]) } catch { return null }
  }

  /** Committer time of a commit, or tagger time of an annotated tag, in ms. */
  refTime(ref: string): number {
    const s = this.git(['for-each-ref', '--format=%(taggerdate:unix) %(committerdate:unix) %(*committerdate:unix)', ref]).trim()
    const n = s.split(' ').map(Number).find(x => x > 0)
    if (n) return n * 1000
    return Number(this.git(['log', '-1', '--format=%ct', ref]).trim()) * 1000
  }
}
