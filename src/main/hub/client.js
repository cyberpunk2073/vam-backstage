import {
  getSetting,
  setSetting,
  upsertHubResourceDetail,
  upsertHubResourceSearch,
  upsertHubResourceFind,
  transact,
} from '../db.js'
import { invalidatePackagesJsonCache } from './packages-json.js'
import {
  canonicalizeLicense,
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  getHubResourceLicense,
  isCommercialUseAllowed,
} from '../../shared/licenses.js'
import { HUB_HTTP_USER_AGENT } from '../../shared/hub-http.js'

const API_URL = 'https://hub.virtamate.com/citizenx/api.php'

function hubDebugEnabled() {
  return getSetting('hub_debug_requests') === '1'
}

function hubDebug(label, value) {
  if (!hubDebugEnabled()) return
  if (value === undefined) {
    console.log(`[Hub] ${label}`)
    return
  }
  try {
    console.log(`[Hub] ${label}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  } catch {
    console.log(`[Hub] ${label}`, value)
  }
}

const FILTERS_SETTINGS_KEY = 'hub_filters_json'

// In-memory session cache — cleared on app restart, not persisted.
// LRU-evicted: Map insertion order tracks recency; on hit we re-insert to refresh position.
const MAX_SEARCHES = 500
const MAX_DETAILS = 1000

const cache = {
  filters: null,
  searches: new Map(),
  details: new Map(),
}

function lruGet(map, key) {
  const val = map.get(key)
  if (val === undefined) return undefined
  map.delete(key)
  map.set(key, val)
  return val
}

function lruSet(map, key, val, max) {
  map.set(key, val)
  if (map.size > max) {
    const drop = Math.floor(max * 0.2)
    const iter = map.keys()
    for (let i = 0; i < drop; i++) map.delete(iter.next().value)
  }
}

async function hubPost(body, { throwOnApiError = true } = {}) {
  const payload = { source: 'VaM', ...body }
  hubDebug('→ request', payload)
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': HUB_HTTP_USER_AGENT,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    hubDebug('← HTTP error', { status: res.status, statusText: res.statusText, body: errBody })
    throw new Error(`Hub API ${res.status}: ${res.statusText}`)
  }
  const data = await res.json()
  hubDebug('← response', data)
  if (data.status === 'error') {
    if (throwOnApiError) throw new Error(data.error || 'Hub API error')
    return null
  }
  return data
}

export async function getFilters() {
  if (cache.filters) return cache.filters
  const persisted = getSetting(FILTERS_SETTINGS_KEY)
  if (persisted) {
    try {
      cache.filters = JSON.parse(persisted)
      return cache.filters
    } catch {}
  }
  const data = await hubPost({ action: 'getInfo' })
  cache.filters = data
  setSetting(FILTERS_SETTINGS_KEY, JSON.stringify(data))
  return data
}

/** Force-fetch fresh filters from Hub (bypasses memory + DB cache). */
export async function refreshFilters() {
  const data = await hubPost({ action: 'getInfo' })
  cache.filters = data
  setSetting(FILTERS_SETTINGS_KEY, JSON.stringify(data))
  return data
}

export async function searchResources(params = {}) {
  const cacheKey = JSON.stringify(params)
  const cached = lruGet(cache.searches, cacheKey)
  if (cached) return cached

  const body = {
    action: 'getResources',
    latest_image: 'Y',
    perpage: String(params.perpage || 30),
    page: String(params.page || 1),
  }
  if (params.sort) body.sort = params.sort
  if (params.search) {
    body.search = params.search
    body.searchall = 'true'
  }
  if (params.type && params.type !== 'All') body.type = params.type
  if (params.category && params.category !== 'All') body.category = params.category
  if (params.username) body.username = params.username
  if (params.tags) body.tags = params.tags
  if (params.license && params.license !== 'Any' && params.license !== COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) {
    body.license = params.license
  }

  const data = await hubPost(body)

  let resources = data.resources || []
  if (params.license && params.license !== 'Any') {
    if (params.license === COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) {
      resources = resources.filter((r) => isCommercialUseAllowed(getHubResourceLicense(r)) === true)
    } else {
      const want = canonicalizeLicense(params.license)
      resources = resources.filter((r) => canonicalizeLicense(getHubResourceLicense(r)) === want)
    }
  }

  try {
    transact(() => {
      for (const r of resources) {
        if (r.resource_id) upsertHubResourceSearch(String(r.resource_id), r)
      }
    })
  } catch {}

  const result = {
    resources,
    totalFound: parseInt(data.pagination?.total_found || '0', 10),
    totalPages: parseInt(data.pagination?.total_pages || '0', 10),
  }
  lruSet(cache.searches, cacheKey, result, MAX_SEARCHES)
  return result
}

export async function getResourceDetail(resourceId) {
  const key = String(resourceId)
  const cached = lruGet(cache.details, key)
  if (cached) return cached

  const data = await hubPost({
    action: 'getResourceDetail',
    latest_image: 'Y',
    resource_id: key,
  })

  try {
    upsertHubResourceDetail(key, data)
  } catch {}
  lruSet(cache.details, key, data, MAX_DETAILS)
  return data
}

/**
 * Look up resource detail by package base name (e.g. "Creator.PackageName").
 * Uses the Hub's package_name lookup with ".latest" suffix.
 */
export async function getResourceDetailByName(packageName) {
  const key = 'pkg:' + packageName
  const cached = lruGet(cache.details, key)
  if (cached) return cached

  const data = await hubPost({
    action: 'getResourceDetail',
    latest_image: 'Y',
    package_name: packageName + '.latest',
  })

  try {
    if (data.resource_id) upsertHubResourceDetail(String(data.resource_id), data)
  } catch {}
  lruSet(cache.details, key, data, MAX_DETAILS)
  if (data.resource_id) lruSet(cache.details, String(data.resource_id), data, MAX_DETAILS)
  return data
}

/** Return a cached detail if we already have it — never makes an API call. */
export function getCachedDetail(resourceId) {
  return cache.details.get(String(resourceId)) || null
}

export async function findPackages(packageNames) {
  if (!packageNames.length) return {}
  const results = {}
  for (let i = 0; i < packageNames.length; i += 50) {
    const batch = packageNames.slice(i, i + 50)
    const data = await hubPost({
      action: 'findPackages',
      packages: batch.join(','),
    })
    const pkgs = data.packages || {}
    Object.assign(results, pkgs)
    try {
      transact(() => {
        for (const f of Object.values(pkgs)) {
          if (f.resource_id) upsertHubResourceFind(String(f.resource_id), f)
        }
      })
    } catch {}
  }
  return results
}

/**
 * Full hub session cache bust for explicit user refresh: list results (all queries/pages),
 * filter metadata from getInfo (memory + on-disk), and resource details.
 */
export function invalidateHubCachesForRefresh() {
  cache.filters = null
  cache.searches.clear()
  cache.details.clear()
  setSetting(FILTERS_SETTINGS_KEY, null)
  invalidatePackagesJsonCache()
}
