import { join, dirname } from 'path'
import { readFile, access, writeFile, mkdir } from 'fs/promises'
import { constants } from 'fs'
import { createHash } from 'crypto'
import { isLocalPackage } from '../shared/local-package.js'
import { app } from 'electron'
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

function getThumbCacheDir() {
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

// Per-content (ct:) thumbs share a `.var` filename namespace with the package
// thumb, so we suffix with a sha1 of the internal path. 16 hex chars is plenty
// — collision space is per-archive, not global.
function ctCacheFilename(packageFilename, internalPath) {
  const hash = createHash('sha1').update(internalPath).digest('hex').slice(0, 16)
  return packageFilename + '__' + hash + '.jpg'
}

async function persistVarThumb(thumbCacheDir, filename, buf) {
  if (!buf?.length) return
  try {
    await ensureThumbCacheDir(thumbCacheDir)
    await writeFile(join(thumbCacheDir, filename + '.jpg'), buf)
  } catch {}
}

async function persistCtThumb(thumbCacheDir, packageFilename, internalPath, buf) {
  if (!buf?.length) return
  try {
    await ensureThumbCacheDir(thumbCacheDir)
    await writeFile(join(thumbCacheDir, ctCacheFilename(packageFilename, internalPath)), buf)
  } catch {}
}

/**
 * Drop specific keys from the in-memory thumbnail buffer cache so the next
 * `getThumbnails` call re-reads from disk (or re-extracts). Used by
 * thumb-resolver after it writes a fresh Hub thumbnail to `thumb-cache/`, so
 * the previously cached fallback (internal .var thumb or null) isn't served.
 */
export function invalidateThumbnailCache(keys) {
  if (!keys?.length) return
  for (const key of keys) cache.delete(key)
}

export async function getThumbnails(keys) {
  const vamDir = getSetting('vam_dir')
  if (!vamDir) return {}
  const thumbCacheDir = getThumbCacheDir()
  const results = {}

  const setKey = (key, buf) => {
    const v = buf || null
    cache.set(key, v)
    results[key] = v
  }

  // First pass: serve cache hits, classify the rest into job buckets. Group
  // ct: keys by varPath so one yauzl open extracts every needed thumb from a
  // given archive.
  const pkgJobs = []
  const ctLooseJobs = []
  const varExtractions = new Map()

  for (const key of keys) {
    if (cache.has(key)) {
      touchLru(key)
      results[key] = cache.get(key)
      continue
    }

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

  const limit = pLimit(THUMB_CONCURRENCY)

  const pkgPromises = pkgJobs.map(({ key, filename }) =>
    limit(async () => {
      // Resolve once per job so a missing/aux-relocated package contributes a
      // null thumb rather than throwing. Companion .jpg lives next to the
      // current physical .var (could be aux dir or `.var.disabled` in main).
      const varPath = resolveVarPath(filename)

      // 1. Companion .jpg next to the .var (always named with .var stem, never .disabled)
      let buf = null
      if (varPath) {
        buf = await tryReadFile(join(dirname(varPath), filename.replace(/\.var$/i, '.jpg')))
      }
      // 2. Hub thumbnail cache (also where persistVarThumb writes to)
      if (!buf) buf = await tryReadFile(join(thumbCacheDir, filename + '.jpg'))
      // 3. First content thumbnail from inside the .var (may be .var.disabled on disk)
      if (!buf && varPath) {
        const internalPath = getContentThumbnailPath(filename)
        if (internalPath) {
          try {
            buf = await extractFile(varPath, internalPath)
          } catch {}
          // Race-free gating: only persist when this package isn't on the Hub.
          // If hub_resource_id is set, thumb-resolver owns the same path and
          // will overwrite with a CDN thumb; we step aside. If unset, the
          // resolver early-outs and leaves the path to us forever.
          if (buf && !getPackageIndex().get(filename)?.hub_resource_id) {
            void persistVarThumb(thumbCacheDir, filename, buf)
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

  await Promise.all([...pkgPromises, ...ctLoosePromises, ...varPromises])

  evict()
  return results
}
