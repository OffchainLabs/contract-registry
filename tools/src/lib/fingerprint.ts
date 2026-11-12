import { keccak256, decodeAbiParameters, getAddress } from 'viem'
import { bytesToHex } from './hex.ts'
import type { Hex, ImmutableRef } from './types.ts'

export interface MaskSpec {
  codeLength: number
  immutables: ImmutableRef[]
  cborMetadataLength: number
}

/** Zeroes every immutable range and the trailing CBOR metadata section (spec §5.1). */
export function mask(code: Uint8Array, spec: MaskSpec): Uint8Array {
  if (code.length !== spec.codeLength) throw new Error(`code length ${code.length} != ${spec.codeLength}`)
  const out = Uint8Array.from(code)
  for (const imm of spec.immutables) {
    for (const off of imm.offsets) {
      if (off + imm.length > out.length) throw new Error(`immutable ${imm.name} at ${off} out of range`)
      out.fill(0, off, off + imm.length)
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

export type VariantValue = string | boolean

/** Reads each immutable from its first offset and decodes it by its ABI type. */
export function variantValues(code: Uint8Array, immutables: ImmutableRef[]): Record<string, VariantValue> {
  const out: Record<string, VariantValue> = {}
  for (const imm of immutables) {
    const raw = code.slice(imm.offsets[0], imm.offsets[0] + imm.length)
    out[imm.name] = decodeWord(raw, imm.type)
  }
  return out
}

function decodeWord(raw: Uint8Array, type: string): VariantValue {
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
