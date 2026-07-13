import { ipcMain } from 'electron'
import { addWishlistItem, removeWishlistItem, getAllWishlistItems, getWishlistIds } from '../db.js'
import { annotateInstallState } from '../store.js'
import { prefetchHubResThumbnail } from '../thumbnails.js'
import { notifyPeers } from '../notify.js'
import { collectHubListResourceIds, persistHubListToWishlist } from '../hub/wishlist-import.js'

/**
 * Parse a stored snapshot and re-attach runtime annotations: shared install
 * state (`_installed` / `_isDirect` / `_localFilename`, via annotateInstallState),
 * plus wishlist-only metadata (`_wishlistedAt`, `_unavailable`). Matching is by
 * resource id, so the installed badge is version-agnostic by construction.
 */
function annotateWishlistRow(row) {
  let snapshot
  try {
    snapshot = JSON.parse(row.snapshot_json)
  } catch {
    return null
  }
  annotateInstallState(snapshot, row.resource_id)
  snapshot._wishlistedAt = row.created_at
  snapshot._unavailable = row.unavailable_at != null
  return snapshot
}

export function registerWishlistHandlers() {
  ipcMain.handle('wishlist:list', async () => {
    return getAllWishlistItems().map(annotateWishlistRow).filter(Boolean)
  })

  ipcMain.handle('wishlist:ids', async () => {
    return getWishlistIds()
  })

  // `snapshot` is the renderer's fully-annotated detail object; addWishlistItem
  // strips the `_`-prefixed annotations before persisting (see db.js).
  // Peer-only notify: the actor already updated optimistic ids + will `load()`
  // after this RPC; other clients need the invalidation to refresh pins/count.
  ipcMain.handle('wishlist:add', async (event, resourceId, snapshot) => {
    addWishlistItem(resourceId, snapshot)
    // Cache the thumbnail now, before the resource can vanish from the Hub.
    // Fire-and-forget: the gallery reads it later from disk via `hub-icon:` keys.
    void prefetchHubResThumbnail(resourceId, snapshot?.image_url)
    notifyPeers(event, 'wishlist:updated', { membership: true })
    // TODO (future): a bounded background trickle could refresh visible wishlist
    // snapshots older than N days (concurrency 1–2) when the wishlist opens.
    // Deliberately out of scope for v1 — refresh piggybacks on detail opens.
  })

  ipcMain.handle('wishlist:remove', async (event, resourceId) => {
    removeWishlistItem(resourceId)
    notifyPeers(event, 'wishlist:updated', { membership: true })
  })

  // Collect scrapes Hub list pages via persist:hub cookies — machine-local
  // (see remote LOCAL_CHANNELS / DENIED_CHANNELS). Persist hydrates details via
  // the public Hub API and writes the host DB — safe to proxy remotely.
  ipcMain.handle('wishlist:import-collect', async (_event, source) => {
    if (source !== 'bookmarks' && source !== 'favorites') return { ok: false, error: 'invalid source' }
    try {
      const result = await collectHubListResourceIds(source)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('wishlist:import', async (_event, { source, resourceIds } = {}) => {
    if (source !== 'bookmarks' && source !== 'favorites') return { ok: false, error: 'invalid source' }
    if (!Array.isArray(resourceIds)) return { ok: false, error: 'invalid resourceIds' }
    try {
      const result = await persistHubListToWishlist(source, resourceIds)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
