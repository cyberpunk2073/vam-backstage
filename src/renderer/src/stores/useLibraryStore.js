import { create } from 'zustand'
import { toast } from '@/components/Toast'
import { sanitizeLibraryState } from '@/lib/view-state'
import { typeFilterSlice } from './typeFilterSlice'
import { useContentStore } from './useContentStore'

let missingDepsNonce = 0
let updateCheckNonce = 0

// Coalesces concurrent fetchPackages requests. During startup the main process
// fires several `packages:updated` events back-to-back (post-scan notify,
// scanHubDetails interim, scanHubDetails final), and each would otherwise
// serialize 1700+ rows through IPC and replace the entire packages array,
// re-rendering every visible card. With this gate, repeated requests while one
// is in flight collapse into a single trailing refetch — at most 2 fetches per
// burst regardless of how many notifies arrive.
let packagesFetchInFlight = null
let packagesFetchQueued = false

function _mergeUpdateEnrichment(prev, next) {
  if (!prev) return
  for (const [filename, entry] of Object.entries(next)) {
    const prevEntry = prev[filename]
    if (prevEntry?.downloadUrl !== undefined) {
      entry.downloadUrl = prevEntry.downloadUrl
      entry.fileSize = prevEntry.fileSize
    }
  }
}

async function _enrichUpdateCheck(nonce, set, get) {
  const results = get().updateCheckResults
  if (!results) return
  const stems = []
  for (const entry of Object.values(results)) {
    if (!entry.localNewerFilename) stems.push(entry.hubFilename.replace(/\.var$/i, ''))
  }
  if (!stems.length) {
    set({ updateDetailsLoading: false })
    return
  }
  try {
    const details = await window.api.packages.enrichFromHub(stems)
    if (nonce !== updateCheckNonce) return
    const current = get().updateCheckResults
    if (!current) return
    const updated = {}
    for (const [filename, entry] of Object.entries(current)) {
      const stem = entry.hubFilename.replace(/\.var$/i, '')
      const detail = details[stem]
      updated[filename] = detail ? { ...entry, downloadUrl: detail.downloadUrl, fileSize: detail.fileSize } : entry
    }
    set({ updateCheckResults: updated, updateDetailsLoading: false })
  } catch (err) {
    if (nonce !== updateCheckNonce) return
    console.warn('Update details enrichment failed:', err)
    set({ updateDetailsLoading: false })
  }
}

