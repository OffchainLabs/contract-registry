import * as fs from 'node:fs'
import * as path from 'node:path'
import { toFunctionSelector } from 'viem'
import { cborMetadataLength } from './cbor.ts'
import { fingerprintOf } from './fingerprint.ts'
import { hexToBytes } from './hex.ts'
import { matchesAny } from './glob.ts'
import type { BuiltContract, CompilerInfo, Getter, Hex, ImmutableRef } from './types.ts'

/** A solc standard-JSON build-info file (Hardhat and Foundry both write these). */
export interface BuildInfo {
  file: string
  solcLongVersion: string
  input: { language: string; settings: any; sources: Record<string, unknown> }
  output: { contracts?: Record<string, Record<string, any>>; sources?: Record<string, { id: number; ast?: any }> }
}

export function loadBuildInfos(dir: string): BuildInfo[] {
  if (!fs.existsSync(dir)) throw new Error(`build-info directory not found: ${dir}`)
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (!j.input || !j.output) throw new Error(`${f}: not a standard-JSON build-info file`)
    const version = j.solcLongVersion ?? j.solcVersion
    if (!version) throw new Error(`${f}: no compiler version`)
    return { file: path.join(dir, f), solcLongVersion: version, input: j.input, output: j.output }
  })
}

/** Source names differ between toolchains for dependencies (`node_modules/@oz/...` vs `@oz/...`). */
export function normalizeSource(source: string): string {
  return source.replace(/^node_modules\//, '')
}

export interface ArtifactRef { fqName: string; buildInfo: BuildInfo; source: string; name: string }

/**
 * Picks, for every fully qualified name, the compilation job whose output is the toolchain's
 * artifact. A file can appear in several jobs (e.g. as a dependency of a file with an optimizer
 * override); only one of them is what the deploy scripts use.
 *
 * - `hardhat`: Hardhat's `*.dbg.json` files name the build-info each artifact came from.
 * - `standard-json`: every contract in every build-info; ambiguous names are an error.
 */
export function selectArtifacts(buildInfos: BuildInfo[], layout: 'hardhat' | 'standard-json', artifactsDir?: string): ArtifactRef[] {
  const byFile = new Map(buildInfos.map(b => [path.resolve(b.file), b]))
  const refs = new Map<string, ArtifactRef>()
  if (layout === 'hardhat') {
    if (!artifactsDir) throw new Error('hardhat layout needs artifactsDir')
    for (const dbg of walkFiles(artifactsDir, f => f.endsWith('.dbg.json'))) {
      const art = JSON.parse(fs.readFileSync(dbg.replace(/\.dbg\.json$/, '.json'), 'utf8'))
      const biPath = path.resolve(path.dirname(dbg), JSON.parse(fs.readFileSync(dbg, 'utf8')).buildInfo)
      const bi = byFile.get(biPath)
      if (!bi) throw new Error(`${dbg}: build-info ${biPath} not loaded`)
      const fqName = `${art.sourceName}:${art.contractName}`
      if (!bi.output.contracts?.[art.sourceName]?.[art.contractName]) throw new Error(`${fqName} missing from ${biPath}`)
      refs.set(fqName, { fqName, buildInfo: bi, source: art.sourceName, name: art.contractName })
    }
  } else {
    const seen = new Map<string, string>()
    for (const bi of buildInfos) {
      for (const [source, contracts] of Object.entries(bi.output.contracts ?? {})) {
        for (const [name, c] of Object.entries(contracts)) {
          const fqName = `${source}:${name}`
          const code = c.evm?.deployedBytecode?.object ?? ''
          if (seen.has(fqName) && seen.get(fqName) !== code) throw new Error(`${fqName} compiled differently in two jobs; use an artifact layout that says which is deployed`)
          seen.set(fqName, code)
          refs.set(fqName, { fqName, buildInfo: bi, source, name })
        }
      }
    }
  }
  return [...refs.values()].sort((a, b) => a.fqName.localeCompare(b.fqName))
}

function walkFiles(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p, pred))
    else if (pred(p)) out.push(p)
  }
  return out.sort()
}

export function compilerInfo(bi: BuildInfo): CompilerInfo {
  const s = bi.input.settings ?? {}
  const opt = s.optimizer ?? {}
  return {
    language: bi.input.language ?? 'Solidity',
    version: bi.solcLongVersion,
    evmVersion: s.evmVersion ?? null,
    optimizer: { enabled: !!opt.enabled, runs: opt.runs ?? null, ...(opt.details ? { details: opt.details } : {}) },
    viaIR: !!s.viaIR,
    // solc appends CBOR metadata to Solidity output only, never to Yul objects.
    metadata: { bytecodeHash: s.metadata?.bytecodeHash ?? null, appendCBOR: bi.input.language === 'Yul' ? false : (s.metadata?.appendCBOR ?? true) },
  }
}

