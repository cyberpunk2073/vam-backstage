import { getResourceDetail, getResourceDetailByName } from './client.js'
import { fetchPackagesJson, getPackagesIndex } from './packages-json.js'
import {
  getAllPackagesForHubScan,
  getHubResource,
  getPackagesNeedingHubDetailApply,
  getPackagesNeedingHubDetailFetch,
  getPackagesNeedingHubNameLookup,
  markHubNameChecked,
  setHubResourceId,
  applyHubDetailToPackage,
  upsertHubResourceDetail,
  upsertHubUser,
} from '../db.js'
import { buildFromDb } from '../store.js'
import { notify } from '../notify.js'
import { pLimit } from '../p-limit.js'
import { resolvePackageThumbnails } from '../thumb-resolver.js'

const limit = pLimit(10)

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
    applyHubDetailToPackage(filename, detail)
  } catch (e) {
    console.warn('[hub-scan] getResourceDetail failed for', rid, e.message)
    try {
      upsertHubResourceDetail(rid, { _unavailable: true, _error: e.message })
      applyHubDetailToPackage(filename, { _unavailable: true })
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
 * Resolve a single package by name for the case `packages.json` couldn't link it
 * (paid, hub-removed, or off-Hub). On a hit, link + apply detail like the
 * id-based path; on either a hit or an authoritative not-found, stamp
 * `hub_name_checked_at` so we never ask again. Transient/transport errors are
 * swallowed WITHOUT stamping, so a later run retries.
 * @returns {Promise<boolean>} true when the package was linked to a resource.
 */
async function resolveOneByName({ filename, packageName }) {
  try {
    const detail = await getResourceDetailByName(packageName)
    if (detail?.resource_id) {
      try {
        if (detail.user_id) {
          upsertHubUser(String(detail.user_id), detail.username, {
            user_id: detail.user_id,
            username: detail.username,
            avatar_date: detail.avatar_date,
          })
        }
      } catch {}
      setHubResourceId(filename, String(detail.resource_id))
      applyHubDetailToPackage(filename, detail)
      markHubNameChecked(filename)
      return true
    }
    // null = authoritative "Resource not found" (e.g. the user's own local
    // creation). Remember it; don't re-query every launch.
    markHubNameChecked(filename)
    return false
  } catch (e) {
    console.warn('[hub-scan] name lookup failed for', packageName, e.message)
    return false
  }
}

/**
 * Run a batch of name-based resolutions through the shared concurrency limiter.
 * @returns {Promise<number>} number of packages that resolved to a resource.
 */
function runNameResolution(items, { onProgress } = {}) {
  if (items.length === 0) return Promise.resolve(0)
  let completed = 0
  const total = items.length
  return Promise.all(
    items.map((item) =>
      limit(() =>
        resolveOneByName(item).finally(() => {
          completed++
          onProgress?.({ current: completed, total })
        }),
      ),
    ),
  ).then((results) => results.filter(Boolean).length)
}

/**
 * Refresh Hub-derived fields for every local package that appears in packages.json:
 * aligns hub_resource_id from the CDN index, then re-applies cached detail only
 * to rows whose `hub_resources` entry has moved since `packages.hub_detail_applied_at`
 * (zero-cost on warm starts). Packages with no cached detail are fetched
 * concurrently (up to 10 at a time).
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

  // Per-row progress would emit ~1700 IPC events on cold startup; the renderer's
  // status bar can't display per-row anyway. Stride the lookup-phase emits.
  const LOOKUP_PROGRESS_STRIDE = 50
  const report = (extra = {}) => {
    onProgress?.({ current: extra.current ?? 0, total, found, phase: extra.phase ?? 'lookup', ...extra })
  }

  // Pass 1: link hub_resource_id from the packages.json index. setHubResourceId
  // is gated to a true no-op when the column already matches, so warm-start
  // re-runs cost zero writes here. Track real changes so we can skip the
  // post-pass `buildFromDb`/`notify` when nothing moved.
  let pass1Changes = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const current = i + 1
    if (current % LOOKUP_PROGRESS_STRIDE === 0 || current === total) {
      report({ current, phase: 'lookup' })
    }

    if (!index) continue

    const entry = index.get(row.package_name)
    if (!entry?.resourceId) continue

    found++
    try {
      pass1Changes += setHubResourceId(row.filename, String(entry.resourceId))
    } catch {}
  }

  // Pass 2: apply cached hub detail only to rows where the cache has moved
  // since the last apply (or has never been applied). Warm steady state hits
  // zero rows here — no JSON parses, no DB writes.
  const dirty = getPackagesNeedingHubDetailApply()
  for (const row of dirty) {
    try {
      const detail = JSON.parse(row.hub_json)
      applyHubDetailToPackage(row.filename, detail)
    } catch {}
  }

  // Build the fetch work-list from rows that are linked but have no cached
  // hub_json yet. `_unavailable` rows have a non-null hub_json and are
  // intentionally excluded — known failures aren't retried every launch.
  // Rows are already shaped { filename, rid } via the SQL alias.
  const toFetch = getPackagesNeedingHubDetailFetch()
  // Pass 4 work-list — packages packages.json couldn't link (paid, hub-removed,
  // off-Hub). The unresolved (`hub_resource_id IS NULL`) set is fixed after
  // Pass 1's linking, so it's safe to compute here, before Pass 3 runs.
  //
  // Gated on the index being available: with no index, Pass 1 linked nothing, so
  // EVERY package would look off-index and we'd name-look-up the whole library
  // (a false signal from the missing index, not real off-Hub packages). Skip
  // and let a later run with a loaded index resolve them properly.
  const nameLookups = index ? getPackagesNeedingHubNameLookup() : []
  // Same semantic as before the dirty-check refactor: number of packages whose
  // hub detail is already cached locally (incl. `_unavailable` markers), as
  // opposed to those still queued for a network fetch this run.
  const enriched = found - toFetch.length

  // Pass 3 (getResourceDetail by id) and Pass 4 (getResourceDetailByName) both
  // hit the Hub through the same pLimit(10). Report them as ONE 'fetching' span
  // of N + M so the progress bar flows smoothly across both instead of stalling
  // between phases (and so consumers need only handle a single phase).
  const netTotal = toFetch.length + nameLookups.length
  const emitNet = onProgress ? (done) => onProgress({ phase: 'fetching', current: done, total: netTotal, found }) : null

  const fetchPromise = runDetailFetches(toFetch, {
    onProgress: emitNet ? (data) => emitNet(data.current) : undefined,
  })

  // Only rebuild + notify if pass 1 or pass 2 actually moved data. Without this
  // gate the warm steady-state path would still trigger the renderer to
  // refetch ~1700 rows over IPC for no reason — defeating C1+C2's whole point.
  if (pass1Changes > 0 || dirty.length > 0) {
    buildFromDb({ skipGraph: true })
    notify('packages:updated')
  }

  await fetchPromise

  // Pass 4: name-based resolution for the leftovers. Each package is asked once
  // per lifetime (resolveOneByName stamps hub_name_checked_at on a definitive
  // answer), so this is a one-time cost on the first scan after deploy and then
  // only brand-new packages each run. Continues the shared 'fetching' span.
  const nameHits = await runNameResolution(nameLookups, {
    onProgress: emitNet ? (data) => emitNet(toFetch.length + data.current) : undefined,
  })

  // The final rebuild below can be heavy on big libraries — emit a distinct
  // phase so the UI can show activity instead of sitting at "99%".
  onProgress?.({ phase: 'hub-finalize', current: 0, total: 1, found })
  if (toFetch.length > 0 || nameHits > 0) {
    buildFromDb({ skipGraph: true })
    notify('packages:updated')
    notify('avatars:updated')
  }
  onProgress?.({ phase: 'hub-finalize', current: 1, total: 1, found })

  return {
    total,
    found,
    enriched,
    queued: toFetch.length,
    skipped: total - found,
    nameChecked: nameLookups.length,
    nameHits,
  }
}

/**
 * Check a set of filenames against the in-memory packages.json index and queue
 * hub detail fetches for any that are on the Hub but don't have cached details.
 * Packages absent from the index fall through to a name-based lookup (paid /
 * off-Hub), mirroring scanHubDetails' Pass 4. Fire-and-forget — used by the
 * file watcher when new packages arrive.
 */
export function enrichNewPackages(filenames) {
  const index = getPackagesIndex()
  if (!index) return

  const toFetch = []
  const toResolveByName = []
  for (const filename of filenames) {
    const parts = filename.replace(/\.var$/i, '').split('.')
    if (parts.length < 3) continue
    const packageName = parts.slice(0, -1).join('.')

    const entry = index.get(packageName)
    if (!entry?.resourceId) {
      // Not in the CDN index — resolve by name (covers paid drop-ins).
      toResolveByName.push({ filename, packageName })
      continue
    }

    const rid = String(entry.resourceId)
    try {
      setHubResourceId(filename, rid)
    } catch {}

    const cached = getHubResource(rid)
    if (cached?.hub_json) {
      try {
        applyHubDetailToPackage(filename, JSON.parse(cached.hub_json))
      } catch {}
      continue
    }

    toFetch.push({ rid, filename })
  }

  if (toFetch.length > 0) runDetailFetches(toFetch)
  if (toResolveByName.length > 0) {
    // On any hit, surface it: refresh the in-memory store, repaint the library,
    // and fetch the now-linked Hub thumbnail.
    runNameResolution(toResolveByName).then((hits) => {
      if (hits > 0) {
        buildFromDb({ skipGraph: true })
        notify('packages:updated')
        resolvePackageThumbnails()
      }
    })
  }
}
