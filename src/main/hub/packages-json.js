import { randomUUID } from 'crypto'
import { getSetting, setSetting } from '../db.js'
import { HUB_HTTP_USER_AGENT } from '../../shared/hub-http.js'

const PACKAGES_JSON_URL = 'https://s3cdn.virtamate.com/data/packages.json'
const DB_KEY_DATA = 'packages_json_data'
const DB_KEY_ETAG = 'packages_json_etag'

let packagesIndex = null // Map<packageName, { version, filename, resourceId }>
let packagesFilenameIndex = null // Map<filename, resourceId> — every version listed in packages.json
let lastFetchedAt = 0
let fetchPromise = null

function parsePackageEntry(key) {
  const stem = key.replace(/\.var$/i, '')
  const parts = stem.split('.')
  if (parts.length < 3) return null
  const version = parseInt(parts[parts.length - 1], 10)
  if (isNaN(version)) return null
  const packageName = parts.slice(0, -1).join('.')
  return { packageName, version }
}

function buildIndexes(data) {
  const index = new Map()
  const fnIndex = new Map()
  for (const [key, resourceId] of Object.entries(data)) {
    fnIndex.set(key, resourceId)
    const parsed = parsePackageEntry(key)
    if (!parsed) continue
    const existing = index.get(parsed.packageName)
    if (!existing || parsed.version > existing.version) {
      index.set(parsed.packageName, {
        version: parsed.version,
        filename: key,
        resourceId,
      })
    }
  }
  return { index, fnIndex }
}

/**
 * Load packages.json from the DB cache (synchronous).
 * Called at startup so the indexes are available immediately before any network request.
 */
export function loadPackagesJsonFromCache() {
  const raw = getSetting(DB_KEY_DATA)
  if (!raw) return false
  try {
    const data = JSON.parse(raw)
    const { index, fnIndex } = buildIndexes(data)
    packagesIndex = index
    packagesFilenameIndex = fnIndex
    // Don't set lastFetchedAt — cache-loaded data should still be considered stale
    // so the STALE_MS check triggers a real network refresh when needed.
    console.log(`[PackagesJson] Loaded ${index.size} package groups (${fnIndex.size} files) from cache`)
    return true
  } catch (err) {
    console.warn('[PackagesJson] Failed to parse cached data:', err.message)
    return false
  }
}

/**
 * Fetch and parse the CDN packages.json index. Deduplicates concurrent calls.
 *
 * Sends `GET ?cb=<random-uuid>` with `If-None-Match: <stored-etag>`.  The random
 * cache-buster guarantees an edge MISS so the response reflects whatever origin
 * has right now (CDN77 has been observed serving week-old bodies for any
 * predictable cache key, including `?<getInfo.last_update>`); the conditional
 * GET keeps it free on the no-change path — origin returns 304 with no body.
 *
 * - Default: send INM if we have a stored etag and an in-memory index; on 304 reuse cache.
 * - `force`: omit INM so origin always returns the body.  Used by the explicit
 *   user-triggered refresh.
 */
export async function fetchPackagesJson({ force = false } = {}) {
  if (fetchPromise) return fetchPromise

  fetchPromise = (async () => {
    try {
      const buster = randomUUID()
      const stored = getSetting(DB_KEY_ETAG)
      const headers = { 'User-Agent': HUB_HTTP_USER_AGENT }
      if (stored && !force && packagesIndex) headers['If-None-Match'] = stored

      const res = await fetch(`${PACKAGES_JSON_URL}?cb=${buster}`, { headers })

      if (res.status === 304) {
        lastFetchedAt = Date.now()
        return packagesIndex
      }
      if (!res.ok) throw new Error(`packages.json ${res.status}: ${res.statusText}`)

      const text = await res.text()
      const data = JSON.parse(text)

      const { index, fnIndex } = buildIndexes(data)
      packagesIndex = index
      packagesFilenameIndex = fnIndex
      lastFetchedAt = Date.now()
      const newEtag = res.headers.get('etag')
      console.log(`[PackagesJson] Fetched ${index.size} package groups (${fnIndex.size} files)`)

      try {
        setSetting(DB_KEY_DATA, text)
        if (newEtag) setSetting(DB_KEY_ETAG, newEtag)
      } catch (err) {
        console.warn('[PackagesJson] Failed to persist cache:', err.message)
      }

      return index
    } finally {
      fetchPromise = null
    }
  })()

  return fetchPromise
}

