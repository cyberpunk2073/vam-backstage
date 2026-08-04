import { app } from 'electron'
import { access, readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { searchResources } from './client.js'
import { notify } from '../notify.js'

const PER_PAGE = 250
const SORT = 'Latest Update'
const CACHE_VERSION = 1

let scanning = false
let cancelRequested = false

function cachePath() {
  return join(app.getPath('userData'), 'hub-catalog-cache.json')
}

function lastUpdateNum(r) {
  return Number(r?.last_update) || 0
}

function byLastUpdateDesc(a, b) {
  return lastUpdateNum(b) - lastUpdateNum(a)
}

/** Map resource_id → row; last write wins if the file somehow had dupes. */
function indexByResourceId(resources) {
  const byId = new Map()
  for (const r of resources || []) {
    if (r?.resource_id == null || r.resource_id === '') continue
    byId.set(String(r.resource_id), r)
  }
  return byId
}

function maxLastUpdate(resources) {
  let max = 0
  for (const r of resources || []) {
    const t = lastUpdateNum(r)
    if (t > max) max = t
  }
  return max
}

/** Read the on-disk catalog cache, or null if missing/unreadable/wrong version. */
export async function loadCatalogCache() {
  const path = cachePath()
  try {
    await access(path)
  } catch {
    return null
  }
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    if (data?.version !== CACHE_VERSION || !Array.isArray(data.resources)) return null
    return data
  } catch {
    return null
  }
}

async function writeCatalogCache(payload) {
  const path = cachePath()
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(payload))
  await rename(tmp, path)
}

export function cancelCatalogScan() {
  cancelRequested = true
}

/**
 * Full scan, or head-only delta when a cache already exists.
 *
 * Delta: page Latest Update from the head while last_update >= cache watermark
 * (max cached last_update); take new ids and ids with a newer last_update.
 * Unlisted / removed Hub rows are intentionally kept so they stay searchable offline.
 * Merge by resource_id and write a clean list sorted last_update desc.
 */
export async function scanCatalogCache() {
  if (scanning) throw new Error('Catalog scan already in progress')
  scanning = true
  cancelRequested = false
  try {
    const existing = await loadCatalogCache()
    const prev = Array.isArray(existing?.resources) ? existing.resources : []
    const byId = indexByResourceId(prev)
    const delta = byId.size > 0

    let totalFound = existing?.totalFound || 0
    let resources
    let added = 0
    let updated = 0

    if (!delta) {
      const byIdFresh = new Map()
      let page = 1
      let totalPages = 1
      for (;;) {
        if (cancelRequested) throw new Error('Catalog scan cancelled')
        const result = await searchResources({
          page,
          perpage: PER_PAGE,
          sort: SORT,
          persist: false,
        })
        totalFound = result.totalFound
        totalPages = Math.max(1, result.totalPages || 1)
        for (const r of result.resources) {
          if (r?.resource_id == null || r.resource_id === '') continue
          byIdFresh.set(String(r.resource_id), r)
        }
        notify('hub:catalog-scan-progress', { page, totalPages, count: byIdFresh.size })
        if (result.resources.length < PER_PAGE || page >= totalPages) break
        page++
      }
      resources = [...byIdFresh.values()]
      added = resources.length
    } else {
      // Head-only: updates bump last_update to "now", so they sort above the previous max.
      const watermark = maxLastUpdate(prev)
      const incoming = []
      let page = 1
      let reachedUnchanged = false
      for (;;) {
        if (cancelRequested) throw new Error('Catalog scan cancelled')
        // Single thread to reduce the load on the Hub server.
        const result = await searchResources({
          page,
          perpage: PER_PAGE,
          sort: SORT,
          persist: false,
        })
        totalFound = result.totalFound
        const totalPages = Math.max(1, result.totalPages || 1)
        for (const r of result.resources) {
          if (r?.resource_id == null || r.resource_id === '') continue
          const id = String(r.resource_id)
          const t = lastUpdateNum(r)
          // Past the cached head — same-second siblings at `watermark` still scanned.
          if (t < watermark) {
            reachedUnchanged = true
            break
          }
          const old = byId.get(id)
          if (old && t <= lastUpdateNum(old)) continue
          if (old) updated++
          else added++
          incoming.push(r)
        }
        // totalPages: 0 → UI shows "?" (delta end is unknown until stop).
        notify('hub:catalog-scan-progress', { page, totalPages: 0, count: incoming.length })
        if (reachedUnchanged || result.resources.length < PER_PAGE || page >= totalPages) break
        page++
      }
      for (const r of incoming) byId.set(String(r.resource_id), r)
      resources = [...byId.values()]
    }

    resources.sort(byLastUpdateDesc)

    const payload = {
      version: CACHE_VERSION,
      scannedAt: Date.now(),
      sort: SORT,
      totalFound,
      resources,
    }
    await writeCatalogCache(payload)
    // `stats` is IPC-only — not persisted in the JSON cache.
    return { ...payload, stats: { delta, added, updated } }
  } finally {
    scanning = false
    cancelRequested = false
  }
}
