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

/**
 * The fields of the code's CBOR metadata section (see `cborMetadataLength`), for messages: `solc`
 * as a version (`0.8.17`), other byte strings as their length (`34 bytes`), text and simple values
 * as they are. Empty when the code has no well-formed section.
 */
export function cborMetadataFields(code: Uint8Array): Record<string, string> {
  const len = cborMetadataLength(code)
  if (!len) return {}
  const limit = code.length - 2
  const text = (h: Head) => Buffer.from(code.slice(h.p, h.p + h.arg)).toString('utf8')
  const out: Record<string, string> = {}
  let { arg: pairs, p } = head(code, code.length - len, limit)
  for (let i = 0; i < pairs; i++) {
    const k = head(code, p, limit)
    const key = k.major === 3 ? text(k) : `#${i}`
    p = skipItem(code, p, limit)
    const v = head(code, p, limit)
    if (v.major === 2) out[key] = key === 'solc' && v.arg === 3 ? code.slice(v.p, v.p + 3).join('.') : `${v.arg} bytes`
    else if (v.major === 3) out[key] = text(v)
    else if (v.major === 7) out[key] = v.info === 20 ? 'false' : v.info === 21 ? 'true' : 'null'
    else out[key] = String(v.arg)
    p = skipItem(code, p, limit)
  }
  return out
}

interface Head { major: number; info: number; arg: number; p: number }

/** Reads one CBOR item's head: major type, additional info, argument, and the offset after the head. */
function head(b: Uint8Array, p: number, limit: number): Head {
  if (p >= limit) throw new Error('eof')
  const major = b[p] >> 5
  const info = b[p] & 0x1f
  let arg: number
  p++
  if (info < 24) arg = info
  else if (info === 24) { arg = b[p]; p += 1 }
  else if (info === 25) { arg = (b[p] << 8) | b[p + 1]; p += 2 }
  else if (info === 26) { arg = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; p += 4 }
  else throw new Error('unsupported length encoding')
  if (p > limit) throw new Error('eof')
  return { major, info, arg, p }
}

/** Skips one CBOR item; with `topMap`, requires it to be a definite-length map. Returns the end offset. */
function skipItem(b: Uint8Array, p: number, limit: number, topMap = false): number {
  const h = head(b, p, limit)
  if (topMap && h.major !== 5) throw new Error('not a map')
  p = h.p
  switch (h.major) {
    case 0: case 1: return p
    case 2: case 3: if (p + h.arg > limit) throw new Error('eof'); return p + h.arg
    case 4: for (let i = 0; i < h.arg; i++) p = skipItem(b, p, limit); return p
    case 5: for (let i = 0; i < 2 * h.arg; i++) p = skipItem(b, p, limit); return p
    case 7: return p // simple values (true/false/null)
    default: throw new Error(`unsupported major type ${h.major}`)
  }
}
