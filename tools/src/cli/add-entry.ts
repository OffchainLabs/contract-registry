// Adds a manual entry: one contract from a build you made yourself, of code that no published ref
// builds (a one-off or patched build deployed somewhere). Extracts the contract as publish does and
// writes nothing unless it matches the code deployed at --address, its fingerprint has no entry yet,
// its label isn't a published tag, and entries of one code length still mask the same bytes. Then
// writes the entry and regenerates registry/by-length/ and registry/index.json. Builds nothing;
// commits nothing.
//   node tools/src/cli/add-entry.ts --source <id> --checkout <dir> --build-info <dir> --layout <hardhat|standard-json> [--artifacts <dir>]
//        --contract <file>:<name> --rpc <url> --address <address> [--block latest] --label <label> [--notes <text>]
//        [--ref <tag or branch> --commit <sha>] [--data-repo <dir>]
// --source (e.g. nitro-contracts) has no default: it picks the entry's directory, its repo and the
// contractRoles its role comes from, and entries are write-once.
// --build-info and --artifacts are relative to --checkout, as in sources.json. --ref and --commit
// (default null) are only for a build of a public commit: --ref must point at --commit in the
// source's configured repo URL, and the checkout must be that commit with no changes to tracked files.
// Exit 0: written. 1: refused, nothing written. 2: usage.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { cborMetadataFields, cborMetadataLength } from '../lib/cbor.ts'
import { listSources, loadSourceConfig } from '../lib/config.ts'
import { DataRepo, SourceData, entryFromBuild } from '../lib/datarepo.ts'
import { git, remoteRefCommits } from '../lib/exec.ts'
import { extractContract, loadBuildInfos, packageOf, runtimeCode, selectArtifacts } from '../lib/extract.ts'
import { matches } from '../lib/fingerprint.ts'
import { hexToBytes } from '../lib/hex.ts'
import { INDEX_PATH, byLengthPath } from '../lib/layout.ts'
import { rangeConflictReport, rangeConflicts } from '../lib/ranges.ts'
import { SchemaValidator } from '../lib/schema.ts'
import type { BuiltContract, CompilerInfo, Entry } from '../lib/types.ts'
import { DirSource, Registry, versionOf } from '../walker/registry.ts'
import { Rpc } from '../walker/rpc.ts'

