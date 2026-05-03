import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { writeFile, unlink, appendFile } from 'fs/promises'
import { mkTempVamDir, buildVar, placeVar } from '../../test/fixtures/index.js'
import { awaitStable, verifyZipFile, __resetInFlightForTests } from './var-stability.js'

let tmp
beforeEach(async () => {
  tmp = await mkTempVamDir()
  __resetInFlightForTests()
})
afterEach(async () => {
  vi.useRealTimers()
  if (tmp) await tmp.cleanup()
})

describe('verifyZipFile', () => {
  it('resolves for a valid .var', async () => {
    const buf = await buildVar({ meta: { packageName: 'A.B', creator: 'A' } })
    const path = await placeVar(tmp.addonPackages, 'A.B.1.var', buf)
    await expect(verifyZipFile(path)).resolves.toBeUndefined()
  })

  it('rejects for a truncated file', async () => {
    const buf = await buildVar({ meta: { packageName: 'A.B', creator: 'A' } })
    const path = join(tmp.addonPackages, 'trunc.var')
    await writeFile(path, buf.subarray(0, Math.floor(buf.length / 2)))
    await expect(verifyZipFile(path)).rejects.toBeDefined()
  })

  it('rejects for garbage content', async () => {
    const path = join(tmp.addonPackages, 'garbage.var')
    await writeFile(path, Buffer.alloc(2048, 0xff))
    await expect(verifyZipFile(path)).rejects.toBeDefined()
  })

  it('rejects for missing file', async () => {
    await expect(verifyZipFile(join(tmp.addonPackages, 'no-such.var'))).rejects.toBeDefined()
  })
})

describe('awaitStable', () => {
  it('returns true immediately for an already-valid .var', async () => {
    const buf = await buildVar({ meta: { packageName: 'A.B', creator: 'A' } })
    const path = await placeVar(tmp.addonPackages, 'A.B.1.var', buf)
    const t0 = Date.now()
    await expect(awaitStable(path)).resolves.toBe(true)
    expect(Date.now() - t0).toBeLessThan(500) // fast path, no polling
  })

  it('returns false for a non-existent path within timeout', async () => {
    // Polling path: verifyZip rejects (ENOENT), then stat rejects on the first poll
    // tick → bails out. Ought to return false within ~POLL_INTERVAL_MS + slack.
    const path = join(tmp.addonPackages, 'no-such.var')
    const t0 = Date.now()
    await expect(awaitStable(path)).resolves.toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('returns false for a permanently broken file', async () => {
    // verifyZip rejects, polling sees stable garbage, re-tries verifyZip after
    // STABILITY_MS, still fails → returns false. Just smoke-test that it
    // resolves to false; the 2s+ wait is real but bounded.
    const path = join(tmp.addonPackages, 'broken.var')
    await writeFile(path, Buffer.alloc(2048, 0xff))
    await expect(awaitStable(path)).resolves.toBe(false)
  }, 10_000)

  it('returns true after a growing file finishes (polling path)', async () => {
    const buf = await buildVar({ meta: { packageName: 'Grow.G', creator: 'G' } })
    const path = join(tmp.addonPackages, 'grow.var')
    // Write the first half so verifyZip rejects; the awaiter enters polling.
    const half = Math.floor(buf.length / 2)
    await writeFile(path, buf.subarray(0, half))

    // Start the awaiter, then append the rest after a few hundred ms so the
    // polling sees the size change first (resets stability), then a quiet period,
    // then verifyZip succeeds.
    const pending = awaitStable(path)
    setTimeout(() => {
      appendFile(path, buf.subarray(half)).catch(() => {})
    }, 400)

    await expect(pending).resolves.toBe(true)
  }, 10_000)

  it('dedupes concurrent calls for the same path', async () => {
    const buf = await buildVar({ meta: { packageName: 'Dedup.D', creator: 'D' } })
    const path = await placeVar(tmp.addonPackages, 'Dedup.D.1.var', buf)
    const [a, b, c] = await Promise.all([awaitStable(path), awaitStable(path), awaitStable(path)])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(c).toBe(true)
  })

  it('returns false if the file disappears mid-poll', async () => {
    // Write a broken file so verifyZip rejects and we enter polling, then
    // unlink it so the next stat() fails → false.
    const path = join(tmp.addonPackages, 'vanish.var')
    await writeFile(path, Buffer.alloc(2048, 0xff))
    const pending = awaitStable(path)
    setTimeout(() => {
      unlink(path).catch(() => {})
    }, 100)
    await expect(pending).resolves.toBe(false)
  }, 5000)
})
