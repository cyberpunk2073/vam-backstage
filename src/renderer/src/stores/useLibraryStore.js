import { create } from 'zustand'
import { toast } from '../components/Toast'
import { typeFilterSlice } from './typeFilterSlice'

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
  if (!stems.length) return
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
    set({ updateCheckResults: updated })
  } catch (err) {
    console.warn('Update details enrichment failed:', err)
  }
}

export const useLibraryStore = create((set, get) => ({
  packages: [],
  selectedDetail: null,
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

  // Missing deps (lazy loaded when missing filter activates)
  missingDeps: null,
  missingDepsLoading: false,
  hubDetailsLoading: false,

  // Update check results
  updateCheckResults: null,
  updateCheckLoading: false,
  updateCheckLastChecked: null,

  // Backend-provided counts for fields that can't be computed client-side
  backendCounts: null,

  // True after first fetchPackages resolves (distinguishes "no packages" from "still loading")
  packagesLoaded: false,

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
  setDimInactive: (dimInactive) => {
    set({ dimInactive })
    void window.api.settings.set('dim_inactive_packages', dimInactive ? '1' : '0')
  },

  hydrateLibraryVisualPreferences: async () => {
    try {
      const [vm, widthStr, compactStr, dimStr] = await Promise.all([
        window.api.settings.get('library_view_mode'),
        window.api.settings.get('library_card_width'),
        window.api.settings.get('library_compact_cards'),
        window.api.settings.get('dim_inactive_packages'),
      ])
      const patch = {}
      if (vm === 'grid' || vm === 'table') patch.viewMode = vm
      const w = parseInt(String(widthStr ?? ''), 10)
      if (!Number.isNaN(w) && w >= 100 && w <= 500) patch.cardWidth = w
      if (compactStr === '1' || compactStr === '0') patch.compactCards = compactStr === '1'
      if (dimStr === '0') patch.dimInactive = false
      else if (dimStr === '1' || dimStr == null) patch.dimInactive = true
      if (Object.keys(patch).length) set(patch)
    } catch {}
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
            set({ packages, packagesLoaded: true })
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
      set({ updateCheckResults: data, updateCheckLoading: false, updateCheckLastChecked: Date.now() })
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
      set({ updateCheckResults: data, updateCheckLoading: false, updateCheckLastChecked: Date.now() })
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
      set({ selectedDetail: null, bulkSelectedFilenames: [], bulkAnchorFilename: null })
      return
    }
    try {
      const detail = await window.api.packages.detail(filename)
      set({ selectedDetail: detail, bulkSelectedFilenames: [], bulkAnchorFilename: null })
    } catch (err) {
      toast(`Failed to load package detail: ${err.message}`)
    }
  },

  clearSelection: () => set({ selectedDetail: null }),

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
