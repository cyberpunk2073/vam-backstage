import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from '@/components/Toast'
import { typeFilterSlice } from './typeFilterSlice'
import { selectionMutators } from './selection'
import { useLibraryStore } from './useLibraryStore'
import { persistViewState, oneOf, asArray, asPolarityList, asString, asCardWidth, asObject } from './persistViewState'

/**
 * Attach `c.package` references onto a fresh content array. Content rows arrive
 * from main as lean rows (no denormalized package fields); the renderer joins
 * them against `useLibraryStore.packageByFilename` here. Returns a *new* array
 * so React/Zustand subscribers re-render even when a single field on one
 * package changed.
 */
function linkContents(rows, pkgMap) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) out[i] = linkItem(rows[i], pkgMap)
  return out
}

/** Attach `package` / `sourcePackage` to one row, reusing its identity when nothing changed
 *  (so unaffected rows survive a relink without re-rendering). Extracted presets are loose
 *  (`__local__`) files owned by a real package: `sourcePackage` is that owner, used for
 *  lifecycle status + styling; plain rows leave it undefined. */
function linkItem(c, pkgMap = useLibraryStore.getState().packageByFilename) {
  const pkg = pkgMap.get(c.packageFilename)
  const sourcePkg = c.extractedFrom ? pkgMap.get(c.extractedFrom) : undefined
  return c.package === pkg && c.sourcePackage === sourcePkg ? c : { ...c, package: pkg, sourcePackage: sourcePkg }
}

/** An empty selection and the detail-panel caches that hang off it, cleared together. */
const CLEARED_SELECTION = {
  selectedItem: null,
  selectedPackage: null,
  selection: [],
  selectionAnchor: null,
  selectionLead: null,
}

/**
 * Resolve a single content selection: re-seed `selectedItem` from the live row (the id-only
 * paths — arrow keys, collapse, range shrinking to one — have no item object to hand), then
 * fetch its owning package for the detail panel.
 *
 * Both are caches, not selection state: the outgoing values stay in place for the length of
 * the IPC so the panel doesn't blank, and the result is dropped if the selection moved on.
 */
async function _loadItemDetail(set, get, id) {
  let item = get().selectedItem
  if (item?.id !== id) {
    item = get().contents.find((c) => c.id === id)
    if (!item) return
    set({ selectedItem: linkItem(item) })
  }
  try {
    // Extracted presets show their owning package (Extracted from …); plain items show their own.
    const pkg = await window.api.packages.detail(item.extractedFrom || item.packageFilename)
    const { selection } = get()
    if (selection.length === 1 && selection[0] === id) set({ selectedPackage: pkg })
  } catch (err) {
    toast(`Failed to load package detail: ${err.message}`)
    set({ selectedPackage: null })
  }
}

export const FILTER_DEFAULTS = {
  search: '',
  authorSearch: '',
  excludedAuthors: [],
  selectedTypes: [],
  selectedPackageTypes: [],
  selectedTags: [],
  selectedLabelIds: [],
  packageFilter: 'all',
  packageStatusFilter: 'enabled',
  visibilityFilter: 'visible',
}

