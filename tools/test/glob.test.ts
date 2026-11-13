import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesAny, refMatches } from '../src/lib/glob.ts'
import { compareTags, isPrerelease } from '../src/lib/semver.ts'

test('source globs', () => {
  assert.ok(matchesAny('src/mocks/BridgeStub.sol', ['src/mocks/**']))
  assert.ok(!matchesAny('src/bridge/Bridge.sol', ['src/mocks/**']))
  assert.ok(matchesAny('@openzeppelin/contracts/proxy/Proxy.sol', ['**']))
})

test('published ref patterns match across slashes', () => {
  assert.ok(refMatches('hotfix/add-sbom-export', ['hotfix*']))
  assert.ok(refMatches('release-3.3.0', ['release-*']))
  assert.ok(!refMatches('feat/mel', ['develop', 'main', 'release-*', 'hotfix*']))
  assert.ok(refMatches('v3.2.0-beta.0', ['v*']))
})

test('tag order and prereleases', () => {
  assert.deepEqual(['v3.10.0', 'v3.2.0', 'v3.2.0-beta.1', 'v3.2.0-beta.0', 'v3.1.0-qol', 'v3.1.0'].sort(compareTags),
    ['v3.1.0-qol', 'v3.1.0', 'v3.2.0-beta.0', 'v3.2.0-beta.1', 'v3.2.0', 'v3.10.0'])
  assert.ok(isPrerelease('v3.2.0-beta.0'))
  assert.ok(!isPrerelease('v3.2.0'))
})
