// The builder's checkouts are worktrees of one bare clone of the source repo, so they share its
// config. `git submodule init` records each submodule's URL there, and keeps a URL already
// recorded: without care, an earlier build's URL would be used for a later commit whose
// .gitmodules says otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Builder } from '../src/lib/build.ts'
import type { SourceConfig } from '../src/lib/config.ts'
import { SourceRepo } from '../src/lib/source.ts'

// Local paths as submodule URLs need protocol.file.allow (git 2.38.1 and later).
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8' }).trim()

test("each build's submodules come from its own commit's .gitmodules, not an earlier build's", { timeout: 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-build-'))
  try {
    const sub = path.join(tmp, 'sub')
    git(tmp, 'init', '-q', sub)
    fs.writeFileSync(path.join(sub, 'README'), 'sub\n')
    git(sub, 'add', '-A'); git(sub, 'commit', '-qm', 'sub')
    // c1's .gitmodules has a URL that doesn't work here (as an old tag's SSH URL may not), c2's one that does.
    const src = path.join(tmp, 'src')
    git(tmp, 'init', '-q', src)
    git(src, 'submodule', 'add', '-q', sub, 'lib/sub')
    git(src, 'commit', '-qm', 'c0')
    const withUrl = (url: string) => {
      git(src, 'config', '-f', '.gitmodules', 'submodule.lib/sub.url', url)
      git(src, 'commit', '-qam', url)
      return git(src, 'rev-parse', 'HEAD')
    }
    const c1 = withUrl(path.join(tmp, 'gone.git'))
    const c2 = withUrl(sub)

    const cfg = {
      schemaVersion: 1, repo: 'Example/fake', url: src, directory: 'fake', start: { tag: 'v1.0.0' },
      publishedRefs: { tags: ['v*'], branches: ['release-*'] }, tagValidation: { rule: 'tag-equals-v-package-version', allowlist: {} },
      outOfScopeGetters: 'config/fake/out-of-scope-getters.json', contractRoles: {}, reviewedRangePairs: [], testChains: null, reconcileGraceMinutes: 0,
      builds: [{
        name: 'submodules', when: {}, toolchain: {}, setup: ['git -c protocol.file.allow=always submodule update --init --recursive'],
        outputs: [{ name: 'none', commands: ['test -f lib/sub/README', 'mkdir -p out/build-info'], buildInfo: 'out/build-info', layout: 'standard-json', deployed: true }],
        include: ['src/**'], exclude: [],
      }],
    } satisfies SourceConfig
    const workDir = path.join(tmp, 'work')
    const repo = new SourceRepo(cfg, workDir)
    repo.sync()
    const builder = new Builder(repo, workDir)

    const r1 = await builder.build(c1, { fresh: true })
    assert.equal(r1.result.ok, false)
    assert.match(r1.result.failure!.message, /submodule update/)
    const r2 = await builder.build(c2, { fresh: true })
    assert.ok(r2.result.ok, `c2 cloned its submodule from c1's URL:\n${r2.result.failure?.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
