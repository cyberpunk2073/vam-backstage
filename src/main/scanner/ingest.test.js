import { describe, it, expect } from 'vitest'
import { personAtomIdsJsonFromBuffer } from './ingest.js'

describe('personAtomIdsJsonFromBuffer', () => {
  it('returns null for null buffer', () => {
    expect(personAtomIdsJsonFromBuffer(null)).toBe(null)
  })

  it('returns null for empty buffer', () => {
    expect(personAtomIdsJsonFromBuffer(Buffer.alloc(0))).toBe(null)
  })

  it("returns '[]' for a parseable scene with no atoms", () => {
    const buf = Buffer.from(JSON.stringify({ atoms: [] }))
    expect(personAtomIdsJsonFromBuffer(buf)).toBe('[]')
  })

  it("returns '[]' for a parseable scene with no Person atoms", () => {
    const buf = Buffer.from(JSON.stringify({ atoms: [{ id: 'A', type: 'Cube' }] }))
    expect(personAtomIdsJsonFromBuffer(buf)).toBe('[]')
  })

  it('returns the Person atom ids array for a parseable scene', () => {
    const buf = Buffer.from(
      JSON.stringify({
        atoms: [
          { id: 'Person', type: 'Person' },
          { id: 'Cube', type: 'Cube' },
          { id: 'Person#2', type: 'Person' },
        ],
      }),
    )
    expect(personAtomIdsJsonFromBuffer(buf)).toBe('["Person","Person#2"]')
  })

  it('returns null for malformed JSON (was previously empty array — partial-read distinction)', () => {
    const buf = Buffer.from('{ "atoms": [ ... not valid json ')
    expect(personAtomIdsJsonFromBuffer(buf)).toBe(null)
  })

  it('returns null for binary garbage', () => {
    expect(personAtomIdsJsonFromBuffer(Buffer.alloc(2048, 0xff))).toBe(null)
  })

  it('rewrites SELF:/ when packageFilename is given', () => {
    const buf = Buffer.from(
      JSON.stringify({
        atoms: [{ id: 'Person', type: 'Person', storables: [{ ref: 'SELF:/foo' }] }],
      }),
    )
    expect(personAtomIdsJsonFromBuffer(buf, 'Author.Pkg.3.var')).toBe('["Person"]')
  })
})
