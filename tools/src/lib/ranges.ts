import type { ReviewedRangePair } from './config.ts'
import type { MaskSpec } from './fingerprint.ts'
import type { Entry } from './types.ts'

/** A run of masked bytes, `[start, end)`, and the names of the ranges that cover it. */
export interface MaskedInterval { start: number; end: number; names: string[] }

/** The name `maskedBytes` gives the trailing CBOR metadata section. */
export const CBOR_METADATA = '<CBOR metadata>'

/**
 * Every byte `mask` zeroes (each masked range at every offset, plus the trailing CBOR metadata), as
 * sorted intervals with overlapping and adjacent ones merged. Two specs with equal intervals zero
 * exactly the same bytes, whatever their ranges are called. Throws, like `mask`, for a range
 * outside the code.
 */
export function maskedBytes(spec: MaskSpec): MaskedInterval[] {
  return merge(partsOf(spec))
}

/** Each masked occurrence on its own, checked to lie inside the code. */
function partsOf(spec: MaskSpec): MaskedInterval[] {
  const raw = spec.maskedRanges.flatMap(r => r.offsets.map(o => ({ start: o, end: o + r.length, names: [r.name] })))
  if (spec.cborMetadataLength > 0) raw.push({ start: spec.codeLength - spec.cborMetadataLength, end: spec.codeLength, names: [CBOR_METADATA] })
  for (const r of raw) {
    if (!(Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= spec.codeLength)) {
      throw new Error(`${r.names[0]} covers bytes ${r.start} to ${r.end - 1}, outside the ${spec.codeLength}-byte code`)
    }
  }
  return raw
}

function merge(parts: MaskedInterval[]): MaskedInterval[] {
  const raw = [...parts].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: MaskedInterval[] = []
  for (const r of raw) {
    const last = out.at(-1)
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end)
      for (const n of r.names) if (!last.names.includes(n)) last.names.push(n)
    } else {
      out.push({ ...r, names: [...r.names] })
    }
  }
  return out
}

/** What the range check reads from an entry. */
export type RangeEntry = MaskSpec & Pick<Entry, 'fingerprint' | 'contracts'>

export interface RangeConflict {
  codeLength: number
  a: RangeEntry
  b: RangeEntry
  /** The bytes `a` masks and `b` doesn't, named by `a`'s ranges that cover them. */
  onlyA: MaskedInterval[]
  /** The bytes `b` masks and `a` doesn't. */
  onlyB: MaskedInterval[]
}

/**
 * Finds the pairs of entries that break the invariant behind single-match lookup: within one
 * source directory, entries of the same code length mask the same bytes. Code can match two such
 * entries only if their fingerprints are equal, and fingerprints are unique per entry (each entry's
 * file is named by its fingerprint), so at most one entry matches any code. Two entries of one
 * length that mask different bytes both match some code exactly when their builds agree on every
 * byte neither masks. Entries of one length that mask different bytes could both match
 * some code, and without both builds' bytecode that can't be ruled out, so each such pair is a
 * conflict unless it is in `reviewed`. Pass one source directory's entries; conflicts are ordered
 * by code length, then fingerprint.
 */
export function rangeConflicts(entries: RangeEntry[], reviewed: ReviewedRangePair[]): RangeConflict[] {
  const allowed = new Set(reviewed.map(p => pairKey(p.fingerprints[0], p.fingerprints[1])))
  const byLength = new Map<number, RangeEntry[]>()
  for (const e of entries) byLength.set(e.codeLength, [...(byLength.get(e.codeLength) ?? []), e])
  const out: RangeConflict[] = []
  for (const len of [...byLength.keys()].sort((x, y) => x - y)) {
    const group = byLength.get(len)!
      .map(e => {
        let parts: MaskedInterval[]
        try { parts = partsOf(e) } catch (err) { throw new Error(`entry ${e.fingerprint}: ${(err as Error).message}`) }
        const bytes = merge(parts)
        return { e, parts, bytes, key: bytes.map(i => `${i.start}-${i.end}`).join(',') }
      })
      .sort((x, y) => x.e.fingerprint.toLowerCase().localeCompare(y.e.fingerprint.toLowerCase()))
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]]
        if (a.key === b.key || allowed.has(pairKey(a.e.fingerprint, b.e.fingerprint))) continue
        out.push({ codeLength: len, a: a.e, b: b.e, onlyA: subtract(a.bytes, b.bytes, a.parts), onlyB: subtract(b.bytes, a.bytes, b.parts) })
      }
    }
  }
  return out
}

/**
 * A report of range conflicts for people: each pair's fingerprints, contracts and differing
 * bytes, and how to clear it. The first line is a one-line summary.
 */
export function rangeConflictReport(directory: string, conflicts: RangeConflict[]): string {
  const lines = [`${directory}: ${conflicts.length} pair(s) of entries with the same code length mask different bytes, so some code could match both entries of a pair`]
  for (const c of conflicts) {
    lines.push(
      `- ${c.codeLength}-byte entries ${c.a.fingerprint} (${c.a.contracts.join(', ')}) and ${c.b.fingerprint} (${c.b.contracts.join(', ')})`,
      `    masked only by ${c.a.fingerprint}: ${describe(c.onlyA)}`,
      `    masked only by ${c.b.fingerprint}: ${describe(c.onlyB)}`,
      `    once reviewed: ${JSON.stringify({ fingerprints: [c.a.fingerprint, c.b.fingerprint], note: '<what the review found>' })}`,
    )
  }
  lines.push(
    'To clear a pair: rebuild both entries and confirm that their runtime code differs at some byte that neither masks (code matching both would ' +
    `have to agree with both builds there), then add the pair, with a note on the review, to reviewedRangePairs in config/${directory}/sources.json.`,
  )
  return lines.join('\n')
}

function describe(intervals: MaskedInterval[]): string {
  if (!intervals.length) return 'none'
  return intervals.map(i => `bytes ${i.start}-${i.end - 1} (${i.names.join(', ')})`).join('; ')
}

/**
 * The bytes in `a` and not in `b` (both sorted and merged, as `maskedBytes` returns them), each run
 * named by the parts of `a` that overlap it.
 */
function subtract(a: MaskedInterval[], b: MaskedInterval[], aParts: MaskedInterval[]): MaskedInterval[] {
  const runs: { start: number; end: number }[] = []
  for (const x of a) {
    let start = x.start
    for (const y of b) {
      if (y.end <= start || y.start >= x.end) continue
      if (y.start > start) runs.push({ start, end: y.start })
      start = y.end
    }
    if (start < x.end) runs.push({ start, end: x.end })
  }
  return runs.map(r => ({ ...r, names: [...new Set(aParts.filter(p => p.start < r.end && p.end > r.start).flatMap(p => p.names))] }))
}

const pairKey = (x: string, y: string) => [x.toLowerCase(), y.toLowerCase()].sort().join(' ')
