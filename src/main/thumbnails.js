import { join, dirname } from 'path'
import { readFile, access, writeFile, mkdir, unlink } from 'fs/promises'
import { constants } from 'fs'
import { createHash } from 'crypto'
import { isLocalPackage } from '@shared/local-package.js'
import { hubResourceIconUrl } from '@shared/hub-http.js'
import { app, net, nativeImage } from 'electron'
import { getSetting, getContentThumbnailPath } from './db.js'
import { extractFile, extractFiles } from './scanner/var-reader.js'
import { getPackageIndex } from './store.js'
import { pLimit } from './p-limit.js'
import { pkgVarPath } from './library-dirs.js'

const MAX_ENTRIES = 3000
// Bounded concurrency for thumbnail jobs (companion-jpg reads, loose ct: reads,
// yauzl `.var` opens). 2× the default libuv worker pool (4) gives burst
// headroom without queue padding; sequential awaits on a 50-card cold batch
// otherwise gate the renderer on whichever single archive is slowest under AV.
const THUMB_CONCURRENCY = 8
/** Side length of dependency-graph point tiles (matches renderer atlas). */
const GRAPH_THUMB_PX = 64
/** nativeImage.resize is sync — one at a time, then yield so IPC can pump. */
const GRAPH_RESIZE_YIELD_EVERY = 8
/** Full-res → tile in chunks so getThumbnails never holds the whole library at once. */
const GRAPH_RESIZE_CHUNK = 200
/** Parallel reads of already-resized graph tiles from disk. */
const GRAPH_TILE_READ_CONCURRENCY = 32
const cache = new Map()

function touchLru(key) {
  if (!cache.has(key)) return
  const val = cache.get(key)
  cache.delete(key)
  cache.set(key, val)
}

function evict() {
  if (cache.size <= MAX_ENTRIES) return
  const toDelete = Math.floor(MAX_ENTRIES * 0.2)
  const iter = cache.keys()
  for (let i = 0; i < toDelete; i++) cache.delete(iter.next().value)
}

export function getThumbCacheDir() {
  return join(app.getPath('userData'), 'thumb-cache')
}

async function tryReadFile(filePath) {
  try {
    await access(filePath, constants.R_OK)
    return await readFile(filePath)
  } catch {
    return null
  }
}

function resolveVarPath(filename) {
  const pkg = getPackageIndex().get(filename)
  return pkgVarPath(pkg) ?? null
}

// Persist extracted thumbnails to thumb-cache/ so subsequent launches read a
// small JPEG from disk instead of re-opening yauzl archives. The 110 s cold
// startup that motivated this work was unrelated, but cold-launch thumb
// trickle on Windows + Defender (multi-GB .var, slow open) can add tens of
// seconds to first paint; persisting once amortizes that across runs.
let cacheDirEnsured = false
async function ensureThumbCacheDir(thumbCacheDir) {
  if (cacheDirEnsured) return
  try {
    await mkdir(thumbCacheDir, { recursive: true })
    cacheDirEnsured = true
  } catch {}
}

// Per-content thumbs share a `.var` filename namespace with the package thumb,
// so we suffix with a sha1 of the internal path. 16 hex chars is plenty —
// collision space is per-archive, not global. The package card's own thumb is
// just its representative content thumb, so it reuses this same entry.
export function ctCacheFilename(packageFilename, internalPath) {
  const hash = createHash('sha1').update(internalPath).digest('hex').slice(0, 16)
  return packageFilename + '__' + hash + '.jpg'
}

// A Hub resource's CDN icon, keyed by resource id. Shared by installed packages
// (via hub_resource_id, written by thumb-resolver) and wishlist cards (which
// have no local `.var` name) — one file serves either view.
export function hubIconCacheFile(thumbCacheDir, rid) {
  return join(thumbCacheDir, `hub-icon-${rid}.jpg`)
}

/**
 * Resolve a wishlist resource thumbnail: disk cache first, then a CDN fetch on
 * miss (persisted for next time). `imageUrl` is the snapshot's own `image_url`
 * when known; otherwise the URL is derived from the resource id. Returns the
 * JPEG buffer or null. Never throws.
 */
async function getHubResThumb(thumbCacheDir, rid, imageUrl) {
  const file = hubIconCacheFile(thumbCacheDir, rid)
  let buf = await tryReadFile(file)
  if (buf) return buf
  const url = imageUrl || hubResourceIconUrl(rid)
  if (!url) return null
  try {
    const res = await net.fetch(url)
    if (!res.ok) return null
    buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    await ensureThumbCacheDir(thumbCacheDir)
    await writeFile(file, buf)
    return buf
  } catch {
    return null
  }
}

/**
 * Proactively cache a wishlist resource's thumbnail (fire-and-forget from
 * `wishlist:add`) so it survives the resource later disappearing from the Hub.
 */
