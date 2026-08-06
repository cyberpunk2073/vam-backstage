import { net } from 'electron'
import {
  getSetting,
  setSetting,
  upsertHubResourceDetail,
  upsertHubResourceSearch,
  upsertHubResourceFind,
  markWishlistItemUnavailable,
  transact,
} from '../db.js'
import { notify } from '../notify.js'
import { invalidatePackagesJsonCache } from './packages-json.js'
import {
  canonicalizeLicense,
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  getHubResourceLicense,
  isCommercialUseAllowed,
  isNonCommercialUseAllowed,
} from '@shared/licenses.js'
import { HUB_PER_PAGE } from '@shared/hub-http.js'

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
  const res = await net.fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
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

/**
 * A usable getInfo payload has at least the type + sort pickers populated. We
 * gate caching on this so a malformed/partial response (e.g. a proxy error page
 * that still parsed as JSON, or a truncated body) is never written to the memory
 * or on-disk cache — otherwise both short-circuit forever and the filter sidebar
 * stays stuck on the core-only fallback until an explicit cache bust.
 */
function isValidFilters(data) {
  return !!data && Array.isArray(data.type) && data.type.length > 0 && Array.isArray(data.sort) && data.sort.length > 0
}

export async function getFilters() {
  if (cache.filters) return cache.filters
  const persisted = getSetting(FILTERS_SETTINGS_KEY)
  if (persisted) {
    try {
      const parsed = JSON.parse(persisted)
      if (isValidFilters(parsed)) {
        cache.filters = parsed
        return cache.filters
      }
    } catch {}
  }
  const data = await hubPost({ action: 'getInfo' })
  if (!isValidFilters(data)) throw new Error('Hub getInfo returned an unexpected shape')
  cache.filters = data
  setSetting(FILTERS_SETTINGS_KEY, JSON.stringify(data))
  return data
}

/** Force-fetch fresh filters from Hub (bypasses memory + DB cache). */
export async function refreshFilters() {
  const data = await hubPost({ action: 'getInfo' })
  if (!isValidFilters(data)) throw new Error('Hub getInfo returned an unexpected shape')
  cache.filters = data
  setSetting(FILTERS_SETTINGS_KEY, JSON.stringify(data))
  return data
}

