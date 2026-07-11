import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from '@/components/Toast'
import { typeFilterSlice } from './typeFilterSlice'
import { useContentStore } from './useContentStore'
import { persistViewState, oneOf, asArray, asPolarityList, asString, asBool, asCardWidth } from './persistViewState'

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

/**
 * Carry forward `downloadUrl` / `fileSize` from a previous `updateCheckResults`
 * onto a fresh response from `packages:check-updates` (which deliberately leaves
 * those fields absent — see `checkUpdatesFromIndex`). Mutates `next` in place.
 *
 * Always invoked, not just on the no-enrich event-driven path: re-mounting
 * LibraryView reissues an enriching `checkForUpdates`, and without preserving
 * the prior state the UI would otherwise blink every entry to "checking" for the
 * duration of the in-flight findPackages call — including entries the previous
 * check had definitively marked unavailable. That brief window let the user
 * click an Update button whose install path then failed with hub "Resource not
 * found".
 */
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
    if (nonce !== updateCheckNonce) return
    console.warn('Update details enrichment failed:', err)
    // Hub round-trip failed wholesale (server outage, network down, etc.).
    // Mark every still-unknown entry as `downloadUrl: null` so the UI lands on a
    // definitive "unavailable" state instead of leaving the button stuck in its
    // "checking" rendering. Entries that already carry a known value (string or
    // null) from a prior successful enrichment are preserved.
    const current = get().updateCheckResults
    if (!current) return
    const updated = {}
    let dirty = false
    for (const [filename, entry] of Object.entries(current)) {
      if (entry.downloadUrl === undefined) {
        updated[filename] = { ...entry, downloadUrl: null }
        dirty = true
      } else {
        updated[filename] = entry
      }
    }
    if (dirty) set({ updateCheckResults: updated })
  }
}

export const useLibraryStore = create(
  persist(
    (set, get) => ({
      packages: [],
      /** Derived live lookup. Rebuilt in `fetchPackages`; consumed by `useContentStore.relink`
       *  so content rows can attach a `c.package` reference for read-time joins. */
      packageByFilename: new Map(),
      selectedDetail: null,
      /** Multi-select: package filenames */
      bulkSelectedFilenames: [],
      bulkAnchorFilename: null,

      search: '',
      authorSearch: '',
      excludedAuthors: [],
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

      // Backend-provided counts for fields that can't be computed client-side
      backendCounts: null,

      // True after first fetchPackages resolves (distinguishes "no packages" from "still loading")
      packagesLoaded: false,

      /** Active intent of an in-flight bulk `packages.setEnabled` IPC, or null when idle.
       *  Captured at the start so the toolbar label/icon don't flip as packages flip mid-batch. */
      bulkToggleIntent: null,

      setSearch: (search) => set({ search }),
      setAuthorSearch: (authorSearch) => set({ authorSearch }),
      setExcludedAuthors: (excludedAuthors) => set({ excludedAuthors }),
      setStatusFilter: (statusFilter) => set({ statusFilter }),
      setEnabledFilter: (enabledFilter) => set({ enabledFilter }),
      setSelectedTags: (selectedTags) => set({ selectedTags }),
      setSelectedLabelIds: (selectedLabelIds) => set({ selectedLabelIds }),
      setPrimarySort: (primarySort) => set({ primarySort }),
      setSecondarySort: (secondarySort) => set({ secondarySort }),
      setLicense: (license) => set({ license }),
      setViewMode: (viewMode) => set({ viewMode }),
      setCardWidth: (cardWidth) => set({ cardWidth }),
      setCompactCards: (compactCards) => set({ compactCards }),
      setDimInactive: (dimInactive) => {
        set({ dimInactive })
        void window.api.settings.set('dim_inactive_packages', dimInactive ? '1' : '0')
      },
      setSuppressDisablePackageWarning: (suppressDisablePackageWarning) => {
        set({ suppressDisablePackageWarning })
        void window.api.settings.set('suppress_disable_package_warning', suppressDisablePackageWarning ? '1' : '0')
      },

      /** Restore Settings-tab behavior prefs from SQLite. View layout (viewMode/
       *  cardWidth/compactCards) and filters are restored by the persist middleware,
       *  not here — these two have a higher durability expectation so they stay in
       *  SQLite alongside the other Settings-tab toggles. */
      hydrateLibraryVisualPreferences: async () => {
        try {
          const [dimStr, suppressDisableStr] = await Promise.all([
            window.api.settings.get('dim_inactive_packages'),
            window.api.settings.get('suppress_disable_package_warning'),
          ])
          const patch = {}
          if (dimStr === '0') patch.dimInactive = false
          else if (dimStr === '1' || dimStr == null) patch.dimInactive = true
          if (suppressDisableStr === '1') patch.suppressDisablePackageWarning = true
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
        // Only bump the nonce when starting a fresh enrichment pass. Background
        // `packages:updated` refreshes pass enrich=false and must not abort an
        // in-flight enrichment (which would leave downloadUrl stuck at null and
        // then flip to "available" on the next full enrich with stale hub data).
        const nonce = enrich ? ++updateCheckNonce : updateCheckNonce
        set({ updateCheckLoading: true })
        try {
          const data = await window.api.packages.checkUpdates()
          if (nonce !== updateCheckNonce) return
          // Always carry forward any prior `downloadUrl`/`fileSize` so the UI
          // keeps showing the previously-resolved availability while the
          // (optional) re-enrichment runs in the background. Without this merge,
          // every remount-driven recheck would flip entries back to "checking"
          // and render Update buttons as actionable for the duration of the
          // in-flight findPackages — even ones a prior check confirmed unavailable.
          _mergeUpdateEnrichment(get().updateCheckResults, data)
          set({
            updateCheckResults: data,
            updateCheckLoading: false,
            updateCheckLastChecked: Date.now(),
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
          _mergeUpdateEnrichment(get().updateCheckResults, data)
          set({
            updateCheckResults: data,
            updateCheckLoading: false,
            updateCheckLastChecked: Date.now(),
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
          // Seed the bulk list from the current single selection so Ctrl+Click extends it
          // instead of starting from scratch (Card A stays selected when Ctrl+Clicking Card B).
          const base =
            s.bulkSelectedFilenames.length === 0 && s.selectedDetail && s.selectedDetail.filename !== filename
              ? [s.selectedDetail.filename]
              : s.bulkSelectedFilenames
          const had = base.includes(filename)
          const next = had ? base.filter((x) => x !== filename) : [...base, filename]
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
    }),
    persistViewState('library-view', {
      search: asString,
      statusFilter: oneOf(['direct', 'dependency', 'orphan', 'local', 'broken', 'missing', 'updates']),
      enabledFilter: oneOf(['all', 'enabled', 'disabled', 'offloaded']),
      selectedTypes: asArray,
      selectedTags: asPolarityList,
      selectedLabelIds: asPolarityList,
      excludedAuthors: asArray,
      license: asString,
      primarySort: asString,
      secondarySort: asString,
      viewMode: oneOf(['grid', 'table']),
      cardWidth: asCardWidth,
      compactCards: asBool,
    }),
  ),
)
