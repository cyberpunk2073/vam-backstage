import { create } from 'zustand'
import { toast } from '@/components/Toast'
import { useInstalledStore } from './useInstalledStore'
import { useHubStore } from './useHubStore'

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

function applyPayload(data, set) {
  const items = data?.resources || []
  syncInstalledFromItems(items)
  set({
    items,
    scannedAt: data?.scannedAt ?? null,
    loaded: true,
    loading: false,
    scanning: false,
    scanProgress: null,
  })
}

function catalogScanToast(data) {
  const total = (data?.resources || []).length
  const totalLabel = `${total.toLocaleString()} packages`
  const { delta, added = 0, updated = 0 } = data?.stats || {}
  if (!delta) return `Catalog saved (${totalLabel})`
  if (!added && !updated) return `Catalog up to date (${totalLabel})`
  const parts = []
  if (added) parts.push(`${added.toLocaleString()} new`)
  if (updated) parts.push(`${updated.toLocaleString()} updated`)
  return `Catalog updated — ${parts.join(', ')} (${totalLabel})`
}

/** Settings key — `'1'` enables the Offline Hub tab (default off). */
export const HUB_OFFLINE_CATALOG_SETTING = 'hub_offline_catalog'

/**
 * Offline Hub catalog — full getResources dump loaded from a JSON file under
 * userData. Not persisted in zustand; disk is the source of truth.
 * Gated by `enabled` (Developer setting); default disabled.
 * In-memory `items` are kept only while the Offline tab is active (see `unload`).
 */
export const useCatalogStore = create((set, get) => ({
  enabled: false,
  items: [],
  scannedAt: null,
  loading: false,
  loaded: false,
  scanning: false,
  scanProgress: null,

  loadEnabled: async () => {
    try {
      const v = await window.api.settings.get(HUB_OFFLINE_CATALOG_SETTING)
      set({ enabled: v === '1' })
    } catch {
      set({ enabled: false })
    }
  },

  setEnabled: async (enabled) => {
    const on = !!enabled
    set({ enabled: on })
    await window.api.settings.set(HUB_OFFLINE_CATALOG_SETTING, on ? '1' : '0')
    if (!on) {
      if (get().scanning) get().cancelScan()
      get().unload()
    }
  },

  load: async () => {
    if (!get().enabled || get().scanning) return
    set({ loading: true })
    try {
      const data = await window.api.hub.catalogLoad()
      if (!data?.resources) {
        set({ items: [], scannedAt: null, loaded: true, loading: false })
        return
      }
      applyPayload(data, set)
    } catch (err) {
      set({ loading: false, loaded: true })
      toast(`Failed to load catalog: ${err.message}`)
    }
  },

  /**
   * Drop in-memory rows when leaving Offline (disk cache unchanged).
   * Does not cancel a running scan — main keeps writing; on completion HubView
   * unloads again if Offline is still hidden.
   */
  unload: () => {
    set({ items: [], loaded: false, loading: false, scanProgress: null })
  },

  /**
   * Reconcile `_installed` / `_isDirect` after library changes (no disk re-read).
   * Uses a library-sized hub snapshot, not one IPC id per catalog row.
   */
  refreshInstallState: async () => {
    const { items, loaded, scanning } = get()
    if (!loaded || scanning || !items.length) return
    let snapshot = {}
    try {
      snapshot = await window.api.hub.localSnapshot()
    } catch {
      return
    }
    let changed = false
    const next = items.map((r) => {
      const local = snapshot[String(r.resource_id)]
      if (local) {
        if (r._installed && r._isDirect === !!local.is_direct && r._localFilename === local.filename) return r
        changed = true
        return { ...r, _installed: true, _isDirect: !!local.is_direct, _localFilename: local.filename }
      }
      if (r._installed || r._localFilename != null) {
        changed = true
        return { ...r, _installed: false, _isDirect: false, _localFilename: undefined }
      }
      return r
    })
    if (!changed) return
    syncInstalledFromItems(next)
    set({ items: next })
  },

  startScan: async () => {
    if (!get().enabled || get().scanning) return
    set({ scanning: true, scanProgress: { page: 0, totalPages: 0, count: 0 } })
    try {
      const data = await window.api.hub.catalogScan()
      // Disk is already written. Only keep rows in RAM if Offline is still open.
      if (useHubStore.getState().galleryMode === 'offline') applyPayload(data, set)
      else {
        set({
          scanning: false,
          scanProgress: null,
          scannedAt: data?.scannedAt ?? null,
          items: [],
          loaded: false,
          loading: false,
        })
      }
      toast(catalogScanToast(data), 'success')
    } catch (err) {
      set({ scanning: false, scanProgress: null })
      if (!/cancelled/i.test(err.message)) toast(`Catalog scan failed: ${err.message}`)
    }
  },

  cancelScan: () => {
    window.api.hub.catalogScanCancel()
  },
}))
