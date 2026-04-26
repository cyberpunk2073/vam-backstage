import { join } from 'path'
import { readFile, access } from 'fs/promises'
import { constants } from 'fs'
import { ADDON_PACKAGES } from '../shared/paths.js'
import { isLocalPackage } from '../shared/local-package.js'
import { app } from 'electron'
import { getSetting, getContentThumbnailPath } from './db.js'
import { extractFile, extractFiles } from './scanner/var-reader.js'
import { getPackageIndex } from './store.js'

const MAX_ENTRIES = 3000
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

function resolveVarPath(addonDir, filename) {
  const pkg = getPackageIndex().get(filename)
  return join(addonDir, !pkg || pkg.is_enabled ? filename : filename + '.disabled')
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
  const addonDir = join(vamDir, ADDON_PACKAGES)
  const thumbCacheDir = getThumbCacheDir()
  const results = {}

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
        cache.set(key, null)
        results[key] = null
        continue
      }

      // 1. Companion .jpg next to the .var (always named with .var stem, never .disabled)
      let buf = await tryReadFile(join(addonDir, filename.replace(/\.var$/i, '.jpg')))

      // 2. Hub thumbnail cache
      if (!buf) buf = await tryReadFile(join(thumbCacheDir, filename + '.jpg'))

      // 3. First content thumbnail from inside the .var (may be .var.disabled on disk)
      if (!buf) {
        const internalPath = getContentThumbnailPath(filename)
        if (internalPath) {
          try {
            buf = await extractFile(resolveVarPath(addonDir, filename), internalPath)
          } catch {}
        }
      }

      cache.set(key, buf || null)
      results[key] = buf || null
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
        cache.set(key, null)
        results[key] = null
        continue
      }
      if (isLocalPackage(filename)) {
        const buf = await tryReadFile(join(vamDir, thumbPath))
        cache.set(key, buf || null)
        results[key] = buf || null
        continue
      }
      const varPath = resolveVarPath(addonDir, filename)
      if (!varExtractions.has(varPath)) varExtractions.set(varPath, [])
      varExtractions.get(varPath).push({ key, internalPath: thumbPath })
    }
  }

  for (const [varPath, items] of varExtractions) {
    try {
      const paths = items.map((i) => i.internalPath)
      const extracted = await extractFiles(varPath, paths)
      for (const { key, internalPath } of items) {
        const buf = extracted.get(internalPath) || null
        cache.set(key, buf)
        results[key] = buf
      }
    } catch {
      for (const { key } of items) {
        cache.set(key, null)
        results[key] = null
      }
    }
  }

  evict()
  return results
}
