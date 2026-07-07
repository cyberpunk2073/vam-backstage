import { app, net } from 'electron'
import { join } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { getPackagesNeedingThumbnail, setPackageThumbnail, setHubResourceId } from './db.js'
import { getPackagesIndex } from './hub/packages-json.js'
import { notify } from './notify.js'
import { pLimit } from './p-limit.js'
import { invalidateThumbnailCache, hubIconCacheFile } from './thumbnails.js'
import { hubResourceIconUrl } from '@shared/hub-http.js'

const CDN_CONCURRENCY = 20
const PROGRESS_NOTIFY_EVERY = 25

let running = false

function getCacheDir() {
  return join(app.getPath('userData'), 'thumb-cache')
}

/**
 * Resolve Hub thumbnails for every package that doesn't already have one cached.
 * Failures aren't "remembered" — we retry on every call, so transient CDN errors
 * and later-appearing Hub entries get picked up naturally.
 * While a fetch is in flight (or after a miss) the UI falls back to the internal
 * .var thumbnail via src/main/thumbnails.js, so the user always sees something.
 * Fire-and-forget — safe to call from anywhere.
 */
export async function resolvePackageThumbnails() {
  if (running) return
  running = true

  try {
    const pending = getPackagesNeedingThumbnail()
    if (pending.length === 0) return

    const cacheDir = getCacheDir()
    await mkdir(cacheDir, { recursive: true })

    // Fill in missing resource IDs from the in-memory CDN index (no network call).
    // Anything we can't resolve here is simply skipped this run — no permanent flag.
    const cdnIndex = getPackagesIndex()
    if (cdnIndex) {
      for (const p of pending) {
        if (p.hub_resource_id) continue
        const entry = cdnIndex.get(p.package_name)
        if (entry?.resourceId) {
          p.hub_resource_id = String(entry.resourceId)
          setHubResourceId(p.filename, p.hub_resource_id)
        }
      }
    }

    // The icon is per-resource, so group versions that share a resource id: one
    // fetch and one hub-icon-{rid}.jpg file serves every installed version (and
    // any wishlist card for the same resource).
    const byRid = new Map()
    for (const p of pending) {
      if (!p.hub_resource_id) continue
      const rid = String(p.hub_resource_id)
      const group = byRid.get(rid)
      if (group) group.push(p)
      else byRid.set(rid, [p])
    }

    // CDN can handle heavy parallelism, so we don't throttle like the Hub JSON API.
    const limit = pLimit(CDN_CONCURRENCY)
    // Keys resolved since the last notify — flushed in batches so the UI can
    // invalidate exactly the stale entries (main-side buffer cache + renderer
    // blob cache) instead of only null entries.
    let pendingBatch = []
    const flushBatch = () => {
      if (pendingBatch.length === 0) return
      const keys = pendingBatch
      pendingBatch = []
      invalidateThumbnailCache(keys)
      notify('thumbnails:updated', { keys })
    }
    await Promise.all(
      [...byRid.entries()].map(([rid, pkgs]) =>
        limit(async () => {
          const imageUrl = hubResourceIconUrl(rid)
          if (!imageUrl) return
          try {
            const res = await net.fetch(imageUrl)
            if (!res.ok) return
            const buf = Buffer.from(await res.arrayBuffer())
            await writeFile(hubIconCacheFile(cacheDir, rid), buf)
            for (const pkg of pkgs) {
              setPackageThumbnail(pkg.filename, imageUrl)
              pendingBatch.push('pkg:' + pkg.filename)
            }
            if (pendingBatch.length >= PROGRESS_NOTIFY_EVERY) flushBatch()
          } catch {}
        }),
      ),
    )

    flushBatch()
  } finally {
    running = false
  }
}