export async function prefetchHubResThumbnail(rid, imageUrl) {
  const thumbCacheDir = getThumbCacheDir()
  await getHubResThumb(thumbCacheDir, String(rid), imageUrl)
}

async function persistCtThumb(thumbCacheDir, packageFilename, internalPath, buf) {
  if (!buf?.length) return
  try {
    await ensureThumbCacheDir(thumbCacheDir)
    await writeFile(join(thumbCacheDir, ctCacheFilename(packageFilename, internalPath)), buf)
  } catch {}
}

/** On-disk path for a 64×64 graph tile derived from a full thumbnail key. */
function graphTilePath(thumbCacheDir, key) {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16)
  return join(thumbCacheDir, 'graph64', `${hash}.jpg`)
}

/**
 * Drop specific keys from the in-memory thumbnail buffer cache so the next
 * `getThumbnails` call re-reads from disk (or re-extracts). Used by
 * thumb-resolver after it writes a fresh Hub thumbnail to `thumb-cache/`, so
 * the previously cached fallback (internal .var thumb or null) isn't served.
 * Also drops derived graph64 tiles so the next graph open rebuilds from the
 * fresh full-size image.
 */
export function invalidateThumbnailCache(keys) {
  if (!keys?.length) return
  const thumbCacheDir = getThumbCacheDir()
  for (const key of keys) {
    cache.delete(key)
    void unlink(graphTilePath(thumbCacheDir, key)).catch(() => {})
  }
}

/**
 * Resize a full JPEG/PNG buffer to a square graph tile via Electron's
 * nativeImage (no extra native deps). Sync work — callers must yield between
 * batches so the message pump stays responsive.
 */
function resizeToGraphTile(buf) {
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  return img.resize({ width: GRAPH_THUMB_PX, height: GRAPH_THUMB_PX, quality: 'better' }).toJPEG(75)
}

const yieldToEventLoop = () => new Promise((r) => setImmediate(r))

/**
 * Bulk thumbnails for the dependency graph: 64×64 JPEGs from `thumb-cache/graph64/`,
 * built on demand from the normal full-size thumbnail pipeline. Warm hits are
 * tiny IPC payloads; cold misses resize in chunks, yielding so main stays free.
 *
 * @param {string[]} keys Same keys as `getThumbnails` (`pkg:…`, etc.)
 * @returns {Promise<Record<string, Buffer|null>>}
 */
export async function getGraphThumbnails(keys) {
  if (!keys?.length) return {}
  const thumbCacheDir = getThumbCacheDir()
  const graphDir = join(thumbCacheDir, 'graph64')
  await ensureThumbCacheDir(thumbCacheDir)
  try {
    await mkdir(graphDir, { recursive: true })
  } catch {}

  const results = {}
  const misses = []
  const readLimit = pLimit(GRAPH_TILE_READ_CONCURRENCY)
  await Promise.all(
    keys.map((key) =>
      readLimit(async () => {
        const buf = await tryReadFile(graphTilePath(thumbCacheDir, key))
        if (buf) results[key] = buf
        else misses.push(key)
      }),
    ),
  )
  if (misses.length === 0) return results

  for (let i = 0; i < misses.length; i += GRAPH_RESIZE_CHUNK) {
    const chunk = misses.slice(i, i + GRAPH_RESIZE_CHUNK)
    const full = await getThumbnails(chunk)
    let sinceYield = 0
    for (const key of chunk) {
      const src = full[key]
      if (!src?.length) {
        results[key] = null
        continue
      }
      try {
        const tile = resizeToGraphTile(src)
        results[key] = tile
        if (tile) void writeFile(graphTilePath(thumbCacheDir, key), tile).catch(() => {})
      } catch {
        results[key] = null
      }
      sinceYield++
      if (sinceYield >= GRAPH_RESIZE_YIELD_EVERY) {
        sinceYield = 0
        await yieldToEventLoop()
      }
    }
  }
  return results
}

