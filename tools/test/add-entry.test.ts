// The `add-entry` CLI end to end: a data repo on disk (this repo's config and schemas), a build
// output written by hand in Hardhat or standard-JSON layout (no compiler), and a stub JSON-RPC server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { DataRepo, SourceData } from '../src/lib/datarepo.ts'
import { fingerprintOf } from '../src/lib/fingerprint.ts'
import { hexToBytes } from '../src/lib/hex.ts'
import type { ByLengthFile, Entry, IndexFile } from '../src/lib/types.ts'
import { EIP1967_IMPLEMENTATION_SLOT as EIP1967 } from '../src/walker/walk.ts'
import { toFunctionSelector } from 'viem'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLI = path.join(ROOT, 'tools/src/cli/add-entry.ts')
const CBOR_NONE = 'a164736f6c6343000811000a' // {"solc": 0.8.17}: bytecodeHash none, 12 bytes
const CBOR_IPFS = `a264697066735822${'12'.repeat(34)}64736f6c63430008110033` // {"ipfs": <34 bytes>, "solc": 0.8.17}: 53 bytes

// Bridge: PUSH32 <__self> JUMPDEST, filler, metadata: 66 bytes, one immutable at offset 1.
const bridgeCode = (self: string, filler = 'fe'.repeat(20), cbor = CBOR_NONE) => `60${self.padStart(64, '0')}5b${filler}${cbor}`
const BRIDGE = 'src/bridge/Bridge.sol:Bridge'
const TUP = '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy'
const TUP_CODE = `6080${'fd'.repeat(30)}${CBOR_NONE}`
const BRIDGE_SPEC = { codeLength: 66, maskedRanges: [{ name: '__self', type: 'address', offsets: [1], length: 32 }], cborMetadataLength: 12 }
const BRIDGE_FP = fingerprintOf(hexToBytes(bridgeCode('0')), BRIDGE_SPEC)

const A = {
  bridge: '0x' + 'b'.repeat(40), tup: '0x' + 'c'.repeat(40), none: '0x' + 'd'.repeat(40),
  ipfs: '0x' + 'e'.repeat(40), oneByte: '0x' + 'f'.repeat(40), solc: '0x' + 'a'.repeat(40),
}
const SELF = 'b'.repeat(40)
const CODE: Record<string, string> = {
  [A.bridge]: bridgeCode(SELF),
  [A.tup]: TUP_CODE,
  [A.ipfs]: bridgeCode(SELF, 'fe'.repeat(20), CBOR_IPFS),
  [A.oneByte]: bridgeCode(SELF, 'fd' + 'fe'.repeat(19)),
  [A.solc]: bridgeCode(SELF, 'fe'.repeat(21), 'a164736f6c6343000809000a'), // solc 0.8.9, one byte longer
}

/** A checkout with Bridge's source, an installed OpenZeppelin package, and build output for both. */
function writeCheckout(dir: string): void {
  const write = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s) }
  if (!fs.existsSync(path.join(dir, 'src/bridge/Bridge.sol'))) write('src/bridge/Bridge.sol', '')
  write('node_modules/@openzeppelin/contracts/package.json', JSON.stringify({ name: '@openzeppelin/contracts', version: '4.7.3' }))
  const contracts = [
    { fqName: BRIDGE, code: bridgeCode('0'), immutable: '__self', getters: ['rollup'] },
    { fqName: TUP, code: TUP_CODE },
  ]
  const output: any = { contracts: {}, sources: {} }
  let id = 1
  for (const c of contracts) {
    const [source, name] = c.fqName.split(':')
    const [unitId, contractId, immutableId] = [id++, id++, id++]
    const abi = (c.getters ?? []).map(g => ({ type: 'function', name: g, inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }))
    const immutableReferences = c.immutable ? { [immutableId]: [{ start: 1, length: 32 }] } : {}
    output.contracts[source] = { [name]: { abi, evm: { deployedBytecode: { object: c.code, immutableReferences, linkReferences: {} } } } }
    const vars = c.immutable ? [{ nodeType: 'VariableDeclaration', id: immutableId, name: c.immutable, scope: contractId, typeDescriptions: { typeString: 'address' } }] : []
    output.sources[source] = { id: unitId, ast: { nodeType: 'SourceUnit', id: unitId, nodes: [{ nodeType: 'ContractDefinition', id: contractId, name, contractKind: 'contract', nodes: vars }] } }
    // Hardhat's artifact and its .dbg.json, which names the build-info.
    const art = `build/contracts/${source}/${name}`
    write(`${art}.json`, JSON.stringify({ sourceName: source, contractName: name }))
    write(`${art}.dbg.json`, JSON.stringify({ buildInfo: path.relative(path.dirname(path.join(dir, art)), path.join(dir, 'build/contracts/build-info/b1.json')) }))
  }
  write('build/contracts/build-info/b1.json', JSON.stringify({
    solcLongVersion: '0.8.17+commit.8df45f5f',
    input: { language: 'Solidity', settings: { optimizer: { enabled: true, runs: 2000 }, evmVersion: 'london', metadata: { bytecodeHash: 'none' } }, sources: {} },
    output,
  }))
}