/** Clear the stored etag so the next fetchPackagesJson will re-download the body. */
export function invalidatePackagesJsonCache() {
  setSetting(DB_KEY_ETAG, null)
}

export function getPackagesIndex() {
  return packagesIndex
}

export function getPackagesFilenameIndex() {
  return packagesFilenameIndex
}

export function getPackagesIndexAge() {
  return lastFetchedAt ? Date.now() - lastFetchedAt : Infinity
}

/**
 * Check for updates by comparing installed packages against the CDN index.
 * Returns { [localFilename]: { currentVersion, hubVersion, hubFilename, hubResourceId, downloadUrl, localNewerFilename?, isDepUpdate?, neededBy? } }
 *
 * When a newer version already exists locally (e.g. pulled in as a dependency),
 * `localNewerFilename` is set so the UI can navigate to it instead of downloading.
 *
 * When `forwardDeps` is provided, also checks dependency packages referenced as
 * `.latest` — if the CDN has a newer version than what's resolved locally, the dep
 * is included with `isDepUpdate: true`.
 */
export function checkUpdatesFromIndex(packageIndex, groupIndex, forwardDeps) {
  if (!packagesIndex) return null

  const updates = {}
  for (const [packageName, filenames] of groupIndex) {
    let best = null,
      bestVer = -1
    for (const fn of filenames) {
      const pkg = packageIndex.get(fn)
      if (!pkg || !pkg.is_direct) continue
      const v = parseInt(pkg.version, 10) || 0
      if (v > bestVer) {
        bestVer = v
        best = fn
      }
    }
    if (!best) continue

    const hubEntry = packagesIndex.get(packageName)
    if (!hubEntry || hubEntry.version <= bestVer) continue

    let localNewerFilename = null
    for (const fn of filenames) {
      if (fn === best) continue
      const pkg = packageIndex.get(fn)
      if (!pkg) continue
      const v = parseInt(pkg.version, 10) || 0
      if (v >= hubEntry.version) {
        if (!localNewerFilename || v > (parseInt(packageIndex.get(localNewerFilename).version, 10) || 0))
          localNewerFilename = fn
      }
    }

    updates[best] = {
      currentVersion: bestVer,
      hubVersion: hubEntry.version,
      hubFilename: hubEntry.filename,
      hubResourceId: String(hubEntry.resourceId),
      packageName,
      downloadUrl: null,
      localNewerFilename,
    }
  }

  // Dep updates: find .latest-referenced deps where the CDN has a newer version
  if (forwardDeps) {
    // depPackageName → { resolvedFilename, resolvedVersion, neededBy }
    const latestDeps = new Map()
    for (const [filename, deps] of forwardDeps) {
      for (const dep of deps) {
        if (dep.resolution !== 'latest' || !dep.resolved) continue
        const pkg = packageIndex.get(dep.resolved)
        if (!pkg) continue
        const depName = pkg.package_name
        let entry = latestDeps.get(depName)
        if (!entry) {
          entry = {
            resolvedFilename: dep.resolved,
            resolvedVersion: parseInt(pkg.version, 10) || 0,
            neededBy: new Set(),
          }
          latestDeps.set(depName, entry)
        }
        entry.neededBy.add(filename)
      }
    }

    for (const [depName, depInfo] of latestDeps) {
      if (updates[depInfo.resolvedFilename]) continue
      const hubEntry = packagesIndex.get(depName)
      if (!hubEntry || hubEntry.version <= depInfo.resolvedVersion) continue

      let localNewerFilename = null
      const candidates = groupIndex.get(depName) || []
      for (const fn of candidates) {
        if (fn === depInfo.resolvedFilename) continue
        const pkg = packageIndex.get(fn)
        if (!pkg) continue
        const v = parseInt(pkg.version, 10) || 0
        if (v >= hubEntry.version) {
          if (!localNewerFilename || v > (parseInt(packageIndex.get(localNewerFilename).version, 10) || 0))
            localNewerFilename = fn
        }
      }

      updates[depInfo.resolvedFilename] = {
        currentVersion: depInfo.resolvedVersion,
        hubVersion: hubEntry.version,
        hubFilename: hubEntry.filename,
        hubResourceId: String(hubEntry.resourceId),
        packageName: depName,
        downloadUrl: null,
        localNewerFilename,
        isDepUpdate: true,
        neededBy: [...depInfo.neededBy],
      }
    }
  }

  return updates
}
