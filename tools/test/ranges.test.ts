// The range invariant that makes a lookup match at most one entry: within one source directory,
// entries of the same code length mask the same bytes, apart from reviewed pairs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { loadSourceConfig } from '../src/lib/config.ts'
import { fingerprintOf, matches, type MaskSpec } from '../src/lib/fingerprint.ts'
import { CBOR_METADATA, maskedBytes, rangeConflictReport, rangeConflicts, type RangeEntry } from '../src/lib/ranges.ts'
import { SchemaValidator } from '../src/lib/schema.ts'
import type { Hex, MaskedRange } from '../src/lib/types.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const fp = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const imm = (name: string, offsets: number[], length = 32): MaskedRange => ({ name, type: 'uint256', offsets, length })
const e = (n: number, codeLength: number, maskedRanges: MaskedRange[], cborMetadataLength = 12): RangeEntry =>
  ({ fingerprint: fp(n), contracts: [`src/X${n}.sol:X${n}`], codeLength, maskedRanges, cborMetadataLength })
const pairs = (cs: ReturnType<typeof rangeConflicts>) => cs.map(c => [c.a.fingerprint, c.b.fingerprint])

test('maskedBytes: merges overlapping and adjacent ranges, adds the CBOR section, rejects ranges outside the code', () => {
  const spec = { codeLength: 200, maskedRanges: [imm('b', [40]), imm('a', [10, 100]), imm('c', [72], 20)], cborMetadataLength: 12 }
  assert.deepEqual(maskedBytes(spec), [
    { start: 10, end: 92, names: ['a', 'b', 'c'] },
    { start: 100, end: 132, names: ['a'] },
    { start: 188, end: 200, names: [CBOR_METADATA] },
  ])
  assert.throws(() => maskedBytes({ codeLength: 50, maskedRanges: [imm('x', [20])], cborMetadataLength: 0 }), /x covers bytes 20 to 51, outside the 50-byte code/)
  assert.throws(() => maskedBytes({ codeLength: 10, maskedRanges: [], cborMetadataLength: 12 }), /<CBOR metadata> covers bytes -2 to 9, outside/)
  // An entry that can't be checked fails the check, naming the entry.
  assert.throws(() => rangeConflicts([e(1, 50, [imm('x', [20])])], []), new RegExp(`entry ${fp(1)}: x covers bytes 20 to 51`))
})

test('range invariant: same-length entries that mask the same bytes pass, whatever their ranges are called', () => {
  assert.deepEqual(rangeConflicts([
    // Same offsets, different names.
    e(1, 300, [imm('maxDataSize', [10])]), e(2, 300, [imm('_maxDataSize', [10])]),
    // One range, or two adjacent ones, over the same bytes.
    e(3, 300, [imm('a', [10], 16), imm('b', [26], 16)]),
    // An occurrence listed twice is the same byte set.
    e(4, 300, [imm('m', [10, 10])]),
  ], []), [])
  // A range next to the CBOR section, or a longer CBOR section.
  assert.deepEqual(rangeConflicts([e(5, 300, [imm('t', [280], 8)], 12), e(6, 300, [], 20)], []), [])
  // Different lengths never conflict: a lookup only tests entries of the code's own length.
  assert.deepEqual(rangeConflicts([e(7, 400, []), e(8, 500, [imm('x', [0])]), e(9, 600, [], 0)], []), [])
  assert.deepEqual(rangeConflicts([], []), [])
})

