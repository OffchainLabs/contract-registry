import { keccak256, decodeAbiParameters, getAddress } from 'viem'
import { bytesToHex } from './hex.ts'
import type { Hex, MaskedRange } from './types.ts'

export interface MaskSpec {
  codeLength: number
  maskedRanges: MaskedRange[]
  cborMetadataLength: number
}

/** Zeroes every masked range and the trailing CBOR metadata section (spec §5.1). */
export function mask(code: Uint8Array, spec: MaskSpec): Uint8Array {
  if (code.length !== spec.codeLength) throw new Error(`code length ${code.length} != ${spec.codeLength}`)
  const out = Uint8Array.from(code)
  for (const r of spec.maskedRanges) {
    for (const off of r.offsets) {
      if (off + r.length > out.length) throw new Error(`masked range ${r.name} at ${off} out of range`)
      out.fill(0, off, off + r.length)
    }
  }
  if (spec.cborMetadataLength > 0) out.fill(0, out.length - spec.cborMetadataLength)
  return out
}

export function fingerprintOf(code: Uint8Array, spec: MaskSpec): Hex {
  return keccak256(mask(code, spec))
}

/** The match rule: same length, and same keccak after masking with the entry's ranges. */
export function matches(code: Uint8Array, entry: MaskSpec & { fingerprint: Hex }): boolean {
  if (code.length !== entry.codeLength) return false
  return fingerprintOf(code, entry).toLowerCase() === entry.fingerprint.toLowerCase()
}

export type ImmutableValue = string | boolean

/**
 * The Solidity immutables of code that matches `entry`, by name: each read from its first offset
 * and decoded by its ABI type. Synthetic ranges (names starting with `<`: linked-library and
 * library-self addresses) are masked but not reported; they say where the code was deployed, not
 * how it was configured.
 */
export function decodeImmutables(code: Uint8Array, entry: Pick<MaskSpec, 'maskedRanges'>): Record<string, ImmutableValue> {
  const out: Record<string, ImmutableValue> = {}
  for (const r of entry.maskedRanges) {
    if (r.name.startsWith('<')) continue
    const raw = code.slice(r.offsets[0], r.offsets[0] + r.length)
    out[r.name] = decodeWord(raw, r.type)
  }
  return out
}

function decodeWord(raw: Uint8Array, type: string): ImmutableValue {
  if (raw.length === 20 && type === 'address') return getAddress(bytesToHex(raw))
  if (raw.length !== 32) return bytesToHex(raw)
  try {
    const [v] = decodeAbiParameters([{ type }], bytesToHex(raw))
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return String(v)
    return v as string
  } catch {
    return bytesToHex(raw)
  }
}
