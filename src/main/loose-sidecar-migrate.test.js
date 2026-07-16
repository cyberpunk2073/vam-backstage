import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkTempVamDir } from '../../test/fixtures/index.js'
import { normalizeExtractedSidecars } from './loose-sidecar-migrate.js'

let tmp

beforeEach(async () => {
  tmp = await mkTempVamDir()
})

afterEach(async () => {
  if (tmp) await tmp.cleanup()
})

const DIR = 'Custom/Atom/Person/Appearance/extracted'
const CLOTHING = 'Custom/Atom/Person/Clothing/extracted'

async function touch(rel) {
  const abs = join(tmp.vamDir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, '')
}

const has = (rel) => existsSync(join(tmp.vamDir, rel))

describe('normalizeExtractedSidecars', () => {
  it('folds legacy .disabled sidecars onto the canonical stem, leaving the .vap marker alone', async () => {
    await touch(`${DIR}/A.vap.disabled`) // disabled content file — must stay put
    await touch(`${DIR}/A.vap.disabled.fav`)
    await touch(`${DIR}/A.vap.disabled.hide`)

    expect(normalizeExtractedSidecars(tmp.vamDir)).toBe(2)

    expect(has(`${DIR}/A.vap.fav`)).toBe(true)
    expect(has(`${DIR}/A.vap.hide`)).toBe(true)
    expect(has(`${DIR}/A.vap.disabled.fav`)).toBe(false)
    expect(has(`${DIR}/A.vap.disabled.hide`)).toBe(false)
    expect(has(`${DIR}/A.vap.disabled`)).toBe(true)
  })

  it('drops the legacy sidecar when a canonical one already exists', async () => {
    await touch(`${DIR}/B.vap.fav`)
    await touch(`${DIR}/B.vap.disabled.fav`)

    expect(normalizeExtractedSidecars(tmp.vamDir)).toBe(1)

    expect(has(`${DIR}/B.vap.fav`)).toBe(true)
    expect(has(`${DIR}/B.vap.disabled.fav`)).toBe(false)
  })

  it('normalizes both the appearance and clothing extracted dirs', async () => {
    await touch(`${DIR}/A.vap.disabled.fav`)
    await touch(`${CLOTHING}/C.vap.disabled.hide`)

    expect(normalizeExtractedSidecars(tmp.vamDir)).toBe(2)

    expect(has(`${DIR}/A.vap.fav`)).toBe(true)
    expect(has(`${CLOTHING}/C.vap.hide`)).toBe(true)
  })

  it('is a no-op for already-canonical sidecars and when dirs are absent', async () => {
    await touch(`${DIR}/D.vap.fav`)

    expect(normalizeExtractedSidecars(tmp.vamDir)).toBe(0)
    expect(has(`${DIR}/D.vap.fav`)).toBe(true)

    expect(normalizeExtractedSidecars(undefined)).toBe(0)
  })
})