test('range invariant: same-length entries that mask different bytes conflict, with the bytes that differ', () => {
  const a = e(1, 300, [imm('maxDataSize', [10])])
  const b = e(2, 300, [imm('maxDataSize', [10]), imm('deployTimeChainId', [100])])
  const c = e(3, 300, [imm('x', [10]), imm('y', [42])])
  const cs = rangeConflicts([c, b, a, e(4, 200, [])], [])
  assert.deepEqual(pairs(cs), [[fp(1), fp(2)], [fp(1), fp(3)], [fp(2), fp(3)]], 'every differing pair, ordered by fingerprint')
  assert.deepEqual([cs[0].onlyA, cs[0].onlyB], [[], [{ start: 100, end: 132, names: ['deployTimeChainId'] }]])
  // A wider masked run: only the bytes that differ, named by the ranges that cover them.
  assert.deepEqual([cs[1].onlyA, cs[1].onlyB], [[], [{ start: 42, end: 74, names: ['y'] }]])
  assert.deepEqual([cs[2].onlyA, cs[2].onlyB], [[{ start: 100, end: 132, names: ['deployTimeChainId'] }], [{ start: 42, end: 74, names: ['y'] }]])
  // A differing CBOR length is a difference too.
  assert.deepEqual(rangeConflicts([e(5, 300, [], 12), e(6, 300, [], 0)], [])[0].onlyA, [{ start: 288, end: 300, names: [CBOR_METADATA] }])

  // The report names both fingerprints and their contracts, shows the bytes, and says how to clear it.
  const report = rangeConflictReport('nitro-contracts', [cs[0]])
  assert.match(report.split('\n')[0], /^nitro-contracts: 1 pair\(s\) of entries with the same code length mask different bytes/)
  assert.ok(report.includes(`300-byte entries ${fp(1)} (src/X1.sol:X1) and ${fp(2)} (src/X2.sol:X2)`))
  assert.ok(report.includes(`masked only by ${fp(1)}: none`))
  assert.ok(report.includes(`masked only by ${fp(2)}: bytes 100-131 (deployTimeChainId)`))
  assert.match(report, /add the pair, with a note on the review, to reviewedRangePairs in config\/nitro-contracts\/sources\.json/)
  const snippet = JSON.parse(/once reviewed: (\{.*\})/.exec(report)![1])
  assert.deepEqual(snippet.fingerprints, [fp(1), fp(2)])
})

test('range invariant: a reviewed pair passes, in either order; unreviewed pairs of the same length still fail', () => {
  const a = e(1, 300, [imm('x', [10])]), b = e(2, 300, [imm('x', [10])]), c = e(3, 300, [])
  assert.deepEqual(pairs(rangeConflicts([a, b, c], [])), [[fp(1), fp(3)], [fp(2), fp(3)]])
  const reviewed = [{ fingerprints: [fp(3), fp(1)] as [Hex, Hex], note: 'rebuilt both; X3 differs at byte 5, which neither masks' }]
  assert.deepEqual(pairs(rangeConflicts([a, b, c], reviewed)), [[fp(2), fp(3)]], 'reviewing one pair clears only that pair')
  reviewed.push({ fingerprints: [fp(2), fp(3)], note: 'same' })
  assert.deepEqual(rangeConflicts([a, b, c], reviewed), [])
  // A reviewed pair naming entries that don't exist yet (reviewed before the run that adds them) is harmless.
  assert.deepEqual(rangeConflicts([a], [{ fingerprints: [fp(8), fp(9)], note: 'pre-reviewed' }]), [])
})

test('range invariant: two new entries in one run collide, and a new entry collides with an existing one', () => {
  // What publish checks: every entry of the source, existing and new.
  const existing = [e(1, 300, [imm('x', [10])]), e(2, 300, [imm('x', [10])]), e(3, 500, [])]
  assert.deepEqual(rangeConflicts(existing, []), [])
  const new1 = e(10, 700, [imm('a', [10])]), new2 = e(11, 700, [imm('b', [50])])
  assert.deepEqual(pairs(rangeConflicts([...existing, new1, new2], [])), [[fp(10), fp(11)]], 'two new entries of a new length')
  const new3 = e(12, 500, [imm('c', [0])])
  assert.deepEqual(pairs(rangeConflicts([...existing, new3], [])), [[fp(3), fp(12)]], 'a new entry against an existing one')
  const new4 = e(13, 300, [imm('y', [10])])
  assert.deepEqual(rangeConflicts([...existing, new4], []), [], 'a new entry masking the same bytes as the existing ones')
})