/** Key over the settings that affect bytecode, used to pair jobs across toolchains. */
export function compilerKey(c: CompilerInfo): string {
  return JSON.stringify([c.version.replace(/^v/, '').split('+')[0], c.evmVersion, c.optimizer.enabled, c.optimizer.runs, c.viaIR])
}

const astCache = new WeakMap<BuildInfo, Map<number, any>>()
function astIndex(bi: BuildInfo): Map<number, any> {
  let idx = astCache.get(bi)
  if (idx) return idx
  idx = new Map()
  const visit = (n: any) => {
    if (n && typeof n === 'object') {
      if (typeof n.id === 'number' && typeof n.nodeType === 'string') idx!.set(n.id, n)
      for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v)
    }
  }
  for (const s of Object.values(bi.output.sources ?? {})) visit(s.ast)
  astCache.set(bi, idx)
  return idx
}

function abiTypeOf(decl: any, idx: Map<number, any>): string {
  const ts: string = decl.typeDescriptions?.typeString ?? ''
  if (ts === 'address' || ts === 'address payable') return 'address'
  if (ts.startsWith('contract ')) return 'address'
  if (ts.startsWith('enum ')) return 'uint8'
  if (/^(bool|u?int\d*|bytes\d+)$/.test(ts)) return ts === 'uint' ? 'uint256' : ts === 'int' ? 'int256' : ts
  const ref = decl.typeName?.referencedDeclaration
  const target = ref !== undefined ? idx.get(ref) : undefined
  if (target?.nodeType === 'UserDefinedValueTypeDefinition') return target.underlyingType?.name ?? 'bytes32'
  return 'bytes32'
}

function immutablesOf(bi: BuildInfo, refs: Record<string, { start: number; length: number }[]>, fqName: string): ImmutableRef[] {
  const idx = astIndex(bi)
  const out: (ImmutableRef & { scope: string })[] = []
  for (const [id, ranges] of Object.entries(refs)) {
    const decl = idx.get(Number(id))
    if (!decl || decl.nodeType !== 'VariableDeclaration') throw new Error(`${fqName}: immutable AST node ${id} not found`)
    const lengths = new Set(ranges.map(r => r.length))
    if (lengths.size !== 1) throw new Error(`${fqName}: immutable ${decl.name} has mixed lengths`)
    out.push({
      name: decl.name,
      type: abiTypeOf(decl, idx),
      offsets: ranges.map(r => r.start).sort((a, b) => a - b),
      length: ranges[0].length,
      scope: idx.get(decl.scope)?.name ?? String(decl.scope),
    })
  }
  const counts = new Map<string, number>()
  for (const i of out) counts.set(i.name, (counts.get(i.name) ?? 0) + 1)
  return out
    .map(({ scope, ...i }) => (counts.get(i.name)! > 1 ? { ...i, name: `${scope}.${i.name}` } : i))
    .sort((a, b) => a.offsets[0] - b.offsets[0])
}

export function gettersOf(abi: any[]): Getter[] {
  const out: Getter[] = []
  for (const f of abi) {
    if (f.type !== 'function') continue
    if (f.stateMutability !== 'view' && f.stateMutability !== 'pure') continue
    if (f.outputs?.length !== 1 || f.outputs[0].type !== 'address') continue
    const inputs = f.inputs ?? []
    let kind: Getter['kind']
    if (inputs.length === 0) kind = 'single'
    else if (inputs.length === 1 && inputs[0].type === 'uint256') kind = 'list'
    else continue
    const signature = `${f.name}(${inputs.map((i: any) => i.type).join(',')})`
    out.push({ signature, selector: toFunctionSelector(signature), kind })
  }
  return out.sort((a, b) => a.signature.localeCompare(b.signature))
}

export function selectorsOf(contract: any): Hex[] {
  const ids: Record<string, string> = contract.evm?.methodIdentifiers ?? {}
  const sels = Object.keys(ids).length
    ? Object.values(ids).map(s => `0x${s}` as Hex)
    : (contract.abi ?? []).filter((f: any) => f.type === 'function').map((f: any) => toFunctionSelector(f))
  return [...new Set(sels)].sort() as Hex[]
}

/**
 * Turns one compiled contract into a fingerprinted record. Returns null for empty runtime code
 * (interfaces, abstract contracts). Library self-address and link placeholders are masked like
 * immutables, since they are filled in at deploy time.
 */
