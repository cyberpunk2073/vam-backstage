import { describe, it, expect } from 'vitest'
import { encode, decode } from './net-codec.js'

describe('net-codec buffer round-trip', () => {
  it('preserves bytes for a plain Uint8Array', () => {
    const src = new Uint8Array([0, 1, 2, 255, 128, 64])
    const round = decode(encode({ data: src }))
    expect(round.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(round.data)).toEqual(Array.from(src))
  })

  it('preserves a Uint8Array view with a non-zero byteOffset', () => {
    const backing = new Uint8Array([9, 9, 9, 10, 20, 30, 40, 9, 9])
    const view = backing.subarray(3, 7) // [10, 20, 30, 40], byteOffset > 0
    expect(view.byteOffset).toBeGreaterThan(0)

    const round = decode(encode({ data: view }))
    expect(round.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(round.data)).toEqual([10, 20, 30, 40])
    // Must not leak neighbouring bytes from the backing buffer.
    expect(round.data.length).toBe(4)
  })

  it('round-trips a Node Buffer', () => {
    const src = Buffer.from([1, 2, 3, 4, 5])
    const round = decode(encode({ data: src }))
    expect(Array.from(round.data)).toEqual([1, 2, 3, 4, 5])
  })
})