test('range invariant: whenever some code matches two entries, the check flags the pair (exhaustive, 4-byte code)', () => {
  // Entries for the masks below over every 4-byte build with bytes 1 or 2 (not 0, so a masked
  // build's fingerprint never equals an unmasked one's). Code that matches an entry agrees with its
  // build outside the masked bytes, so trying codes with bytes 1 or 2 finds every pair that some
  // code matches both of.
  const r = (name: string, offsets: number[], length: number): MaskedRange => ({ name, type: 'bytes1', offsets, length })
  const masks: Omit<MaskSpec, 'codeLength'>[] = [
    { maskedRanges: [], cborMetadataLength: 0 },
    { maskedRanges: [r('a', [0], 1)], cborMetadataLength: 0 },
    { maskedRanges: [r('z', [0], 1)], cborMetadataLength: 0 },
    { maskedRanges: [r('a', [0], 2)], cborMetadataLength: 0 },
    { maskedRanges: [r('a', [0], 1), r('b', [1], 1)], cborMetadataLength: 0 },
    { maskedRanges: [r('c', [1, 2], 1)], cborMetadataLength: 0 },
    { maskedRanges: [], cborMetadataLength: 1 },
    { maskedRanges: [r('d', [3], 1)], cborMetadataLength: 0 },
    { maskedRanges: [r('e', [2], 1)], cborMetadataLength: 1 },
    { maskedRanges: [r('f', [0], 1), r('g', [2], 2)], cborMetadataLength: 0 },
  ]
  const codes = Array.from({ length: 16 }, (_, i) => Uint8Array.from([0, 1, 2, 3].map(b => 1 + ((i >> b) & 1))))
  // One entry per fingerprint, as in a source directory (an entry's file is named by it).
  const entries = new Map<Hex, RangeEntry & { build: Uint8Array; matched: number }>()
  for (const v of masks) {
    for (const build of codes) {
      const spec = { codeLength: 4, ...v }
      const fingerprint = fingerprintOf(build, spec)
      if (entries.has(fingerprint)) continue
      const x = { ...spec, fingerprint, contracts: ['src/T.sol:T'], build, matched: 0 }
      codes.forEach((c, i) => { if (matches(c, x)) x.matched |= 1 << i })
      entries.set(fingerprint, x)
    }
  }
  const all = [...entries.values()]
  let bothMatched = 0, sameBytes = 0
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [x, y] = [all[i], all[j]]
      const both = (x.matched & y.matched) !== 0
      const flagged = rangeConflicts([x, y], []).length === 1
      if (both) { bothMatched++; assert.ok(flagged, `code matches both ${x.fingerprint} and ${y.fingerprint}, but they weren't flagged`) }
      if (!flagged) sameBytes++
      if (flagged) {
        // What the report tells a reviewer to check: both match some code exactly when the
        // builds agree on every byte neither masks.
        const masked = (s: MaskSpec) => new Set(maskedBytes(s).flatMap(iv => Array.from({ length: iv.end - iv.start }, (_, k) => iv.start + k)))
        const [mx, my] = [masked(x), masked(y)]
        const agree = [0, 1, 2, 3].every(k => mx.has(k) || my.has(k) || x.build[k] === y.build[k])
        assert.equal(both, agree, `${x.fingerprint} / ${y.fingerprint}`)
      }
    }
  }
  assert.ok(bothMatched > 100 && sameBytes > 100, `the space exercises both cases (${bothMatched} pairs both matched, ${sameBytes} pairs mask the same bytes)`)
  // And the whole set's conflicts are exactly the pairs with different masked bytes.
  assert.equal(rangeConflicts(all, []).length, all.length * (all.length - 1) / 2 - sameBytes)
})

test('schema: reviewedRangePairs is required and holds two distinct fingerprints and a note', () => {
  const v = new SchemaValidator(ROOT)
  const cfg = loadSourceConfig(ROOT, 'nitro-contracts')
  assert.deepEqual(cfg.reviewedRangePairs, [])
  const withPairs = (reviewedRangePairs: unknown) => v.validate('sources', { ...cfg, reviewedRangePairs })
  assert.deepEqual(withPairs([{ fingerprints: [fp(1), fp(2)], note: 'rebuilt both; they differ at byte 7, which neither masks' }]), [])
  const { reviewedRangePairs, ...without } = cfg
  assert.notDeepEqual(v.validate('sources', without), [], 'required')
  assert.notDeepEqual(withPairs([{ fingerprints: [fp(1)], note: 'n' }]), [], 'one fingerprint')
  assert.notDeepEqual(withPairs([{ fingerprints: [fp(1), fp(2), fp(3)], note: 'n' }]), [], 'three fingerprints')
  assert.notDeepEqual(withPairs([{ fingerprints: [fp(1), fp(1)], note: 'n' }]), [], 'the same fingerprint twice')
  assert.notDeepEqual(withPairs([{ fingerprints: [fp(1), fp(2)] }]), [], 'no note')
  assert.notDeepEqual(withPairs([{ fingerprints: [fp(1), fp(2)], note: '' }]), [], 'an empty note')
  assert.deepEqual(withPairs([{ fingerprints: [fp(1), `0x${'ab'.repeat(32)}`], note: 'n' }]), [])
  assert.notDeepEqual(withPairs([{ fingerprints: [fp(1), `0x${'AB'.repeat(32)}`], note: 'n' }]), [], 'fingerprints are lowercase')
})
