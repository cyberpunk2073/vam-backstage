import { getResourceDetail } from './client.js'
import { fetchPackagesJson, getPackagesIndex } from './packages-json.js'
import {
  getAllPackagesForHubScan,
  getHubResource,
  setHubResourceId,
  setHubUserId,
  setHubDisplayName,
  setPackageTypeFromHub,
  upsertHubResourceDetail,
  upsertHubUser,
  setPackageHubMeta,
} from '../db.js'
import { buildFromDb } from '../store.js'
import { notify } from '../notify.js'
import { pLimit } from '../p-limit.js'

const limit = pLimit(10)

function backfillPackageFromDetail(filename, detail) {
  if (detail.user_id) {
    try {
      setHubUserId(filename, String(detail.user_id))
    } catch {}
  }
  if (detail.title) {
    try {
      setHubDisplayName(filename, detail.title)
    } catch {}
  }
  try {
    setPackageHubMeta(filename, { tags: detail.tags, promotionalLink: detail.promotional_link })
  } catch {}
  try {
    setPackageTypeFromHub(filename, detail.type)
  } catch {}
}

function applyCachedDetail(filename, rid) {
  const cached = getHubResource(rid)
  if (!cached?.hub_json) return false
  try {
    const detail = JSON.parse(cached.hub_json)
    if (!detail._unavailable) backfillPackageFromDetail(filename, detail)
  } catch {}
  return true
}

async function fetchOneDetail({ rid, filename }) {
  try {
    const detail = await getResourceDetail(rid)
    try {
      if (detail.user_id) {
        upsertHubUser(String(detail.user_id), detail.username, {
          user_id: detail.user_id,
          username: detail.username,
          avatar_date: detail.avatar_date,
        })
      }
    } catch {}
    backfillPackageFromDetail(filename, detail)
  } catch (e) {
    console.warn('[hub-scan] getResourceDetail failed for', rid, e.message)
    try {
      upsertHubResourceDetail(rid, { _unavailable: true, _error: e.message })
    } catch {}
  }
}

/**
 * Run a batch of detail fetches through the shared concurrency limiter.
 * Returns a promise that resolves when every item is done.
 */
function runDetailFetches(items, { onProgress } = {}) {
  if (items.length === 0) return Promise.resolve()
  let completed = 0
  const total = items.length
  const promises = items.map((item) =>
    limit(() =>
      fetchOneDetail(item).finally(() => {
        completed++
        onProgress?.({ current: completed, total })
      }),
    ),
  )
  return Promise.all(promises)
}

/**
 * Refresh Hub-derived fields for every local package that appears in packages.json:
 * aligns hub_resource_id from the CDN index, then backfills from hub_resources for everyone.
 * Packages without cached detail are fetched concurrently (up to 10 at a time).
 * @param {(data: { current: number, total: number, found: number, phase: string }) => void} [onProgress]
 */
export async function scanHubDetails(onProgress) {
  try {
    await fetchPackagesJson()
  } catch (e) {
    console.warn('[hub-scan] fetchPackagesJson failed:', e.message)
  }

  const index = getPackagesIndex()
  const rows = getAllPackagesForHubScan()
  const total = rows.length
  let found = 0
  let enriched = 0

  const report = (extra = {}) => {
    onProgress?.({ current: extra.current ?? 0, total, found, phase: extra.phase ?? 'lookup', ...extra })
  }

  const toFetch = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const current = i + 1
    report({ current, phase: 'lookup' })

    if (!index) continue

    const entry = index.get(row.package_name)
    if (!entry?.resourceId) continue

    found++
    const rid = String(entry.resourceId)
    try {
      setHubResourceId(row.filename, rid)
    } catch {}

    if (applyCachedDetail(row.filename, rid)) {
      enriched++
      report({ current, phase: 'cache' })
      continue
    }

    toFetch.push({ rid, filename: row.filename })
  }

  const fetchPromise = runDetailFetches(toFetch, {
    onProgress: onProgress ? (data) => onProgress({ ...data, found, phase: 'fetching' }) : undefined,
  })

  buildFromDb({ skipGraph: true })
  notify('packages:updated')

  await fetchPromise

  // The final rebuild below can be heavy on big libraries — emit a distinct
  // phase so the UI can show activity instead of sitting at "99%".
  onProgress?.({ phase: 'hub-finalize', current: 0, total: 1, found })
  if (toFetch.length > 0) {
    buildFromDb({ skipGraph: true })
    notify('packages:updated')
    notify('avatars:updated')
  }
  onProgress?.({ phase: 'hub-finalize', current: 1, total: 1, found })

  return { total, found, enriched, queued: toFetch.length, skipped: total - found }
}

/**
 * Check a set of filenames against the in-memory packages.json index and queue
 * hub detail fetches for any that are on the Hub but don't have cached details.
 * Fire-and-forget — used by the file watcher when new packages arrive.
 */
export function enrichNewPackages(filenames) {
  const index = getPackagesIndex()
  if (!index) return

  const toFetch = []
  for (const filename of filenames) {
    const parts = filename.replace(/\.var$/i, '').split('.')
    if (parts.length < 3) continue
    const packageName = parts.slice(0, -1).join('.')

    const entry = index.get(packageName)
    if (!entry?.resourceId) continue

    const rid = String(entry.resourceId)
    try {
      setHubResourceId(filename, rid)
    } catch {}

    if (applyCachedDetail(filename, rid)) continue

    toFetch.push({ rid, filename })
  }

  if (toFetch.length > 0) runDetailFetches(toFetch)
}
