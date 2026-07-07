import { existsSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getSetting, setSetting, getContentThumbnailPath, getAllPackageHubIds } from './db.js'
import { getThumbCacheDir, ctCacheFilename, hubIconCacheFile } from './thumbnails.js'

// Bump when the on-disk thumb-cache naming changes; the migration runs once per
// bump. Layout 1 unified Hub icons under hub-icon-{rid}.jpg (shared by installed
// packages and wishlist cards) and folded the package thumb into the content-
// thumb scheme, retiring the old {filename}.jpg files.
const THUMB_CACHE_LAYOUT = 1

// A content thumb is `{filename}__{16 hex}.jpg`; any other .jpg that isn't
// already a hub icon is a legacy package thumb (`{filename}.jpg`).
const CONTENT_THUMB_RE = /__[0-9a-f]{16}\.jpg$/

// Move src onto dst, or just drop src when dst already holds the (identical) image.
function relocate(src, dst) {
  if (existsSync(dst)) unlinkSync(src)
  else renameSync(src, dst)
}

/**
 * One-time relocation of the legacy `{filename}.jpg` package thumbnails into the
 * unified layout: Hub packages move to hub-icon-{rid}.jpg (versions sharing a
 * resource collapse to one file, reclaiming space); non-hub packages fold into
 * their representative content-thumb entry; orphans are dropped. Best-effort and
 * idempotent — a locked/failed file is skipped and re-derived on demand, and a
 * partial run re-runs harmlessly (the flag only advances once we reach the end).
 *
 * A fresh install has no cache dir, so this is a no-op that just stamps the flag.
 * Runs synchronously right after openDatabase(), before any thumbnail is served,
 * so the hot path never has to know the legacy name.
 */
export function migrateThumbCacheLayout() {
  if (Number(getSetting('thumb_cache_layout') || 0) >= THUMB_CACHE_LAYOUT) return

  const dir = getThumbCacheDir()
  let names
  try {
    names = readdirSync(dir)
  } catch {
    names = [] // no cache dir yet (fresh install) — nothing to migrate
  }

  const legacy = names.filter((n) => n.endsWith('.jpg') && !n.startsWith('hub-icon-') && !CONTENT_THUMB_RE.test(n))
  if (legacy.length > 0) {
    const ridByFilename = new Map()
    for (const row of getAllPackageHubIds()) ridByFilename.set(row.filename, row.hub_resource_id)

    for (const name of legacy) {
      const filename = name.slice(0, -4) // strip .jpg → the .var filename
      const src = join(dir, name)
      try {
        if (!ridByFilename.has(filename)) {
          unlinkSync(src) // orphan: package no longer installed
          continue
        }
        const rid = ridByFilename.get(filename)
        if (rid) {
          relocate(src, hubIconCacheFile(dir, rid))
        } else {
          const reprPath = getContentThumbnailPath(filename)
          if (reprPath) relocate(src, join(dir, ctCacheFilename(filename, reprPath)))
          else unlinkSync(src) // no representative content thumb → drop, re-extract lazily
        }
      } catch {}
    }
  }

  setSetting('thumb_cache_layout', String(THUMB_CACHE_LAYOUT))
}
