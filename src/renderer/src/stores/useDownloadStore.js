import { create } from 'zustand'
import { toast } from '../components/Toast'

function buildIndexes(items) {
  const byHubResourceId = new Map()
  const byPackageRef = new Map()
  for (const d of items) {
    if (d.status === 'cancelled') continue
    if (d.hub_resource_id && !byHubResourceId.has(d.hub_resource_id)) byHubResourceId.set(d.hub_resource_id, d)
    if (d.package_ref) {
      if (!byPackageRef.has(d.package_ref)) byPackageRef.set(d.package_ref, d)
      // Also index by stem (without .var) so library dep refs match
      const stem = d.package_ref.replace(/\.var$/i, '')
      if (stem !== d.package_ref && !byPackageRef.has(stem)) byPackageRef.set(stem, d)
    }
  }
  return { byHubResourceId, byPackageRef }
}

function toastUnresolvableDeps(unresolvedDeps) {
  const deps = unresolvedDeps?.filter(Boolean)
  if (!deps?.length) return
  const n = deps.length
  const listed = deps.slice(0, 3).join(', ') + (n > 3 ? '…' : '')
  const msg = n === 1 ? `Dependency unavailable: ${listed}` : `${n} dependencies unavailable: ${listed}`
  toast(msg)
}

function pruneInactiveLiveProgress(get, set) {
  const items = get().items
  const activeIds = new Set(items.filter((d) => d.status === 'active').map((d) => d.id))
  const lp = get().liveProgress
  const kept = {}
  for (const [id, val] of Object.entries(lp)) {
    if (activeIds.has(Number(id))) kept[id] = val
  }
  set({ liveProgress: kept })
}

export const useDownloadStore = create((set, get) => ({
  items: [],
  liveProgress: {}, // id -> { progress, speed, bytesLoaded, fileSize }
  paused: false,
  initialized: false,
  byHubResourceId: new Map(),
  byPackageRef: new Map(),
  pendingInstalls: new Set(), // hub resource IDs clicked but not yet in queue
  pendingUpdates: new Set(), // library filenames whose Update click hasn't reached the queue yet

  init: () => {
    if (get().initialized) return
    set({ initialized: true })

    get().fetchItems()
    window.api.downloads.isPaused().then((p) => set({ paused: p }))

    window.api.onDownloadsUpdated(() => {
      get().fetchItems()
    })

    window.api.onDownloadProgress((data) => {
      set((state) => ({
        liveProgress: { ...state.liveProgress, [data.id]: data },
      }))
    })

    window.api.onDownloadFailed(({ packageRef, displayName, error }) => {
      const label = (displayName && displayName.trim()) || packageRef || 'Download'
      toast(error ? `Download failed: ${label} — ${error}` : `Download failed: ${label}`)
    })
  },

  fetchItems: async () => {
    try {
      const items = await window.api.downloads.list()
      const indexes = buildIndexes(items)
      set({ items, ...indexes })
    } catch (err) {
      console.error('Failed to fetch downloads:', err)
    }
  },

  install: async (resourceId, hubDetailData, autoQueueDeps = true, packageName, asDependency = false) => {
    const rid = String(resourceId)
    set((s) => {
      const next = new Set(s.pendingInstalls)
      next.add(rid)
      return { pendingInstalls: next }
    })
    try {
      const result = await window.api.packages.install({
        resourceId,
        hubDetail: hubDetailData || null,
        autoQueueDeps,
        packageName,
        asDependency,
      })
      if (result?.unresolvedDeps?.length > 0) toastUnresolvableDeps(result.unresolvedDeps)
    } catch (err) {
      toast(`Install failed: ${err.message}`)
      throw err
    } finally {
      await get().fetchItems()
      set((s) => {
        if (!s.pendingInstalls.has(rid)) return s
        const next = new Set(s.pendingInstalls)
        next.delete(rid)
        return { pendingInstalls: next }
      })
    }
  },

  installUpdate: async (pkg, updateInfo) => {
    if (!pkg?.filename || !updateInfo) return
    if (!updateInfo.hubResourceId && !updateInfo.packageName) return
    const filename = pkg.filename
    set((s) => {
      const next = new Set(s.pendingUpdates)
      next.add(filename)
      return { pendingUpdates: next }
    })
    let result = null
    try {
      result = await window.api.packages.install({
        resourceId: updateInfo.hubResourceId,
        hubDetail: null,
        autoQueueDeps: false,
        packageName: updateInfo.packageName,
        asDependency: !!updateInfo.isDepUpdate,
      })
      if (result?.unresolvedDeps?.length > 0) toastUnresolvableDeps(result.unresolvedDeps)
      // Successful inserts get visual feedback via the button state (Queuing/Queued/Downloading),
      // so we only toast for cases that wouldn't otherwise be acknowledged.
      const inserted = result?.inserted ?? 0
      const alreadyLocal = result?.alreadyLocal ?? 0
      const alreadyQueued = result?.alreadyQueued ?? 0
      const ver = updateInfo.hubVersion ? `v${updateInfo.hubVersion}` : 'update'
      if (inserted === 0 && alreadyQueued > 0) {
        toast(`${ver} is already queued`, 'info', 3000)
      } else if (inserted === 0 && alreadyLocal > 0) {
        toast(`${ver} is already on disk — try a re-scan`, 'info', 3500)
      } else if (inserted > 0 && result?.paused) {
        toast(`${ver} queued — downloads are paused`, 'info', 4000)
      }
    } catch (err) {
      toast(`Update failed: ${err.message}`)
    } finally {
      await get().fetchItems()
      set((s) => {
        if (!s.pendingUpdates.has(filename)) return s
        const next = new Set(s.pendingUpdates)
        next.delete(filename)
        return { pendingUpdates: next }
      })
    }
    return result
  },

  installMissing: async (filename) => {
    try {
      const result = await window.api.packages.installMissing(filename)
      if (result?.unresolvedDeps?.length > 0) toastUnresolvableDeps(result.unresolvedDeps)
      if (result?.queued > 0) toast('Missing dependencies queued', 'success', 3000)
    } catch (err) {
      toast(`Install failed: ${err.message}`)
      throw err
    }
  },

  cancel: async (id) => {
    await window.api.downloads.cancel(id)
  },

  retry: async (id) => {
    await window.api.downloads.retry(id)
  },

  clearCompleted: async () => {
    await window.api.downloads.clearCompleted()
    await get().fetchItems()
    pruneInactiveLiveProgress(get, set)
  },

  clearFailed: async () => {
    await window.api.downloads.clearFailed()
    await get().fetchItems()
    pruneInactiveLiveProgress(get, set)
  },

  removeFailed: async (id) => {
    await window.api.downloads.removeFailed(id)
    await get().fetchItems()
    pruneInactiveLiveProgress(get, set)
  },

  pauseAll: async () => {
    set({ paused: true })
    await window.api.downloads.pauseAll()
    pruneInactiveLiveProgress(get, set)
  },

  resumeAll: async () => {
    set({ paused: false })
    await window.api.downloads.resumeAll()
  },

  cancelAll: async () => {
    set({ paused: false })
    await window.api.downloads.cancelAll()
    await get().fetchItems()
    pruneInactiveLiveProgress(get, set)
  },
}))