export async function searchResources(params = {}) {
  // `persist: false` — skip session LRU + hub_resources upsert (full-catalog scan).
  const persist = params.persist !== false
  const cacheKey = JSON.stringify(params)
  if (persist) {
    const cached = lruGet(cache.searches, cacheKey)
    if (cached) return cached
  }

  const body = {
    action: 'getResources',
    latest_image: 'Y',
    perpage: String(params.perpage || HUB_PER_PAGE),
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
  if (
    params.license &&
    params.license !== 'Any' &&
    params.license !== COMMERCIAL_USE_ALLOWED_LICENSE_FILTER &&
    params.license !== NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER
  ) {
    // BUG: Hub's getResources ignores the `license` param entirely (unchanged total_found,
    // every licenseType still present). We still send it and filter client-side below so the
    // UI behaves correctly, but that means license-filtered pages can be sparse — tracked
    // separately from the windowed-list work. See docs/API.md.
    body.license = params.license
  }

  const data = await hubPost(body)

  let resources = data.resources || []
  // Client-side license filter — see BUG note above; remove once the Hub honors `license`.
  if (params.license && params.license !== 'Any') {
    if (params.license === COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) {
      resources = resources.filter((r) => isCommercialUseAllowed(getHubResourceLicense(r)) === true)
    } else if (params.license === NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER) {
      resources = resources.filter((r) => isNonCommercialUseAllowed(getHubResourceLicense(r)) === true)
    } else {
      const want = canonicalizeLicense(params.license)
      resources = resources.filter((r) => canonicalizeLicense(getHubResourceLicense(r)) === want)
    }
  }

  if (persist) {
    try {
      transact(() => {
        for (const r of resources) {
          if (r.resource_id) upsertHubResourceSearch(String(r.resource_id), r)
        }
      })
    } catch {}
  }

  const result = {
    resources,
    totalFound: parseInt(data.pagination?.total_found || '0', 10),
    totalPages: parseInt(data.pagination?.total_pages || '0', 10),
  }
  if (persist) lruSet(cache.searches, cacheKey, result, MAX_SEARCHES)
  return result
}

export async function getResourceDetail(resourceId) {
  const key = String(resourceId)
  const cached = lruGet(cache.details, key)
  if (cached) return cached

  let data
  try {
    data = await hubPost({
      action: 'getResourceDetail',
      latest_image: 'Y',
      resource_id: key,
    })
  } catch (err) {
    // The Hub returns `{status:'error', error:'Resource not found.'}` for a gone
    // resource (see docs/API.md) — hubPost rethrows that as the error message.
    // That's distinct from a transient network/HTTP failure ("Hub API <status>"),
    // so only the definitive not-found stamps a wishlisted item unavailable; a
    // later successful fetch clears the flag via the refresh hook.
    if (/resource not found/i.test(err.message)) {
      try {
        if (markWishlistItemUnavailable(key)) notify('wishlist:updated')
      } catch {}
    }
    throw err
  }

  try {
    if (upsertHubResourceDetail(key, data)) notify('wishlist:updated')
  } catch {}
  lruSet(cache.details, key, data, MAX_DETAILS)
  return data
}

/** Trailing VaM version segment: `12`, `latest`, or `min178`. */
function isVersionSegment(seg) {
  return seg === 'latest' || /^\d+$/.test(seg) || /^min\d+$/i.test(seg)
}

/**
 * Strip `.var` and a trailing version segment → `Creator.Package`.
 * `Author.Pkg.12.var` / `Author.Pkg.latest` / `Author.Pkg` → `Author.Pkg`.
 */
export function hubPackageBaseName(name) {
  if (!name) return ''
  const s = String(name).replace(/\.var$/i, '')
  const parts = s.split('.')
  if (parts.length >= 3 && isVersionSegment(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('.')
  }
  return s
}

/**
 * Hub's package_name lookup can return a resource that merely *depends on* the
 * queried package (common for unpaid PC assets pulled into paid looks). Accept
 * only when the package is a primary file of that resource: listed in
 * `hubFiles[]`, or an outer key of `dependencies` (paid multi-var listings put
 * each attached `.var` there — Hub omits `hubFiles` for those).
 *
 * Comparison is case-insensitive: Hub's name lookup ignores case, but deps
 * keys / hubFiles keep the creator's casing, which can differ from the local
 * `.var` filename (e.g. `caelryn.skallet` vs `caelryn.Skallet`).
 *
 * Outer deps keys are usually the bare package base; when queried by
 * `package_name` Hub sometimes echoes the ref with a version suffix
 * (`.latest` / `.N` / `.minN`) — `hubPackageBaseName` covers both shapes.
 */
export function resourceDetailMatchesPackageName(detail, packageName) {
  if (!detail?.resource_id || !packageName) return false
  const base = hubPackageBaseName(packageName)
  if (!base) return false
  const baseLower = base.toLowerCase()

  for (const f of detail.hubFiles || []) {
    if (f?.filename && hubPackageBaseName(f.filename).toLowerCase() === baseLower) return true
  }

  for (const key of Object.keys(detail.dependencies || {})) {
    if (!key) continue
    if (hubPackageBaseName(key).toLowerCase() === baseLower) return true
  }
  return false
}

/**
 * Look up resource detail by package base name (e.g. "Creator.PackageName").
 * Uses the Hub's package_name lookup with ".latest" suffix.
 * Returns null when Hub answers with an unrelated resource that only lists the
 * package as a dependency (see `resourceDetailMatchesPackageName`).
 */
export async function getResourceDetailByName(packageName) {
  const key = 'pkg:' + packageName
  const cached = lruGet(cache.details, key)
  if (cached !== undefined) return cached

  // throwOnApiError:false so an authoritative "Resource not found" comes back as
  // null (a real negative answer the caller can cache), while transport/HTTP
  // failures still throw out of hubPost and are NOT mistaken for "absent".
  const queried = packageName + '.latest'
  let data = await hubPost(
    {
      action: 'getResourceDetail',
      latest_image: 'Y',
      package_name: queried,
    },
    { throwOnApiError: false },
  )

  if (data?.resource_id && !resourceDetailMatchesPackageName(data, packageName)) {
    hubDebug('name lookup rejected (package not primary on resource)', {
      packageName,
      resource_id: data.resource_id,
      title: data.title,
      package_id: data.package_id,
    })
    // Still persist the payload under its real resource_id — it's valid detail
    // for that listing — but treat the *name* as unresolved.
    try {
      if (upsertHubResourceDetail(String(data.resource_id), data)) notify('wishlist:updated')
    } catch {}
    lruSet(cache.details, String(data.resource_id), data, MAX_DETAILS)
    data = null
  } else {
    try {
      if (data?.resource_id && upsertHubResourceDetail(String(data.resource_id), data)) notify('wishlist:updated')
    } catch {}
    if (data?.resource_id) lruSet(cache.details, String(data.resource_id), data, MAX_DETAILS)
  }

  lruSet(cache.details, key, data, MAX_DETAILS)
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