export const useLibraryStore = create((set, get) => ({
  packages: [],
  /** Derived live lookup. Rebuilt in `fetchPackages`; consumed by `useContentStore.relink`
   *  so content rows can attach a `c.package` reference for read-time joins. */
  packageByFilename: new Map(),
  selectedDetail: null,
  pendingRestoreFilename: null,
  scrollAnchorFilename: null,
  /** Multi-select: package filenames */
  bulkSelectedFilenames: [],
  bulkAnchorFilename: null,

  search: '',
  authorSearch: '',
  statusFilter: 'direct',
  enabledFilter: 'all',
  ...typeFilterSlice(set, get),
  selectedTags: [],
  selectedLabelIds: [],
  primarySort: 'Type',
  secondarySort: 'Recently installed',
  license: 'Any',
  viewMode: 'grid',
  cardWidth: 220,
  compactCards: false,
  dimInactive: true,
  /** When true, skip the dependency/cascade confirmation when disabling a package */
  suppressDisablePackageWarning: false,

  // Missing deps (lazy loaded when missing filter activates)
  missingDeps: null,
  missingDepsLoading: false,
  hubDetailsLoading: false,

  // Update check results
  updateCheckResults: null,
  updateCheckLoading: false,
  updateCheckLastChecked: null,
  /** True while hub `downloadUrl`/`fileSize` enrichment for update entries is in flight.
   *  Used to distinguish "still checking" from "checked, not directly downloadable" in the UI. */
  updateDetailsLoading: false,

  // Backend-provided counts for fields that can't be computed client-side
  backendCounts: null,

  // True after first fetchPackages resolves (distinguishes "no packages" from "still loading")
  packagesLoaded: false,

  /** Active intent of an in-flight bulk `packages.setEnabled` IPC, or null when idle.
   *  Captured at the start so the toolbar label/icon don't flip as packages flip mid-batch. */
  bulkToggleIntent: null,

  setSearch: (search) => set({ search }),
  setAuthorSearch: (authorSearch) => set({ authorSearch }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setEnabledFilter: (enabledFilter) => set({ enabledFilter }),
  setSelectedTags: (selectedTags) => set({ selectedTags }),
  setSelectedLabelIds: (selectedLabelIds) => set({ selectedLabelIds }),
  setPrimarySort: (primarySort) => set({ primarySort }),
  setSecondarySort: (secondarySort) => set({ secondarySort }),
  setLicense: (license) => set({ license }),
  setViewMode: (viewMode) => {
    set({ viewMode })
    void window.api.settings.set('library_view_mode', viewMode)
  },
  setCardWidth: (cardWidth) => {
    set({ cardWidth })
    void window.api.settings.set('library_card_width', String(cardWidth))
  },
  setCompactCards: (compactCards) => {
    set({ compactCards })
    void window.api.settings.set('library_compact_cards', compactCards ? '1' : '0')
  },
  setScrollAnchorFilename: (scrollAnchorFilename) =>
    set((s) => {
      const next = scrollAnchorFilename || null
      return s.scrollAnchorFilename === next ? s : { scrollAnchorFilename: next }
    }),
  setDimInactive: (dimInactive) => {
    set({ dimInactive })
    void window.api.settings.set('dim_inactive_packages', dimInactive ? '1' : '0')
  },
  setSuppressDisablePackageWarning: (suppressDisablePackageWarning) => {
    set({ suppressDisablePackageWarning })
    void window.api.settings.set('suppress_disable_package_warning', suppressDisablePackageWarning ? '1' : '0')
  },

  hydrateLibraryVisualPreferences: async () => {
    try {
      const [vm, widthStr, compactStr, dimStr, suppressDisableStr] = await Promise.all([
        window.api.settings.get('library_view_mode'),
        window.api.settings.get('library_card_width'),
        window.api.settings.get('library_compact_cards'),
        window.api.settings.get('dim_inactive_packages'),
        window.api.settings.get('suppress_disable_package_warning'),
      ])
      const patch = {}
      if (vm === 'grid' || vm === 'table') patch.viewMode = vm
      const w = parseInt(String(widthStr ?? ''), 10)
      if (!Number.isNaN(w) && w >= 100 && w <= 500) patch.cardWidth = w
      if (compactStr === '1' || compactStr === '0') patch.compactCards = compactStr === '1'
      if (dimStr === '0') patch.dimInactive = false
      else if (dimStr === '1' || dimStr == null) patch.dimInactive = true
      if (suppressDisableStr === '1') patch.suppressDisablePackageWarning = true
      if (Object.keys(patch).length) set(patch)
    } catch {}
  },

  getPersistedState: () => {
    const s = get()
    return {
      search: s.search,
      authorSearch: s.authorSearch,
      statusFilter: s.statusFilter,
      enabledFilter: s.enabledFilter,
      selectedTypes: s.selectedTypes,
      selectedTags: s.selectedTags,
      selectedLabelIds: s.selectedLabelIds,
      primarySort: s.primarySort,
      secondarySort: s.secondarySort,
      license: s.license,
      selectedFilename: s.selectedDetail?.filename ?? s.pendingRestoreFilename ?? null,
      scrollAnchorFilename: s.scrollAnchorFilename,
    }
  },

  applyPersistedState: (raw) => {
    const saved = sanitizeLibraryState(raw)
    set({
      search: saved.search,
      authorSearch: saved.authorSearch,
      statusFilter: saved.statusFilter,
      enabledFilter: saved.enabledFilter,
      selectedTypes: saved.selectedTypes,
      selectedTags: saved.selectedTags,
      selectedLabelIds: saved.selectedLabelIds,
      primarySort: saved.primarySort,
      secondarySort: saved.secondarySort,
      license: saved.license,
      pendingRestoreFilename: saved.selectedFilename,
      scrollAnchorFilename: saved.scrollAnchorFilename,
    })
  },

  consumePendingRestoreFilename: () => {
    const filename = get().pendingRestoreFilename
    set({ pendingRestoreFilename: null })
    return filename
  },

  fetchPackages: async () => {
    if (packagesFetchInFlight) {
      packagesFetchQueued = true
      return packagesFetchInFlight
    }
    packagesFetchInFlight = (async () => {
      try {
        do {
          packagesFetchQueued = false
          try {
            const packages = await window.api.packages.list({})
            const packageByFilename = new Map()
            for (const p of packages) packageByFilename.set(p.filename, p)
            set({ packages, packageByFilename, packagesLoaded: true })
            // Refresh `c.package` references on every content row so any UI
            // reading package fields off content (e.g. ContentView filters,
            // disabled badge dim) picks up the new package object identities
            // without a `contents:list` round-trip.
            useContentStore.getState().relink()
          } catch (err) {
            console.error('Failed to fetch packages:', err)
            set({ packagesLoaded: true })
          }
        } while (packagesFetchQueued)
      } finally {
        packagesFetchInFlight = null
      }
    })()
    return packagesFetchInFlight
  },

  fetchBackendCounts: async () => {
    try {
      const counts = await window.api.packages.statusCounts()
      set({ backendCounts: counts })
    } catch {}
  },

  fetchMissingDeps: async ({ enrich = true } = {}) => {
    const nonce = ++missingDepsNonce
    set({ missingDepsLoading: true })
    try {
      const data = await window.api.packages.missingDeps()
      if (nonce !== missingDepsNonce) return

      // Carry over previously-enriched hub details so we don't lose them on event-driven refreshes
      if (!enrich) {
        const prev = get().missingDeps
        if (prev) {
          const prevByRef = new Map()
          for (const d of prev) {
            if (d.hub?.downloadUrl !== undefined) prevByRef.set(d.ref, d.hub)
          }
          for (const dep of data) {
            if (!dep.hub?.filename) continue
            const prevHub = prevByRef.get(dep.ref)
            if (prevHub && prevHub.filename === dep.hub.filename) {
              dep.hub.fileSize = prevHub.fileSize
              dep.hub.downloadUrl = prevHub.downloadUrl
            }
          }
        }
      }

      set({ missingDeps: data, missingDepsLoading: false })
    } catch (err) {
      if (nonce !== missingDepsNonce) return
      console.error('Failed to fetch missing deps:', err)
      set({ missingDepsLoading: false })
      return
    }

    if (!enrich) return

    // Phase 2: enrich available items with Hub file details (size, download URL)
    const data = get().missingDeps
    if (!data?.length) return
    const stems = []
    for (const dep of data) {
      if (dep.hub?.filename && !dep.hub.installedLocally) {
        stems.push(dep.hub.filename.replace(/\.var$/i, ''))
      }
    }
    if (!stems.length) return
    set({ hubDetailsLoading: true })
    try {
      const details = await window.api.packages.enrichFromHub(stems)
      if (nonce !== missingDepsNonce) return
      const current = get().missingDeps
      if (!current) return
      set({
        missingDeps: current.map((dep) => {
          if (!dep.hub?.filename) return dep
          const stem = dep.hub.filename.replace(/\.var$/i, '')
          const detail = details[stem]
          if (!detail) return dep
          return { ...dep, hub: { ...dep.hub, fileSize: detail.fileSize, downloadUrl: detail.downloadUrl } }
        }),
        hubDetailsLoading: false,
      })
    } catch (err) {
      if (nonce !== missingDepsNonce) return
      console.warn('Hub details enrichment failed:', err)
      set({ hubDetailsLoading: false })
    }
  },

  checkForUpdates: async ({ enrich = true } = {}) => {
    const nonce = ++updateCheckNonce
    set({ updateCheckLoading: true })
    try {
      const data = await window.api.packages.checkUpdates()
      if (nonce !== updateCheckNonce) return
      if (!enrich) _mergeUpdateEnrichment(get().updateCheckResults, data)
      // Set updateDetailsLoading=true atomically with the results so the UI never sees
      // an interim state where every entry has downloadUrl=null but the loading flag is
      // false (which would briefly mark all updates as "unavailable").
      set({
        updateCheckResults: data,
        updateCheckLoading: false,
        updateCheckLastChecked: Date.now(),
        updateDetailsLoading: enrich,
      })
    } catch (err) {
      if (nonce !== updateCheckNonce) return
      console.error('Update check failed:', err)
      set({ updateCheckLoading: false })
      return
    }
    if (enrich) _enrichUpdateCheck(nonce, set, get)
  },

  refreshUpdateCheck: async () => {
    const nonce = ++updateCheckNonce
    set({ updateCheckLoading: true })
    try {
      const data = await window.api.packages.checkUpdates({ forceRefresh: true })
      if (nonce !== updateCheckNonce) return
      set({
        updateCheckResults: data,
        updateCheckLoading: false,
        updateCheckLastChecked: Date.now(),
        updateDetailsLoading: true,
      })
    } catch (err) {
      if (nonce !== updateCheckNonce) return
      console.error('Update check failed:', err)
      set({ updateCheckLoading: false })
      return
    }
    _enrichUpdateCheck(nonce, set, get)
  },

  selectPackage: async (filename) => {
    if (!filename) {
      set({ selectedDetail: null, pendingRestoreFilename: null, bulkSelectedFilenames: [], bulkAnchorFilename: null })
      return
    }
    try {
      const detail = await window.api.packages.detail(filename)
      set({ selectedDetail: detail, pendingRestoreFilename: null, bulkSelectedFilenames: [], bulkAnchorFilename: null })
    } catch (err) {
      toast(`Failed to load package detail: ${err.message}`)
    }
  },

  clearSelection: () => set({ selectedDetail: null, pendingRestoreFilename: null }),

  toggleBulkSelect: (filename) =>
    set((s) => {
      const had = s.bulkSelectedFilenames.includes(filename)
      const next = had ? s.bulkSelectedFilenames.filter((x) => x !== filename) : [...s.bulkSelectedFilenames, filename]
      return {
        bulkSelectedFilenames: next,
        bulkAnchorFilename: filename,
        ...(next.length > 0 ? { selectedDetail: null } : {}),
      }
    }),

  rangeBulkSelect: (filename, orderedFilenames, anchorFilename) =>
    set((s) => {
      const anchor = anchorFilename ?? s.bulkAnchorFilename ?? filename
      const i1 = orderedFilenames.indexOf(anchor)
      const i2 = orderedFilenames.indexOf(filename)
      if (i1 < 0 || i2 < 0) {
        const next = s.bulkSelectedFilenames.includes(filename)
          ? s.bulkSelectedFilenames.filter((x) => x !== filename)
          : [...s.bulkSelectedFilenames, filename]
        return {
          bulkSelectedFilenames: next,
          bulkAnchorFilename: filename,
          ...(next.length > 0 ? { selectedDetail: null } : {}),
        }
      }
      const lo = Math.min(i1, i2)
      const hi = Math.max(i1, i2)
      const range = orderedFilenames.slice(lo, hi + 1)
      const setFn = new Set([...s.bulkSelectedFilenames, ...range])
      const merged = orderedFilenames.filter((x) => setFn.has(x))
      return {
        bulkSelectedFilenames: merged,
        bulkAnchorFilename: filename,
        selectedDetail: null,
      }
    }),

  selectAllBulk: (orderedFilenames) =>
    set({
      bulkSelectedFilenames: [...orderedFilenames],
      bulkAnchorFilename: orderedFilenames[orderedFilenames.length - 1] ?? null,
      selectedDetail: null,
    }),

  clearBulkSelection: () => set({ bulkSelectedFilenames: [], bulkAnchorFilename: null }),

  refreshDetail: async () => {
    const { selectedDetail } = get()
    if (selectedDetail) {
      try {
        const detail = await window.api.packages.detail(selectedDetail.filename)
        if (get().selectedDetail?.filename === selectedDetail.filename) set({ selectedDetail: detail })
      } catch {}
    }
  },
}))
