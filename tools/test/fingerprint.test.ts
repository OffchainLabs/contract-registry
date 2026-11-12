import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256 } from 'viem'
import { cborMetadataLength } from '../src/lib/cbor.ts'
import { fingerprintOf, mask, matches, variantValues } from '../src/lib/fingerprint.ts'
import { hexToBytes } from '../src/lib/hex.ts'
import { codeSelectors } from '../src/walker/selectors.ts'

// solc 0.8.17 with bytecode_hash = 'none' appends {"solc": 0x000811} plus its length (0x000a).
const CBOR_NONE = 'a164736f6c6343000811000a'
// solc with an IPFS hash appends {"ipfs": <34 bytes>, "solc": ...} (length 0x0033).
const CBOR_IPFS = 'a2646970667358221220' + '11'.repeat(32) + '64736f6c6343000811' + '0033'

test('detects the CBOR metadata section and its length', () => {
  assert.equal(cborMetadataLength(hexToBytes('6080604052' + CBOR_NONE)), 12)
  assert.equal(cborMetadataLength(hexToBytes('6080604052' + CBOR_IPFS)), 53)
  assert.equal(cborMetadataLength(hexToBytes('6080604052600080fd')), 0, 'Yul-style code has none')
})

test('masks immutables at every offset and the CBOR section, and matches by length + hash', () => {
  const word = (n: number) => n.toString(16).padStart(64, '0')
  const build = '60' + '00'.repeat(32) + '61' + '00'.repeat(32) + '5b' + CBOR_NONE
  const spec = {
    codeLength: build.length / 2,
    immutables: [{ name: 'maxDataSize', type: 'uint256', offsets: [1, 34], length: 32 }],
    cborMetadataLength: 12,
  }
  const fp = fingerprintOf(hexToBytes(build), spec)
  const entry = { ...spec, fingerprint: fp }
  // Deployed: immutable filled in, different compiler-version CBOR bytes.
  const deployed = '60' + word(117964) + '61' + word(117964) + '5b' + 'a164736f6c6343000812000a'
  assert.ok(matches(hexToBytes(deployed), entry))
  assert.deepEqual(variantValues(hexToBytes(deployed), spec.immutables), { maxDataSize: '117964' })
  // Same length, different code: no match.
  assert.ok(!matches(hexToBytes(deployed.replace(/5b/, '5c')), entry))
  // Different length: no match (and no throw).
  assert.ok(!matches(hexToBytes(deployed + '00'), entry))
  // mask() leaves the input untouched.
  const input = hexToBytes(deployed)
  mask(input, spec)
  assert.equal(keccak256(input), keccak256(hexToBytes(deployed)))
})

test('decodes bool and address variants', () => {
  const code = hexToBytes('00'.repeat(31) + '01' + '00'.repeat(12) + '02791255466d0e8e6d0c7138e333efd48bf7e275')
  const v = variantValues(code, [
    { name: 'isUsingFeeToken', type: 'bool', offsets: [0], length: 32 },
    { name: 'reader4844', type: 'address', offsets: [32], length: 32 },
  ])
  assert.deepEqual(v, { isUsingFeeToken: true, reader4844: '0x02791255466D0E8e6d0C7138e333EFD48bf7e275' })
})

test('finds PUSH4 selectors but not push data that looks like opcodes', () => {
  // PUSH4 e78cea92, PUSH32 containing 63 deadbeef bytes (must be skipped), PUSH3 112233
  const code = hexToBytes('63e78cea92' + '7f' + '63deadbeef' + '00'.repeat(27) + '62112233')
  assert.deepEqual([...codeSelectors(code)].sort(), ['0x00112233', '0xe78cea92'])
})