export function extractContract(ref: ArtifactRef): BuiltContract | null {
  const c = ref.buildInfo.output.contracts![ref.source][ref.name]
  let hex: string = c.evm?.deployedBytecode?.object ?? ''
  if (!hex || hex === '0x') return null
  const compiler = compilerInfo(ref.buildInfo)
  const immutables = immutablesOf(ref.buildInfo, c.evm.deployedBytecode.immutableReferences ?? {}, ref.fqName)

  // Linked-library placeholders (`__$...$__`) are not hex; zero them and mask them.
  const links: Record<string, Record<string, { start: number; length: number }[]>> = c.evm.deployedBytecode.linkReferences ?? {}
  for (const [file, libs] of Object.entries(links)) {
    for (const [lib, ranges] of Object.entries(libs)) {
      for (const r of ranges) hex = hex.slice(0, 2 * r.start) + '0'.repeat(2 * r.length) + hex.slice(2 * (r.start + r.length))
      immutables.push({ name: `<link ${file}:${lib}>`, type: 'address', offsets: ranges.map(r => r.start).sort((a, b) => a - b), length: 20 })
    }
  }
  const code = hexToBytes(hex)

  // Libraries' runtime code starts with PUSH20 <own address>, zero in the build.
  const nodeId = findContractNodeId(ref)
  const isLibrary = nodeId !== undefined && astIndex(ref.buildInfo).get(nodeId)?.contractKind === 'library'
  if (isLibrary && code[0] === 0x73 && code.slice(1, 21).every(b => b === 0)) {
    immutables.push({ name: '<library address>', type: 'address', offsets: [1], length: 20 })
  }
  immutables.sort((a, b) => a.offsets[0] - b.offsets[0])

  let cbor = 0
  if (compiler.language === 'Solidity' && compiler.metadata.appendCBOR) {
    cbor = cborMetadataLength(code)
    if (cbor === 0) throw new Error(`${ref.fqName}: expected a CBOR metadata section`)
  }
  const spec = { codeLength: code.length, immutables, cborMetadataLength: cbor }
  return {
    fqName: ref.fqName,
    fingerprint: fingerprintOf(code, spec),
    codeLength: code.length,
    immutables,
    cborMetadataLength: cbor,
    getters: gettersOf(c.abi ?? []),
    selectors: selectorsOf(c),
    compiler,
  }
}

function findContractNodeId(ref: ArtifactRef): number | undefined {
  const ast = ref.buildInfo.output.sources?.[ref.source]?.ast
  const node = ast?.nodes?.find((n: any) => n.nodeType === 'ContractDefinition' && n.name === ref.name)
  return node?.id
}

export function filterSources(refs: ArtifactRef[], include: string[], exclude: string[]): ArtifactRef[] {
  return refs.filter(r => {
    const s = normalizeSource(r.source)
    return matchesAny(s, include) && !matchesAny(s, exclude)
  })
}

export interface ParityMismatch { fqName: string; reason: string }

/**
 * Compares the deployed toolchain's contracts with a second toolchain's build. A contract is
 * paired with the job in the other build that used the same bytecode-affecting settings.
 */
export function parityCheck(deployed: ArtifactRef[], other: BuildInfo[]): ParityMismatch[] {
  const otherByKey = new Map<string, Map<string, any>>()
  for (const bi of other) {
    const key = compilerKey(compilerInfo(bi))
    const m = otherByKey.get(key) ?? new Map<string, any>()
    for (const [source, cs] of Object.entries(bi.output.contracts ?? {})) {
      for (const [name, c] of Object.entries(cs)) m.set(`${normalizeSource(source)}:${name}`, c)
    }
    otherByKey.set(key, m)
  }
  const out: ParityMismatch[] = []
  for (const r of deployed) {
    const mine = r.buildInfo.output.contracts![r.source][r.name]
    if (!mine.evm?.deployedBytecode?.object) continue
    const key = compilerKey(compilerInfo(r.buildInfo))
    const theirs = otherByKey.get(key)?.get(`${normalizeSource(r.source)}:${r.name}`)
    if (!theirs) { out.push({ fqName: r.fqName, reason: `not built by the other toolchain with settings ${key}` }); continue }
    if (strip(mine.evm.deployedBytecode.object) !== strip(theirs.evm.deployedBytecode.object)) out.push({ fqName: r.fqName, reason: 'runtime code differs' })
    else if (strip(mine.evm.bytecode.object) !== strip(theirs.evm.bytecode.object)) out.push({ fqName: r.fqName, reason: 'creation code differs' })
    else if (JSON.stringify(rangesOf(mine)) !== JSON.stringify(rangesOf(theirs))) out.push({ fqName: r.fqName, reason: 'immutable offsets differ' })
  }
  return out
}

const strip = (h: string) => h.replace(/^0x/, '').toLowerCase()
const rangesOf = (c: any) => Object.values(c.evm.deployedBytecode.immutableReferences ?? {}).map((rs: any) => rs.map((r: any) => r.start).sort((a: number, b: number) => a - b)).sort((a: any, b: any) => a[0] - b[0])