async function stubRpc(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body)
      const result = method === 'eth_getCode' ? `0x${CODE[params[0].toLowerCase()] ?? ''}` : '0x' + '0'.repeat(64)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim()

interface Run { status: number | null; stdout: string; stderr: string }

/** A data repo with this repo's config and schemas, committed; a checkout with build output; a stub RPC. */
async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-add-entry-'))
  const dir = path.join(tmp, 'data')
  const checkout = path.join(tmp, 'checkout')
  for (const d of ['config', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true })
  git(tmp, 'init', '-q', dir)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'config')
  writeCheckout(checkout)
  const rpc = await stubRpc()
  const data = new SourceData(dir, 'nitro-contracts', 'OffchainLabs/nitro-contracts')
  const hardhat = ['--checkout', checkout, '--build-info', 'build/contracts/build-info', '--layout', 'hardhat', '--artifacts', 'build/contracts']
  return {
    dir, checkout, data, hardhat,
    standardJson: ['--checkout', checkout, '--build-info', 'build/contracts/build-info', '--layout', 'standard-json'],
    run: (args: string[], { withSource = true } = {}): Promise<Run> => new Promise(resolve => {
      const p = spawn(process.execPath, [CLI, '--data-repo', dir, '--rpc', rpc.url, ...(withSource ? ['--source', 'nitro-contracts'] : []), ...args])
      let stdout = '', stderr = ''
      p.stdout.on('data', d => { stdout += d })
      p.stderr.on('data', d => { stderr += d })
      p.on('close', status => resolve({ status, stdout, stderr }))
    }),
    bridge: (address: string, ...more: string[]) => [...hardhat, '--contract', BRIDGE, '--address', address, ...more],
    commit: (m: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', m) },
    /** Uncommitted changes in the data repo. */
    changes: () => git(dir, 'status', '--porcelain'),
    close: () => { rpc.close(); fs.rmSync(tmp, { recursive: true, force: true }) },
  }
}

