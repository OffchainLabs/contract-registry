/**
 * Candidate function selectors in runtime code: the immediates of PUSH4 (and PUSH3, for
 * selectors with a leading zero byte) found while walking the opcodes, skipping push data.
 */
export function codeSelectors(code: Uint8Array): Set<string> {
  const out = new Set<string>()
  for (let pc = 0; pc < code.length; pc++) {
    const op = code[pc]
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f
      if ((n === 4 || n === 3) && pc + n < code.length) {
        let v = 0
        for (let i = 1; i <= n; i++) v = v * 256 + code[pc + i]
        out.add('0x' + v.toString(16).padStart(8, '0'))
      }
      pc += n
    }
  }
  return out
}
