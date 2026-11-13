// Shortens tool output and error messages for logs and alerts. Errors from ethers and Hardhat embed
// whole transactions: a contract's init code as a hex string, and again as a JSON byte map
// ({"0":96,"1":128,...}). That can be hundreds of KB, and it buries the actual error, which comes
// first.

// More than two 32-byte words with 0x (addresses and hashes stay), or a long bare run, which is
// what a hex string split across lines looks like.
const LONG_HEX = /\b0x[0-9a-fA-F]{130,}|\b[0-9a-fA-F]{200,}\b/g
// 32 or more comma-separated integers, each optionally keyed as in a JSON byte map ("12":96, or
// \"12\":96 inside an escaped JSON string).
const LONG_NUMBER_LIST = /(?:\\?"\d+\\?":\s*)?\d+(?:\s*,\s*(?:\\?"\d+\\?":\s*)?\d+){31,}/g

/** Replaces long hex strings and long number lists (byte maps, byte arrays) with a short marker. */
export function collapseData(text: string): string {
  return text
    .replace(LONG_HEX, h => {
      const digits = h.startsWith('0x') ? h.length - 2 : h.length
      return `${h.slice(0, h.startsWith('0x') ? 18 : 16)}…[${Math.floor(digits / 2)} bytes]`
    })
    .replace(LONG_NUMBER_LIST, l => `…[${l.split(',').length} numbers]…`)
}

/** Keeps the first two thirds and the last third of `max` characters of a long string. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.ceil((max * 2) / 3)
  const tail = max - head
  return `${s.slice(0, head)}…[${s.length - head - tail} chars]…${s.slice(s.length - tail)}`
}

/**
 * Shortens `text` to about `max` characters: collapses data (see collapseData), caps each line at
 * `maxLine`, then keeps whole lines from the head (where an error message starts) and from the
 * tail (where the output ended), dropping lines from the middle.
 */
export function abbreviate(text: string, { max = 3000, maxLine = 1000 }: { max?: number; maxLine?: number } = {}): string {
  const headBudget = Math.ceil((max * 2) / 3)
  const lines = collapseData(text).split('\n').map(l => truncateMiddle(l, Math.min(maxLine, headBudget)))
  if (lines.join('\n').length <= max) return lines.join('\n')
  const head: string[] = []
  let used = 0
  for (const l of lines) {
    if (used + l.length + 1 > headBudget) break
    head.push(l)
    used += l.length + 1
  }
  const tail: string[] = []
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length + 1 > max) break
    tail.unshift(lines[i])
    used += lines[i].length + 1
  }
  return [...head, `…[${lines.length - head.length - tail.length} line(s) omitted]…`, ...tail].join('\n')
}
