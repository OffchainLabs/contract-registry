# Sources

A source is an Offchain Labs contract repo that the registry builds. Its settings are in
`config/<source>/sources.json`, and each source has a page here: its range, build profiles, test
chains and out-of-scope getters.

Sources: [`nitro-contracts`](nitro-contracts.md), every tag from `v3.2.0` onward, plus the releases
from `v3.0.0` on (backfilled; see [Backfill](#backfill));
[`token-bridge-contracts`](token-bridge-contracts.md), every tag from `v1.0.1-beta.0`, the first
that reproduces Arbitrum One's and Nova's canonical bridge; and
[`upgrade-executor`](upgrade-executor.md), every tag from `v1.0.0`, its whole release history (see
[Backfill](#backfill)).

## Backfill

Three settings in `config/<source>/sources.json` let the registry cover releases older than its
start tag. Each is a selector over source commits, and the run applies them per tag. Each source's
page gives its values.

**Which tags are published: `start`.** A tag is published when its commit is `start.tag`'s or
descends from it, prereleases included. With `start.releasesFrom`, so is every release tag (a
semver version with no prerelease part) at or above that version, wherever its commit is. Branch
heads must still descend from `start.tag`.

**How each commit is built: `builds[].when`.** The first profile whose `when` matches the commit
builds it. A selector can require `descendantOf`, `notDescendantOf`, `refs`, and `tags`: a
published tag at the commit whose semver version is at least `tags.from` and below
`tags.before`, by semver precedence. A commit that no profile matches fails the run ("no build
profile matches commit"), so a tag is never built with settings meant for other releases.

**Which commits get a test-chain check: `testChains.when`.** A published commit outside it is
built and published without the check, and not silently: the run that publishes it (a new tag, or
a branch head that changed) lists it in `checksSkipped` (commit, refs, reason), logs
`test-chain check skipped for <refs>`, and names it in the data commit's message. Later runs don't
repeat it for an unchanged branch head. `check.ts --rev` refuses such a commit. The check itself is
described in [Test chains](../publishing.md#test-chains).

**Going further back.** Lower `start.releasesFrom`; that one line is the range rule. Then:

1. Make a profile cover the new tags: widen `tags.from` if the toolchain still works, or add a
   profile.
2. Check that `contractRoles` lists every proxy and proxy admin those builds produce, under its
   exact name. Entries are write-once, and the role is copied in when one is written.
3. Check that each new tag equals `v` + `package.json` version, or allowlist it.

The run checks the range invariant against every existing entry of every source, as for any new
tag.