export const useContentStore = create(
  persist(
    (set, get) => ({
      contents: [],
      selectedItem: null,
      selectedPackage: null, // package detail for the selected item's owning package
      /** Ordered selection of content item ids — see `stores/selection.js`. */
      selection: [],
      selectionAnchor: null,
      selectionLead: null,

      ...FILTER_DEFAULTS,
      ...typeFilterSlice(set, get),
      primarySort: 'Type',
      secondarySort: 'Recently installed',
      viewMode: 'grid',
      cardWidth: 220,
      /** Per-category-label collapse map. Explicit false = collapsed; missing key = expanded. */
      expandedByType: {},

      resetFilters: (overrides) => set({ ...FILTER_DEFAULTS, ...CLEARED_SELECTION, ...overrides }),
      /** Maximum-inclusion filters for viewing all content of a specific package. */
      showPackageContents: (search) =>
        set({
          ...FILTER_DEFAULTS,
          ...CLEARED_SELECTION,
          visibilityFilter: 'all',
          packageFilter: 'all',
          packageStatusFilter: 'all',
          search,
        }),

      togglePackageType: (type) => {
        const { selectedPackageTypes } = get()
        if (type === 'All') {
          set({ selectedPackageTypes: [] })
          return
        }
        const idx = selectedPackageTypes.indexOf(type)
        set({
          selectedPackageTypes:
            idx >= 0 ? selectedPackageTypes.filter((t) => t !== type) : [...selectedPackageTypes, type],
        })
      },
      selectSinglePackageType: (type) => {
        if (type === 'All') {
          set({ selectedPackageTypes: [] })
          return
        }
        const { selectedPackageTypes } = get()
        set({
          selectedPackageTypes: selectedPackageTypes.length === 1 && selectedPackageTypes[0] === type ? [] : [type],
        })
      },

      setSearch: (search) => set({ search }),
      setAuthorSearch: (authorSearch) => set({ authorSearch }),
      setExcludedAuthors: (excludedAuthors) => set({ excludedAuthors }),
      setSelectedTags: (selectedTags) => set({ selectedTags }),
      setSelectedLabelIds: (selectedLabelIds) => set({ selectedLabelIds }),
      setPackageFilter: (packageFilter) => set({ packageFilter }),
      setPackageStatusFilter: (packageStatusFilter) => set({ packageStatusFilter }),
      setVisibilityFilter: (visibilityFilter) => set({ visibilityFilter }),
      setPrimarySort: (primarySort) => set({ primarySort }),
      setSecondarySort: (secondarySort) => set({ secondarySort }),
      setViewMode: (viewMode) => set({ viewMode }),
      setCardWidth: (cardWidth) => set({ cardWidth }),

      toggleCategory: (type) =>
        set((s) => {
          const cur = s.expandedByType[type] ?? true
          return { expandedByType: { ...s.expandedByType, [type]: !cur } }
        }),

      fetchContents: async () => {
        try {
          // Block on `fetchPackages` if we haven't loaded packages yet — content
          // rows reference packages via `c.package`, so linking against an empty
          // map would render rows with `package: undefined` on first paint.
          // The library store dedupe gate makes this a no-op when a fetch is
          // already in flight (e.g. kicked off from App on mount).
          if (!useLibraryStore.getState().packagesLoaded) {
            await useLibraryStore.getState().fetchPackages()
          }
          const contents = await window.api.contents.list({})
          const pkgMap = useLibraryStore.getState().packageByFilename
          set({ contents: linkContents(contents, pkgMap) })
        } catch (err) {
          console.error('Failed to fetch contents:', err)
        }
      },

      /**
       * Reattach `c.package` on every existing content row using the current
       * `packageByFilename` map. Called by `useLibraryStore.fetchPackages` after
       * each refetch so content-side UI sees fresh package fields without an
       * IPC round-trip. No-op when contents haven't been loaded yet.
       *
       * Also re-links `selectedItem` so the detail panel's `item.package?.*`
       * reads stay in sync after a package mutation.
       */
      relink: () => {
        const { contents, selectedItem } = get()
        if (!contents.length && !selectedItem) return
        const pkgMap = useLibraryStore.getState().packageByFilename
        const patch = {}
        if (contents.length) patch.contents = linkContents(contents, pkgMap)
        if (selectedItem) patch.selectedItem = linkItem(selectedItem, pkgMap)
        set(patch)
      },

      ...selectionMutators(set, get, (id) => _loadItemDetail(set, get, id), {
        isLive: ({ contents }) => {
          const live = new Set(contents.map((c) => c.id))
          return (id) => live.has(id)
        },
      }),

      /** Single-pick entry point. Seeds the cache from the row it was handed so the panel
       *  switches on the same frame — and so items absent from `contents` can still be shown. */
      selectItem: (item) => {
        if (!item) return Promise.resolve()
        set({ selectedItem: linkItem(item) })
        return get().setSelection(item.id)
      },

      clearSelection: () => set({ ...CLEARED_SELECTION }),

      refreshSelection: async () => {
        const { selectedItem } = get()
        if (!selectedItem) return
        try {
          const items = await window.api.contents.list({ packageFilename: selectedItem.packageFilename })
          const fresh = items.find((c) => c.id === selectedItem.id)
          if (fresh) set({ selectedItem: linkItem(fresh) })
          const pkg = await window.api.packages.detail(
            (fresh ?? selectedItem).extractedFrom || selectedItem.packageFilename,
          )
          set({ selectedPackage: pkg })
        } catch {}
      },

      /**
       * Refresh just `selectedPackage` (the detail-panel package object) for the
       * currently selected content item. Used on `packages:updated`, where the
       * content row itself is unchanged (its `c.package` ref is refreshed by
       * `relink`) but the heavier detail shape — dep tree, dependents, contents
       * grouped by category — needs a `packages:detail` IPC to refresh.
       * Stale-write guard: drops the result if the user changed selection mid-fetch.
       */
      refreshSelectedPackageDetail: async () => {
        const sel = get().selectedItem
        if (!sel?.packageFilename) return
        const ownerFilename = sel.extractedFrom || sel.packageFilename
        try {
          const pkg = await window.api.packages.detail(ownerFilename)
          const cur = get().selectedItem
          if (cur && (cur.extractedFrom || cur.packageFilename) === ownerFilename) {
            set({ selectedPackage: pkg })
          }
        } catch {}
      },
    }),
    persistViewState('content-view', {
      search: asString,
      selectedTypes: asArray,
      selectedPackageTypes: asArray,
      selectedTags: asPolarityList,
      selectedLabelIds: asPolarityList,
      excludedAuthors: asArray,
      packageFilter: oneOf(['all', 'installed', 'dependency', 'local']),
      packageStatusFilter: oneOf(['all', 'enabled', 'disabled', 'archived']),
      visibilityFilter: oneOf(['all', 'visible', 'hidden', 'favorites']),
      primarySort: asString,
      secondarySort: asString,
      viewMode: oneOf(['grid', 'table']),
      cardWidth: asCardWidth,
      expandedByType: asObject,
    }),
  ),
)