test('add-entry: a matching build writes the entry and the views, which pass ci-check; an existing fingerprint is refused', async () => {
  const t = await setup()
  try {
    const r = await t.run(t.bridge(A.bridge, '--label', 'v3.1.0-patched', '--notes', 'a patched build'))
    assert.equal(r.status, 0, r.stderr)
    const e: Entry = t.data.readEntry(BRIDGE_FP)
    assert.deepEqual(
      { contracts: e.contracts, role: e.role, ref: e.ref, commit: e.commit, label: e.label, notes: e.notes, packages: e.packages },
      { contracts: [BRIDGE], role: 'logic', ref: null, commit: null, label: 'v3.1.0-patched', notes: 'a patched build', packages: undefined },
    )
    assert.deepEqual({ codeLength: e.codeLength, maskedRanges: e.maskedRanges, cborMetadataLength: e.cborMetadataLength }, BRIDGE_SPEC)
    assert.deepEqual(e.getters.map(g => g.signature), ['rollup()'])
    const shard: ByLengthFile = JSON.parse(fs.readFileSync(path.join(t.dir, 'registry/by-length/66.json'), 'utf8'))
    assert.deepEqual(shard.entries.map(x => [x.fingerprint, x.tags]), [[BRIDGE_FP, []]])
    const index: IndexFile = JSON.parse(fs.readFileSync(path.join(t.dir, 'registry/index.json'), 'utf8'))
    assert.deepEqual(index.codeLengths, [66])
    assert.ok(t.data.entryPath(BRIDGE_FP).endsWith(`/registry/nitro-contracts/entries/${BRIDGE_FP}.json`))
    for (const line of [`Wrote ${t.data.entryPath(BRIDGE_FP)}`, '  and regenerated registry/by-length/66.json and registry/index.json.', `fingerprint: ${BRIDGE_FP}`, `getVersion(${A.bridge}) at latest: v3.1.0-patched OffchainLabs/nitro-contracts`, '  contract src/bridge/Bridge.sol:Bridge', '  getter rollup()', '  masked range __self', '  1. node tools/src/cli/ci-check.ts --base origin/main']) {
      assert.ok(r.stdout.includes(line), `${line}\n---\n${r.stdout}`)
    }

    // From a package: the role comes from contractRoles and the package from the checkout.
    const p = await t.run([...t.standardJson, '--contract', TUP, '--address', A.tup, '--label', 'a proxy one-off', '--block', '21000000'])
    assert.equal(p.status, 0, p.stderr)
    const tup = t.data.entries().find(x => x.contracts[0] === TUP)!
    assert.deepEqual({ role: tup.role, implementationSlots: tup.implementationSlots, packages: tup.packages }, { role: 'proxy', implementationSlots: [EIP1967], packages: { [TUP]: '@openzeppelin/contracts@4.7.3' } })
    assert.match(p.stdout, /getVersion\(0xc{40}\) at 21000000: null\n {2}\(a one-slot proxy reports its implementation's version; the entry itself gives a proxy one-off\)/)
    assert.ok(p.stdout.includes(`no other entry has them. If the build is from a private repo, check that each is public:\n  contract ${TUP}\n\nNext:`), p.stdout)

    t.commit('two manual entries')
    const ci = spawnSync(process.execPath, [path.join(ROOT, 'tools/src/cli/ci-check.ts'), '--data-repo', t.dir, '--base', 'HEAD~1'], { encoding: 'utf8' })
    assert.equal(ci.status, 0, ci.stderr)

    // Entries are write-once.
    const again = await t.run(t.bridge(A.bridge, '--label', 'another label'))
    assert.equal(again.status, 1)
    assert.ok(again.stderr.includes(`${BRIDGE_FP} already has an entry in nitro-contracts, ${t.data.entryPath(BRIDGE_FP)}, which reports v3.1.0-patched of OffchainLabs/nitro-contracts. Entries are write-once.`), again.stderr)
    assert.equal(t.changes(), '')
  } finally {
    t.close()
  }
})

test('add-entry: a build that does not match the deployed code writes nothing, and says where they differ', async () => {
  const t = await setup()
  try {
    const ipfs = await t.run(t.bridge(A.ipfs, '--label', 'x'))
    assert.equal(ipfs.status, 1)
    for (const line of [
      `The build of ${BRIDGE} doesn't match the code at ${A.ipfs} (block latest).`,
      '  length:             deployed 107 bytes, build 66',
      '  metadata trailer:   deployed 53 bytes (ipfs, solc 0.8.17), build 12 bytes (solc 0.8.17)',
      '  before the trailer: the same 54 bytes outside the masked ranges. Only the trailer differs: rebuild with the metadata settings the deployment used (bytecodeHash, appendCBOR).',
      '  build settings:     Solidity 0.8.17+commit.8df45f5f, optimizer 2000 runs, evmVersion london, viaIR false, bytecodeHash none, appendCBOR true',
      'Nothing written.',
    ]) assert.ok(ipfs.stderr.includes(line), `${line}\n---\n${ipfs.stderr}`)

    const oneByte = await t.run(t.bridge(A.oneByte, '--label', 'x'))
    assert.equal(oneByte.status, 1)
    assert.ok(oneByte.stderr.includes('  before the trailer: 1 of 54 bytes differ outside the masked ranges, first at offset 34 (deployed 0xfd, build 0xfe), so the source or compiler settings differ'), oneByte.stderr)

    const solc = await t.run(t.bridge(A.solc, '--label', 'x'))
    assert.equal(solc.status, 1)
    for (const line of [
      '  metadata trailer:   deployed 12 bytes (solc 0.8.9), build 12 bytes (solc 0.8.17)',
      '  compiler:           the deployed code was compiled with solc 0.8.9, the build with 0.8.17',
      '  before the trailer: deployed 55 bytes, build 54, so the source or compiler settings differ',
    ]) assert.ok(solc.stderr.includes(line), `${line}\n---\n${solc.stderr}`)

    const none = await t.run(t.bridge(A.none, '--label', 'x'))
    assert.equal(none.status, 1)
    assert.match(none.stderr, /There is no code at that address/)

    assert.equal(t.changes(), '')
    assert.ok(!fs.existsSync(path.join(t.dir, 'registry')))
  } finally {
    t.close()
  }
})

test('add-entry: refuses without a source or a label, with a label that is a published tag, and on a range conflict until the pair is reviewed', async () => {
  const t = await setup()
  try {
    // --source has no default: it picks where the write-once entry goes, its repo and its role.
    const noSource = await t.run(t.bridge(A.bridge, '--label', 'x'), { withSource: false })
    assert.equal(noSource.status, 2)
    // The data repo copies this repo's config/, so every configured source is listed.
    assert.match(noSource.stderr, /--source is required: the source whose directory, repo and contractRoles the entry gets \(configured: nitro-contracts(, [a-z0-9-]+)*\)/)
    const unknown = await t.run([...t.bridge(A.bridge, '--label', 'x'), '--source', 'nitro'], { withSource: false })
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /--source nitro is not a configured source/)
    for (const label of [[], ['--label', '  ']]) {
      const r = await t.run(t.bridge(A.bridge, ...label))
      assert.equal(r.status, 2)
      assert.match(r.stderr, /--label is required/)
    }
    assert.equal((await t.run(t.bridge(A.bridge, '--label', 'x', '--ref', 'v1.0.0'))).status, 2, '--ref needs --commit')

    // An entry of the same length that masks different bytes (only the metadata).
    const other: Entry = {
      schemaVersion: 1, fingerprint: `0x${'1'.repeat(64)}`, repo: 'OffchainLabs/nitro-contracts', contracts: ['src/bridge/Inbox.sol:Inbox'], role: 'logic',
      codeLength: 66, maskedRanges: [], cborMetadataLength: 12, getters: [], selectors: [], compiler: null, ref: 'v3.1.0', commit: '1'.repeat(40),
    }
    t.data.writeEntry(other)
    t.data.writeTag({ schemaVersion: 1, repo: 'OffchainLabs/nitro-contracts', tag: 'v3.1.0', commit: '1'.repeat(40), prerelease: false, packageVersion: '3.1.0', contracts: { 'src/bridge/Inbox.sol:Inbox': other.fingerprint } })
    DataRepo.open(t.dir).writeViews()
    t.commit('an entry and a tag')

    const tag = await t.run(t.bridge(A.bridge, '--label', 'v3.1.0'))
    assert.equal(tag.status, 1)
    assert.match(tag.stderr, /--label v3\.1\.0 is a published tag of OffchainLabs\/nitro-contracts/)

    const conflict = await t.run(t.bridge(A.bridge, '--label', 'x'))
    assert.equal(conflict.status, 1)
    const named = { [other.fingerprint]: 'src/bridge/Inbox.sol:Inbox', [BRIDGE_FP]: BRIDGE }
    const [x, y] = Object.keys(named).sort()
    for (const line of [
      'The entry would break the range invariant (see "Across sources" in docs/publishing.md):',
      `- 66-byte entries ${x} in nitro-contracts (${named[x]}) and ${y} in nitro-contracts (${named[y]})`,
      `    masked only by ${BRIDGE_FP}: bytes 1-32 (__self)`,
      'Nothing written.',
    ]) assert.ok(conflict.stderr.includes(line), `${line}\n---\n${conflict.stderr}`)
    assert.match(conflict.stderr, /reviewedRangePairs/)
    assert.equal(t.changes(), '')

    // Once the pair is reviewed and listed, the entry is written.
    const cfgFile = path.join(t.dir, 'config/nitro-contracts/sources.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.reviewedRangePairs = [{ fingerprints: [other.fingerprint, BRIDGE_FP], note: 'they differ at byte 34' }]
    fs.writeFileSync(cfgFile, JSON.stringify(cfg))
    const ok = await t.run(t.bridge(A.bridge, '--label', 'x'))
    assert.equal(ok.status, 0, ok.stderr)
    assert.ok(t.data.hasEntry(BRIDGE_FP))
  } finally {
    t.close()
  }
})

test("add-entry: refuses a proxy that forwards to one implementation through a slot getVersion doesn't read", async () => {
  const t = await setup()
  try {
    const other = `0x${'ab'.repeat(32)}`
    const cfgFile = path.join(t.dir, 'config/nitro-contracts/sources.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.contractRoles[TUP] = { role: 'proxy', implementationSlots: [other] }
    fs.writeFileSync(cfgFile, JSON.stringify(cfg))
    t.commit('a non-standard slot')
    const r = await t.run([...t.standardJson, '--contract', TUP, '--address', A.tup, '--label', 'a proxy one-off'])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes(`${TUP} is a proxy that forwards to one implementation, but its implementation slot is ${other}, not EIP-1967's ${EIP1967}.`), r.stderr)
    assert.match(r.stderr, /Nothing written\./)
    assert.equal(t.changes(), '')
  } finally {
    t.close()
  }
})

test('add-entry: --ref and --commit are recorded only if the ref points at that commit in the source repo and the checkout is that commit, unchanged', async () => {
  const t = await setup()
  try {
    // The checkout is a clone of the "public" source repo, whose URL the config names.
    const pub = path.join(path.dirname(t.dir), 'public')
    git(path.dirname(pub), 'init', '-q', pub)
    fs.mkdirSync(path.join(pub, 'src/bridge'), { recursive: true })
    fs.writeFileSync(path.join(pub, 'src/bridge/Bridge.sol'), 'contract Bridge {}\n')
    git(pub, 'add', '-A'); git(pub, 'commit', '-qm', 'one')
    git(pub, 'tag', '-a', 'v9.0.0', '-m', 'an annotated tag')
    const head = git(pub, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(pub, 'src/bridge/Bridge.sol'), 'contract Bridge { }\n')
    git(pub, 'commit', '-qam', 'two')
    const next = git(pub, 'rev-parse', 'HEAD')
    fs.rmSync(t.checkout, { recursive: true })
    git(path.dirname(pub), 'clone', '-q', pub, t.checkout)
    git(t.checkout, 'checkout', '-q', head)
    writeCheckout(t.checkout) // untracked build output
    const cfgFile = path.join(t.dir, 'config/nitro-contracts/sources.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), url: pub }))
    t.commit('a local source repo')

    const refuse = async (ref: string, commit: string, why: string) => {
      const r = await t.run(t.bridge(A.bridge, '--label', 'x', '--ref', ref, '--commit', commit))
      assert.equal(r.status, 1, r.stdout)
      assert.ok(r.stderr.includes(why), `${why}\n---\n${r.stderr}`)
    }
    await refuse('v9.0.0', next, `--ref v9.0.0 points at ${head} in ${pub}, not --commit ${next}`)
    await refuse('no-such-ref', head, `--ref no-such-ref is not a branch or tag of ${pub}`)
    await refuse('main', next, `the checkout is at ${head}, not --commit ${next}`)
    fs.writeFileSync(path.join(t.checkout, 'src/bridge/Bridge.sol'), 'contract Bridge { patched }\n')
    await refuse('v9.0.0', head, "the checkout has changes to tracked files, so the build isn't")
    git(t.checkout, 'checkout', '-q', '--', '.')
    assert.equal(t.changes(), '')

    const ok = await t.run(t.bridge(A.bridge, '--label', 'x', '--ref', 'v9.0.0', '--commit', head.toUpperCase()))
    assert.equal(ok.status, 0, ok.stderr)
    const e = t.data.readEntry(BRIDGE_FP)
    assert.deepEqual([e.ref, e.commit, e.label], ['v9.0.0', head, 'x'])
    assert.match(ok.stdout, /getVersion\(0xb{40}\) at latest: x OffchainLabs\/nitro-contracts\n/, 'the label still gives the version')
  } finally {
    t.close()
  }
})

test('add-entry: looks across every source: code another source owns is refused, and the range check and the names list cover every source', async () => {
  const t = await setup()
  try {
    // A second source, `other`, whose tag v1.0.0 built the Bridge's code.
    const cfg = JSON.parse(fs.readFileSync(path.join(t.dir, 'config/nitro-contracts/sources.json'), 'utf8'))
    fs.mkdirSync(path.join(t.dir, 'config/other'))
    const otherCfg = path.join(t.dir, 'config/other/sources.json')
    fs.writeFileSync(otherCfg, JSON.stringify({ ...cfg, directory: 'other', repo: 'Example/other', url: 'https://github.com/Example/other.git', npmPackages: [], reviewedRangePairs: [] }))
    const other = new SourceData(t.dir, 'other', 'Example/other')
    const owned: Entry = {
      schemaVersion: 1, fingerprint: BRIDGE_FP, repo: 'Example/other', contracts: ['contracts/Copy.sol:Bridge'], role: 'logic',
      ...BRIDGE_SPEC, getters: [], selectors: [], compiler: null, ref: 'v1.0.0', commit: '2'.repeat(40),
    }
    other.writeEntry(owned)
    other.writeTag({ schemaVersion: 1, repo: 'Example/other', tag: 'v1.0.0', commit: '2'.repeat(40), prerelease: false, packageVersion: '1.0.0', contracts: { 'contracts/Copy.sol:Bridge': BRIDGE_FP } })
    DataRepo.open(t.dir).writeViews()
    t.commit('another source owns the Bridge code')

    const owner = await t.run(t.bridge(A.bridge, '--label', 'x'))
    assert.equal(owner.status, 1)
    assert.ok(owner.stderr.includes(`${BRIDGE_FP} already has an entry in other, ${other.entryPath(BRIDGE_FP)}, which reports v1.0.0 of Example/other. Entries are write-once.`), owner.stderr)
    assert.equal(t.changes(), '')

    // Instead, `other` has an entry of the same length that masks different bytes, with a getter
    // named like the Bridge's.
    fs.rmSync(other.entryPath(BRIDGE_FP)); fs.rmSync(other.tagPath('v1.0.0'))
    const conflicting: Entry = {
      ...owned, fingerprint: `0x${'1'.repeat(64)}`, contracts: ['contracts/Inbox.sol:Inbox'], maskedRanges: [],
      getters: [{ signature: 'rollup()', selector: toFunctionSelector('rollup()'), kind: 'single' }],
    }
    other.writeEntry(conflicting)
    DataRepo.open(t.dir).writeViews()
    t.commit('another source has a 66-byte entry')
    const conflict = await t.run(t.bridge(A.bridge, '--label', 'x'))
    assert.equal(conflict.status, 1)
    const named = { [conflicting.fingerprint]: 'other (contracts/Inbox.sol:Inbox)', [BRIDGE_FP]: `nitro-contracts (${BRIDGE})` }
    const [x, y] = Object.keys(named).sort()
    for (const line of [
      'The entry would break the range invariant (see "Across sources" in docs/publishing.md):',
      `- 66-byte entries ${x} in ${named[x]} and ${y} in ${named[y]}`,
      '    once reviewed, add to reviewedRangePairs in config/nitro-contracts/sources.json or config/other/sources.json: ',
      'Nothing written.',
    ]) assert.ok(conflict.stderr.includes(line), `${line}\n---\n${conflict.stderr}`)
    assert.equal(t.changes(), '')

    // Reviewed in the other source's config: the entry is written. Of its names, only the getter
    // is on another entry, and that entry is in the other source.
    fs.writeFileSync(otherCfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(otherCfg, 'utf8')), reviewedRangePairs: [{ fingerprints: [conflicting.fingerprint, BRIDGE_FP], note: 'they differ at byte 34' }] }))
    const ok = await t.run(t.bridge(A.bridge, '--label', 'x'))
    assert.equal(ok.status, 0, ok.stderr)
    assert.ok(t.data.hasEntry(BRIDGE_FP))
    assert.ok(ok.stdout.includes(`no other entry has them. If the build is from a private repo, check that each is public:\n  contract ${BRIDGE}\n  masked range __self\n\nNext:`), ok.stdout)
  } finally {
    t.close()
  }
})

