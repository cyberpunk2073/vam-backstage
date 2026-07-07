import { create } from 'zustand'
import { toast } from '@/components/Toast'
import { useInstalledStore } from './useInstalledStore'

/** Feed the canonical install-state store so wishlist HubCards resolve their install badges. */
function syncInstalledFromItems(items) {
  useInstalledStore.getState().applyBatch(
    items.map((r) => ({
      hubResourceId: r.resource_id,
      installed: r._installed,
      isDirect: r._isDirect,
      filename: r._localFilename,
    })),
  )
}

/**
 * Local wishlist of hub packages. `items` are annotated snapshots (installed
 * state recomputed server-side per list call); `ids` is a fast membership set
 * driving the detail-panel toggle. Backed by SQLite via `window.api.wishlist`.
 */
export const useWishlistStore = create((set, get) => ({
  items: [],
  ids: new Set(),
  loading: false,
  loaded: false,

  /** Full list — call on wishlist-mode entry and after toggles so the gallery + count stay fresh. */
  load: async () => {
    set({ loading: true })
    try {
      const items = await window.api.wishlist.list()
      syncInstalledFromItems(items)
      set({ items, ids: new Set(items.map((r) => String(r.resource_id))), loading: false, loaded: true })
    } catch (err) {
      set({ loading: false })
      toast(`Failed to load wishlist: ${err.message}`)
    }
  },

  /** Cheap id-only load for detail-panel button state (once on first HubView mount). */
  loadIds: async () => {
    try {
      const ids = await window.api.wishlist.ids()
      set({ ids: new Set(ids.map(String)) })
    } catch {}
  },

  toggle: async (resource) => {
    const rid = resource?.resource_id != null ? String(resource.resource_id) : ''
    if (!rid) return
    const wasIn = get().ids.has(rid)
    set((s) => {
      const ids = new Set(s.ids)
      if (wasIn) ids.delete(rid)
      else ids.add(rid)
      return { ids }
    })
    try {
      if (wasIn) await window.api.wishlist.remove(rid)
      else await window.api.wishlist.add(rid, resource)
      await get().load()
    } catch (err) {
      // Revert the optimistic membership change on failure.
      set((s) => {
        const ids = new Set(s.ids)
        if (wasIn) ids.add(rid)
        else ids.delete(rid)
        return { ids }
      })
      toast(`Failed to update wishlist: ${err.message}`)
    }
  },
}))