const { values: a } = parseArgs({
  options: {
    'data-repo': { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    source: { type: 'string' },
    checkout: { type: 'string' },
    'build-info': { type: 'string' },
    layout: { type: 'string' },
    artifacts: { type: 'string' },
    contract: { type: 'string' },
    rpc: { type: 'string' },
    address: { type: 'string' },
    block: { type: 'string', default: 'latest' },
    label: { type: 'string' },
    notes: { type: 'string' },
    ref: { type: 'string' },
    commit: { type: 'string' },
  },
})

function usage(problem: string): never {
  console.error(problem)
  console.error('usage: add-entry.ts --source <id> --checkout <dir> --build-info <dir> --layout <hardhat|standard-json> [--artifacts <dir>] --contract <file>:<name>')
  console.error('         --rpc <url> --address <address> [--block latest] --label <label> [--notes <text>] [--ref <ref> --commit <sha>] [--data-repo ...]')
  process.exit(2)
}

function refuse(lines: string | string[]): never {
  for (const l of [lines].flat()) console.error(l)
  console.error('Nothing written.')
  process.exit(1)
}

const root = path.resolve(a['data-repo']!)
const configured = listSources(root)
if (!a.source) usage(`--source is required: the source whose directory, repo and contractRoles the entry gets (configured: ${configured.join(', ')})`)
if (!configured.includes(a.source)) usage(`--source ${a.source} is not a configured source (configured: ${configured.join(', ')})`)
for (const k of ['checkout', 'build-info', 'layout', 'contract', 'rpc', 'address'] as const) if (!a[k]) usage(`--${k} is required`)
const label = a.label?.trim()
if (!label) usage('--label is required: a manual entry has no tag, so its label is the version getVersion reports')
const layout = a.layout as 'hardhat' | 'standard-json'
if (layout !== 'hardhat' && layout !== 'standard-json') usage(`--layout must be hardhat or standard-json, not ${a.layout}`)
if (layout === 'hardhat' && !a.artifacts) usage('--layout hardhat needs --artifacts (the directory of the *.dbg.json files)')
if (!/^0x[0-9a-fA-F]{40}$/.test(a.address!)) usage(`--address ${a.address} is not an address`)
if (!a.ref !== !a.commit) usage('--ref and --commit go together')
if (a.commit && !/^[0-9a-fA-F]{40}$/.test(a.commit)) usage('--commit must be a full 40-digit commit hash')
const checkout = path.resolve(a.checkout!)
const buildInfoDir = path.resolve(checkout, a['build-info']!)
const artifactsDir = a.artifacts ? path.resolve(checkout, a.artifacts) : undefined
for (const d of [checkout, buildInfoDir, artifactsDir]) if (d && !fs.existsSync(d)) usage(`no such directory: ${d}`)
const commit = a.commit?.toLowerCase() ?? null
const block = /^\d+$/.test(a.block!) ? `0x${BigInt(a.block!).toString(16)}` : a.block!

const cfg = loadSourceConfig(root, a.source)
const data = new SourceData(root, cfg.directory, cfg.repo)
if (data.hasTag(label)) refuse(`--label ${label} is a published tag of ${cfg.repo}; getVersion would report it for code that tag doesn't contain. Choose another label.`)

// --- The contract, extracted as publish extracts it ---------------------------------------------
const refs = selectArtifacts(loadBuildInfos(buildInfoDir), layout, artifactsDir)
const ref = refs.find(r => r.fqName === a.contract)
if (!ref) {
  const name = a.contract!.split(':').at(-1)
  const same = refs.filter(r => r.name === name).map(r => r.fqName)
  refuse(`${a.contract} is not in the build output (${refs.length} contracts)${same.length ? `; contracts named ${name}: ${same.join(', ')}` : ''}`)
}
const extracted = extractContract(ref)
if (!extracted) refuse(`${a.contract} has no code to fingerprint: an interface, an abstract contract, or a library with no external functions`)
const built: BuiltContract = { ...extracted, package: packageOf(checkout, ref.source) }
if (data.hasEntry(built.fingerprint)) {
  const existing = (await new Registry(new DirSource(root)).byLength(built.codeLength)).find(e => e.fingerprint === built.fingerprint)
  refuse(`${built.fingerprint} already has an entry, ${data.entryPath(built.fingerprint)}${existing ? `, which reports ${versionOf(existing)}` : ''}. Entries are write-once.`)
}
if (a.ref) {
  const problem = publicCommitProblem(cfg.url, checkout, a.ref, commit!)
  if (problem) refuse(problem)
}

// --- It must match the deployed code ---------------------------------------------------------
const rpc = new Rpc(a.rpc!)
const deployed = hexToBytes(await rpc.getCode(a.address!, block))
if (!matches(deployed, built)) {
  refuse([`The build of ${a.contract} doesn't match the code at ${a.address} (block ${a.block}).`, ...explainMismatch(deployed, runtimeCode(ref), built)])
}

// --- The entry, checked like publish checks its entries -------------------------------------
const entry = entryFromBuild(cfg.repo, [built], { ref: a.ref ?? null, commit, label, notes: a.notes?.trim() || undefined }, cfg.contractRoles)
const schemaErrors = new SchemaValidator(root).validate('entry', entry)
if (schemaErrors.length) refuse(['The entry fails the schema:', ...schemaErrors.map(e => `  ${e}`)])
const others = data.entries()
const conflicts = rangeConflicts([...others, entry], cfg.reviewedRangePairs)
if (conflicts.length) refuse(['The entry would break the range invariant (see "Publishing" in the README):', ...rangeConflictReport(cfg.directory, conflicts).split('\n')])

data.writeEntry(entry)
DataRepo.open(root).writeViews()

// --- What the registry now says --------------------------------------------------------------
const registry = new Registry(new DirSource(root))
const found = await registry.lookup(deployed)
if (found?.fingerprint !== entry.fingerprint) throw new Error(`the deployed code looks up as ${found?.fingerprint ?? 'nothing'}, not the new entry ${entry.fingerprint}`)
const version = await registry.getVersion(rpc, a.address!, block)
const out = [
  `Wrote ${data.entryPath(entry.fingerprint)}`,
  `  and regenerated ${byLengthPath(entry.codeLength)} and ${INDEX_PATH}.`,
  `fingerprint: ${entry.fingerprint}`,
  `contract:    ${entry.contracts[0]} (${entry.role}${entry.packages ? `, ${Object.values(entry.packages)[0]}` : ''})`,
  `getVersion(${a.address}) at ${a.block}: ${version ?? 'null'}`,
]
if (entry.role === 'proxy' && entry.implementationSlots?.length === 1) out.push(`  (a one-slot proxy reports its implementation's version; the entry itself gives ${versionOf(found)})`)
const novel = namesNoOtherEntryHas(entry, others)
if (novel.length) {
  out.push('', 'These names come from the source, and no other entry has them. If the build is from a private repo, check that each is public:')
  for (const n of novel) out.push(`  ${n}`)
}
out.push(
  '', 'Next:',
  '  1. node tools/src/cli/ci-check.ts --base origin/main',
  '  2. Check the diff. If the build is from a private repo, grep the diff and your commit message for anything that identifies it.',
  '  3. Commit on a branch, push it and open a PR.',
)
console.log(out.join('\n'))

/**
 * Why `ref` and `commit` can't be recorded, or null if they can. `ref` must point at `commit` in
 * the source's configured (public) repo, so neither can name anything private; and the checkout
 * must be that commit with no changes to tracked files, so it is what was built.
 */
function publicCommitProblem(url: string, checkout: string, ref: string, commit: string): string | null {
  let remote: { branch?: string; tag?: string }
  try { remote = remoteRefCommits(url, ref) } catch (e) { return `can't list the refs of ${url}: ${(e as Error).message.split('\n')[0]}` }
  const points = [remote.branch, remote.tag].filter(x => x !== undefined)
  if (!points.length) return `--ref ${ref} is not a branch or tag of ${url}`
  if (!points.includes(commit)) return `--ref ${ref} points at ${points.join(' and ')} in ${url}, not --commit ${commit}`
  const head = git(['rev-parse', 'HEAD'], checkout).trim()
  if (head !== commit) return `the checkout is at ${head}, not --commit ${commit}`
  if (git(['status', '--porcelain', '--untracked-files=no'], checkout).trim()) {
    return `the checkout has changes to tracked files, so the build isn't ${commit} as published. For a patched build, leave out --ref and --commit.`
  }
  return null
}

/** Why deployed code doesn't match a build: lengths, metadata trailers, and where the code before the trailers differs. */
function explainMismatch(deployed: Uint8Array, build: Uint8Array, c: BuiltContract): string[] {
  if (!deployed.length) return ['  There is no code at that address: check the address, the chain the RPC serves, and the block.']
  const [dFields, bFields] = [cborMetadataFields(deployed), cborMetadataFields(build)]
  const trailer = (len: number, fields: Record<string, string>) => {
    if (!len) return 'none'
    return `${len} bytes (${Object.entries(fields).map(([k, v]) => (k === 'solc' ? `solc ${v}` : k)).join(', ')})`
  }
  const deployedTrailer = cborMetadataLength(deployed)
  const dBody = deployed.slice(0, deployed.length - deployedTrailer)
  const bBody = build.slice(0, build.length - c.cborMetadataLength)
  const lines = [
    `  length:             deployed ${deployed.length} bytes, build ${build.length}`,
    `  metadata trailer:   deployed ${trailer(deployedTrailer, dFields)}, build ${trailer(c.cborMetadataLength, bFields)}`,
  ]
  if (dFields.solc && bFields.solc && dFields.solc !== bFields.solc) lines.push(`  compiler:           the deployed code was compiled with solc ${dFields.solc}, the build with ${bFields.solc}`)
  const differs = 'so the source or compiler settings differ'
  if (dBody.length !== bBody.length) {
    lines.push(`  before the trailer: deployed ${dBody.length} bytes, build ${bBody.length}, ${differs}`)
  } else {
    const masked = new Set(c.maskedRanges.flatMap(r => r.offsets.flatMap(o => Array.from({ length: r.length }, (_, i) => o + i))))
    const diffs = [...dBody.keys()].filter(i => !masked.has(i) && dBody[i] !== bBody[i])
    const hex = (b: number) => `0x${b.toString(16).padStart(2, '0')}`
    if (diffs.length) {
      lines.push(`  before the trailer: ${diffs.length} of ${dBody.length} bytes differ outside the masked ranges, first at offset ${diffs[0]} (deployed ${hex(dBody[diffs[0]])}, build ${hex(bBody[diffs[0]])}), ${differs}`)
    } else {
      lines.push(`  before the trailer: the same ${dBody.length} bytes outside the masked ranges. Only the trailer differs: rebuild with the metadata settings the deployment used (bytecodeHash, appendCBOR).`)
    }
  }
  lines.push(`  build settings:     ${describeCompiler(c.compiler)}`)
  return lines
}

function describeCompiler(c: CompilerInfo): string {
  return [
    `${c.language} ${c.version}`,
    `optimizer ${c.optimizer.enabled ? `${c.optimizer.runs} runs` : 'off'}`,
    `evmVersion ${c.evmVersion ?? 'default'}`,
    `viaIR ${c.viaIR}`,
    `bytecodeHash ${c.metadata.bytecodeHash ?? 'default (ipfs)'}`,
    `appendCBOR ${c.metadata.appendCBOR}`,
  ].join(', ')
}

/**
 * The names in an entry that come from the source code (contracts, getters, masked ranges) and
 * that no other entry has. A private build can bring names that only exist in its repo.
 */
function namesNoOtherEntryHas(e: Entry, others: Entry[]): string[] {
  const known = new Set(others.flatMap(o => [...o.contracts.map(c => `contract ${c}`), ...o.getters.map(g => `getter ${g.signature}`), ...o.maskedRanges.map(r => `masked range ${r.name}`)]))
  return [...e.contracts.map(c => `contract ${c}`), ...e.getters.map(g => `getter ${g.signature}`), ...e.maskedRanges.map(r => `masked range ${r.name}`)].filter(n => !known.has(n))
}
