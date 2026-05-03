/**
 * Stability gate for `.var` files seen by the watcher.
 *
 * Replaces chokidar's `awaitWriteFinish` (which stat-polled every observed file
 * on the libuv pool, serializing our own bulk renames). Strategy is two-tier:
 *
 * 1. Try `verifyZip` immediately. A `.var` is a zip with EOCD written last —
 *    if yauzl can iterate the central directory, the file is structurally
 *    complete. Atomic-rename writers (most downloaders, our own
 *    `rename(tempPath, finalPath)`) hit this on the first event with zero wait.
 *
 * 2. If `verifyZip` rejects, fall back to stat-polling. Re-attempt `verifyZip`
 *    on each tick where `(size, mtime)` is unchanged for `STABILITY_MS`.
 *    Resolve when the zip parses (file finished arriving and is valid),
 *    return false on disappearance or after `MAX_WAIT_MS`.
 *
 * Concurrent calls for the same path share one in-flight check via `inFlight`.
 */

import { stat } from 'fs/promises'
import yauzl from 'yauzl'

const POLL_INTERVAL_MS = 300
const STABILITY_MS = 2000 // matches chokidar's default `awaitWriteFinish.stabilityThreshold`
// Outer safety cap on the polling loop. Only matters for the pathological
// "file keeps growing forever" case — every "really done" outcome (stat fails,
// or stat settles for STABILITY_MS and verifyZip resolves/rejects) exits the
// loop earlier on its own. 24h gives multi-gig downloads on slow or paused
// links enough headroom (4 GB at 50 KB/s ≈ 22h) without leaking the in-flight
// promise indefinitely.
const MAX_WAIT_MS = 24 * 60 * 60 * 1000

/** @type {Map<string, Promise<boolean>>} */
const inFlight = new Map()

/**
 * Quick structural integrity check — opens the ZIP central directory and
 * iterates all entries. Resolves on success, rejects on any I/O or parse
 * error (incl. file-too-short, missing EOCD, garbage CD).
 */
export function verifyZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err)
      zipfile.readEntry()
      zipfile.on('entry', () => zipfile.readEntry())
      zipfile.on('end', () => resolve())
      zipfile.on('error', reject)
    })
  })
}

/**
 * Returns true once the file at `filePath` is a valid zip (EOCD + CD parse),
 * false on disappearance or timeout.
 *
 * Safe to call multiple times concurrently for the same path — duplicates
 * dedupe to a single in-flight check.
 */
export function awaitStable(filePath) {
  const existing = inFlight.get(filePath)
  if (existing) return existing
  const p = run(filePath).finally(() => inFlight.delete(filePath))
  inFlight.set(filePath, p)
  return p
}

async function run(filePath) {
  try {
    await verifyZipFile(filePath)
    return true
  } catch {
    // Fall through to polling.
  }

  const startedAt = Date.now()
  let lastSize = -1
  let lastMtime = -1
  let stableSince = 0

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS)
    let s
    try {
      s = await stat(filePath)
    } catch {
      return false
    }
    const now = Date.now()
    if (s.size === lastSize && s.mtimeMs === lastMtime) {
      if (stableSince === 0) stableSince = now
      if (now - stableSince >= STABILITY_MS) {
        try {
          await verifyZipFile(filePath)
          return true
        } catch {
          // Stat is settled but the zip won't parse — file is genuinely broken.
          // Caller's scanner will record it as unreadable. Don't keep polling.
          return false
        }
      }
    } else {
      lastSize = s.size
      lastMtime = s.mtimeMs
      stableSince = 0
    }
  }
  return false
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Test seam — clears the in-flight dedupe map between cases. */
export function __resetInFlightForTests() {
  inFlight.clear()
}
