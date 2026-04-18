import { app } from 'electron'
import { join } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { getPackagesNeedingThumbnail, setPackageThumbnail, setHubResourceId } from './db.js'
import { getPackagesIndex } from './hub/packages-json.js'
import { notify } from './notify.js'
import { pLimit } from './p-limit.js'
import { invalidateThumbnailCache } from './thumbnails.js'

const IMAGE_CDN = 'https://1424104733.rsc.cdn77.org/data/resource_icons'
const CDN_CONCURRENCY = 20
const PROGRESS_NOTIFY_EVERY = 25

let running = false

function getCacheDir() {
  return join(app.getPath('userData'), 'thumb-cache')
}

function imageUrlForResource(resourceId) {
  const rid = Number(resourceId)
  return `${IMAGE_CDN}/${Math.floor(rid / 1000)}/${rid}.jpg`
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
      pending.map((pkg) =>
        limit(async () => {
          if (!pkg.hub_resource_id) return
          try {
            const imageUrl = imageUrlForResource(pkg.hub_resource_id)
            const res = await fetch(imageUrl)
            if (!res.ok) return
            const buf = Buffer.from(await res.arrayBuffer())
            await writeFile(join(cacheDir, pkg.filename + '.jpg'), buf)
            setPackageThumbnail(pkg.filename, imageUrl)
            pendingBatch.push('pkg:' + pkg.filename)
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
