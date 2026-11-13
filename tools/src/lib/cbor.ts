/**
 * Detects the CBOR metadata section solc appends to runtime code: a CBOR map followed by its
 * length as a 2-byte big-endian integer. Returns the number of trailing bytes it occupies,
 * including the 2-byte suffix, or 0 when the code doesn't end with a well-formed section.
 */
export function cborMetadataLength(code: Uint8Array): number {
  if (code.length < 2) return 0
  const len = (code[code.length - 2] << 8) | code[code.length - 1]
  if (len === 0 || len + 2 > code.length) return 0
  const start = code.length - 2 - len
  try {
    const end = skipItem(code, start, code.length - 2, true)
    return end === code.length - 2 ? len + 2 : 0
  } catch {
    return 0
  }
}

/** Skips one CBOR item; with `topMap`, requires it to be a definite-length map. Returns the end offset. */
function skipItem(b: Uint8Array, p: number, limit: number, topMap = false): number {
  if (p >= limit) throw new Error('eof')
  const major = b[p] >> 5
  const info = b[p] & 0x1f
  if (topMap && major !== 5) throw new Error('not a map')
  let arg: number
  p++
  if (info < 24) arg = info
  else if (info === 24) { arg = b[p]; p += 1 }
  else if (info === 25) { arg = (b[p] << 8) | b[p + 1]; p += 2 }
  else if (info === 26) { arg = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; p += 4 }
  else throw new Error('unsupported length encoding')
  if (p > limit) throw new Error('eof')
  switch (major) {
    case 0: case 1: return p
    case 2: case 3: if (p + arg > limit) throw new Error('eof'); return p + arg
    case 4: for (let i = 0; i < arg; i++) p = skipItem(b, p, limit); return p
    case 5: for (let i = 0; i < 2 * arg; i++) p = skipItem(b, p, limit); return p
    case 7: return p // simple values (true/false/null)
    default: throw new Error(`unsupported major type ${major}`)
  }
}