test("add-entry: refuses another source's code, from its package or a submodule of its repo, and names the source it goes in", async () => {
  const t = await setup()
  try {
    // A source `oz` whose npm package is the checkout's OpenZeppelin: the proxy compiled from it is oz's code.
    const cfg = JSON.parse(fs.readFileSync(path.join(t.dir, 'config/nitro-contracts/sources.json'), 'utf8'))
    fs.mkdirSync(path.join(t.dir, 'config/oz'))
    fs.writeFileSync(path.join(t.dir, 'config/oz/sources.json'), JSON.stringify({
      ...cfg, directory: 'oz', repo: 'Example/oz', url: 'https://github.com/Example/oz.git', npmPackages: ['@openzeppelin/contracts'], reviewedRangePairs: [], outOfScopeGetters: 'config/oz/out-of-scope-getters.json',
    }))
    fs.writeFileSync(path.join(t.dir, 'config/oz/out-of-scope-getters.json'), JSON.stringify({ schemaVersion: 1, repo: 'Example/oz', getters: {} }))
    t.commit('a source for OpenZeppelin')
    const tup = [...t.standardJson, '--contract', TUP, '--address', A.tup, '--label', 'a proxy one-off']
    const refused = await t.run(tup)
    assert.equal(refused.status, 1)
    assert.ok(refused.stderr.includes(`${TUP} is code from oz (package @openzeppelin/contracts@4.7.3; see config/oz/sources.json), and a source never publishes another source's code. Add it to oz instead: --source oz.\nNothing written.`), refused.stderr)
    assert.equal(t.changes(), '')
    const inOz = await t.run(['--source', 'oz', ...tup], { withSource: false })
    assert.equal(inOz.status, 0, inOz.stderr)
    assert.ok(new SourceData(t.dir, 'oz', 'Example/oz').entries().some(e => e.contracts[0] === TUP))

    // The Bridge's directory as a submodule of the token bridge's repo: the token bridge's code.
    fs.writeFileSync(path.join(t.checkout, '.gitmodules'), '[submodule "bridge"]\n\tpath = src/bridge\n\turl = git@github.com:OffchainLabs/token-bridge-contracts.git\n')
    const sub = await t.run(t.bridge(A.bridge, '--label', 'x'))
    assert.equal(sub.status, 1)
    assert.ok(sub.stderr.includes(`${BRIDGE} is code from token-bridge-contracts (git submodule src/bridge (OffchainLabs/token-bridge-contracts); see config/token-bridge-contracts/sources.json), ` +
      "and a source never publishes another source's code. Add it to token-bridge-contracts instead: --source token-bridge-contracts."), sub.stderr)
    assert.ok(!t.data.hasEntry(BRIDGE_FP))
  } finally {
    t.close()
  }
})
