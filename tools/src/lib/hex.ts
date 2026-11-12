import type { Hex } from './types.ts'

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex (${h.length} chars)`)
  return Uint8Array.from(Buffer.from(h, 'hex'))
}

export function bytesToHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString('hex')}`
}

export function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