export async function getThumbnails(keys) {
  const thumbCacheDir = getThumbCacheDir()
  const results = {}

  const setKey = (key, buf) => {
    const v = buf || null
    cache.set(key, v)
    results[key] = v
  }

  const limit = pLimit(THUMB_CONCURRENCY)

  // hub-icon:{rid} keys are keyed by hub resource id and hit only the disk cache /
  // CDN — they don't depend on the local library, so resolve them regardless of
  // whether vam_dir is configured (and before the guard below).
  const hubResJobs = []
  const otherKeys = []
  for (const key of keys) {
    if (cache.has(key)) {
      touchLru(key)
      results[key] = cache.get(key)
      continue
    }
    if (key.startsWith('hub-icon:')) hubResJobs.push({ key, rid: key.slice(9) })
    else otherKeys.push(key)
  }

  const hubResPromises = hubResJobs.map(({ key, rid }) =>
    limit(async () => {
      setKey(key, await getHubResThumb(thumbCacheDir, rid))
    }),
  )

  const vamDir = getSetting('vam_dir')
  if (!vamDir) {
    await Promise.all(hubResPromises)
    return results
  }

  // First pass: classify the remaining (library) keys into job buckets. Group
  // ct: keys by varPath so one yauzl open extracts every needed thumb from a
  // given archive.
  const pkgJobs = []
  const ctLooseJobs = []
  const varExtractions = new Map()

  for (const key of otherKeys) {
    if (key.startsWith('pkg:')) {
      const filename = key.slice(4)
      if (isLocalPackage(filename)) {
        // No companion .var or hub thumbnail; loose content has no aggregate package thumb.
        setKey(key, null)
        continue
      }
      pkgJobs.push({ key, filename })
    } else if (key.startsWith('ct:')) {
      // ct:{packageFilename}\0{thumbnailPath}
      const sep = key.indexOf('\0', 3)
      if (sep < 0) {
        results[key] = null
        continue
      }
      const filename = key.slice(3, sep)
      const thumbPath = key.slice(sep + 1)
      if (!thumbPath) {
        setKey(key, null)
        continue
      }
      if (isLocalPackage(filename)) {
        ctLooseJobs.push({ key, fullPath: join(vamDir, thumbPath) })
        continue
      }
      const varPath = resolveVarPath(filename)
      if (!varPath) {
        setKey(key, null)
        continue
      }
      let group = varExtractions.get(varPath)
      if (!group) {
        group = { filename, items: [] }
        varExtractions.set(varPath, group)
      }
      group.items.push({ key, internalPath: thumbPath })
    }
  }

  const pkgPromises = pkgJobs.map(({ key, filename }) =>
    limit(async () => {
      // Resolve the package once (a missing/aux-relocated one contributes a null
      // thumb rather than throwing). Companion .jpg lives next to the current
      // physical .var (could be aux dir or `.var.disabled` in main).
      const pkg = getPackageIndex().get(filename)
      const varPath = pkgVarPath(pkg) ?? null

      // 1. Companion .jpg next to the .var (always named with .var stem, never .disabled)
      let buf = null
      if (varPath) {
        buf = await tryReadFile(join(dirname(varPath), filename.replace(/\.var$/i, '.jpg')))
      }
      // 2. Hub CDN icon (resolved by thumb-resolver), keyed by resource id and
      //    shared with wishlist cards for the same resource.
      if (!buf && pkg?.hub_resource_id) {
        buf = await tryReadFile(hubIconCacheFile(thumbCacheDir, pkg.hub_resource_id))
      }
      // 3. Representative content thumb from inside the .var. It's the same image
      //    (and same cache entry) a content card uses, so package and content
      //    views share one file — no Hub gating needed, the icon lives under a
      //    separate name.
      if (!buf) {
        const internalPath = getContentThumbnailPath(filename)
        if (internalPath) {
          buf = await tryReadFile(join(thumbCacheDir, ctCacheFilename(filename, internalPath)))
          if (!buf && varPath) {
            try {
              buf = await extractFile(varPath, internalPath)
            } catch {}
            if (buf) void persistCtThumb(thumbCacheDir, filename, internalPath, buf)
          }
        }
      }
      setKey(key, buf)
    }),
  )

  const ctLoosePromises = ctLooseJobs.map(({ key, fullPath }) =>
    limit(async () => {
      const buf = await tryReadFile(fullPath)
      setKey(key, buf)
    }),
  )

  const varPromises = [...varExtractions.entries()].map(([varPath, group]) =>
    limit(async () => {
      const { filename, items } = group
      // Disk-cache lookup first: any item whose extracted thumb is already
      // persisted skips yauzl. If every item is cached, the .var never opens.
      const cacheReads = await Promise.all(
        items.map((it) => tryReadFile(join(thumbCacheDir, ctCacheFilename(filename, it.internalPath)))),
      )
      const need = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const cached = cacheReads[i]
        if (cached) setKey(it.key, cached)
        else need.push(it)
      }
      if (need.length === 0) return
      try {
        const paths = need.map((i) => i.internalPath)
        const extracted = await extractFiles(varPath, paths)
        for (const { key, internalPath } of need) {
          const buf = extracted.get(internalPath) || null
          setKey(key, buf)
          if (buf) void persistCtThumb(thumbCacheDir, filename, internalPath, buf)
        }
      } catch {
        for (const { key } of need) setKey(key, null)
      }
    }),
  )

  await Promise.all([...hubResPromises, ...pkgPromises, ...ctLoosePromises, ...varPromises])

  evict()
  return results
}
