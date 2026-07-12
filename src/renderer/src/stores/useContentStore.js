import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from '@/components/Toast'
import { typeFilterSlice } from './typeFilterSlice'
import { useLibraryStore } from './useLibraryStore'
import { persistViewState, oneOf, asArray, asPolarityList, asString, asCardWidth, asObject } from './persistViewState'

/**
 * Attach `c.package` references onto a fresh content array. Content rows arrive
 * from main as lean rows (no denormalized package fields); the renderer joins
 * them against `useLibraryStore.packageByFilename` here. Returns a *new* array
 * so React/Zustand subscribers re-render even when a single field on one
 * package changed.
 *
 * Skips reallocation when the linked package is already the same object
 * identity, which lets unaffected rows keep their identity if/when packages
 * are ever updated in place rather than full-replaced.
 */
function linkContents(rows, pkgMap) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i]
    const pkg = pkgMap.get(c.packageFilename)
    // Extracted presets are loose (`__local__`) files owned by a real package.
    // `sourcePackage` is that owner, used for lifecycle status + styling; plain
    // rows leave it undefined.
    const sourcePkg = c.extractedFrom ? pkgMap.get(c.extractedFrom) : undefined
    out[i] = c.package === pkg && c.sourcePackage === sourcePkg ? c : { ...c, package: pkg, sourcePackage: sourcePkg }
  }
  return out
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
      /** Multi-select: content item ids (same type as item.id) */
      bulkSelectedIds: [],
      bulkAnchorId: null,

      ...FILTER_DEFAULTS,
      ...typeFilterSlice(set, get),
      primarySort: 'Type',
      secondarySort: 'Recently installed',
      viewMode: 'grid',
      cardWidth: 220,
      /** Per-category-label collapse map. Explicit false = collapsed; missing key = expanded. */
      expandedByType: {},

      resetFilters: (overrides) =>
        set({
          ...FILTER_DEFAULTS,
          selectedItem: null,
          selectedPackage: null,
          bulkSelectedIds: [],
          bulkAnchorId: null,
          ...overrides,
        }),
      /** Maximum-inclusion filters for viewing all content of a specific package. */
      showPackageContents: (search) =>
        set({
          ...FILTER_DEFAULTS,
          visibilityFilter: 'all',
          packageFilter: 'all',
          packageStatusFilter: 'all',
          search,
          selectedItem: null,
          selectedPackage: null,
          bulkSelectedIds: [],
          bulkAnchorId: null,
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
        if (selectedItem) {
          const nextPkg = pkgMap.get(selectedItem.packageFilename)
          const nextSourcePkg = selectedItem.extractedFrom ? pkgMap.get(selectedItem.extractedFrom) : undefined
          patch.selectedItem =
            selectedItem.package === nextPkg && selectedItem.sourcePackage === nextSourcePkg
              ? selectedItem
              : { ...selectedItem, package: nextPkg, sourcePackage: nextSourcePkg }
        }
        set(patch)
      },

      selectItem: async (item) => {
        if (!item) {
          set({ selectedItem: null, selectedPackage: null, bulkSelectedIds: [], bulkAnchorId: null })
          return
        }
        const pkgMap = useLibraryStore.getState().packageByFilename
        const nextPkg = pkgMap.get(item.packageFilename)
        const sourcePkg = item.extractedFrom ? pkgMap.get(item.extractedFrom) : undefined
        const linkedItem =
          item.package === nextPkg && item.sourcePackage === sourcePkg
            ? item
            : { ...item, package: nextPkg, sourcePackage: sourcePkg }
        set({ selectedItem: linkedItem, bulkSelectedIds: [], bulkAnchorId: null })
        try {
          // Extracted presets show their owning package (Extracted from …); plain
          // items show their own package.
          const pkg = await window.api.packages.detail(item.extractedFrom || item.packageFilename)
          set({ selectedPackage: pkg })
        } catch (err) {
          toast(`Failed to load package detail: ${err.message}`)
          set({ selectedPackage: null })
        }
      },

      clearSelection: () => set({ selectedItem: null, selectedPackage: null }),

      toggleBulkSelect: (id) =>
        set((s) => {
          // Seed the bulk list from the current single selection so Ctrl+Click extends it
          // instead of starting from scratch (Card A stays selected when Ctrl+Clicking Card B).
          const base =
            s.bulkSelectedIds.length === 0 && s.selectedItem && s.selectedItem.id !== id
              ? [s.selectedItem.id]
              : s.bulkSelectedIds
          const had = base.includes(id)
          const next = had ? base.filter((x) => x !== id) : [...base, id]
          return {
            bulkSelectedIds: next,
            bulkAnchorId: id,
            ...(next.length > 0 ? { selectedItem: null, selectedPackage: null } : {}),
          }
        }),

      rangeBulkSelect: (id, orderedIds, anchorId) =>
        set((s) => {
          const anchor = anchorId ?? s.bulkAnchorId ?? id
          const i1 = orderedIds.indexOf(anchor)
          const i2 = orderedIds.indexOf(id)
          if (i1 < 0 || i2 < 0) {
            const next = s.bulkSelectedIds.includes(id)
              ? s.bulkSelectedIds.filter((x) => x !== id)
              : [...s.bulkSelectedIds, id]
            return {
              bulkSelectedIds: next,
              bulkAnchorId: id,
              ...(next.length > 0 ? { selectedItem: null, selectedPackage: null } : {}),
            }
          }
          const lo = Math.min(i1, i2)
          const hi = Math.max(i1, i2)
          const range = orderedIds.slice(lo, hi + 1)
          const setIds = new Set([...s.bulkSelectedIds, ...range])
          const merged = orderedIds.filter((x) => setIds.has(x))
          return {
            bulkSelectedIds: merged,
            bulkAnchorId: id,
            selectedItem: null,
            selectedPackage: null,
          }
        }),

      selectAllBulk: (orderedIds) =>
        set({
          bulkSelectedIds: [...orderedIds],
          bulkAnchorId: orderedIds[orderedIds.length - 1] ?? null,
          selectedItem: null,
          selectedPackage: null,
        }),

      clearBulkSelection: () => set({ bulkSelectedIds: [], bulkAnchorId: null }),

      refreshSelection: async () => {
        const { selectedItem } = get()
        if (!selectedItem) return
        try {
          const items = await window.api.contents.list({ packageFilename: selectedItem.packageFilename })
          const fresh = items.find((c) => c.id === selectedItem.id)
          if (fresh) {
            const pkgMap = useLibraryStore.getState().packageByFilename
            set({
              selectedItem: {
                ...fresh,
                package: pkgMap.get(fresh.packageFilename),
                sourcePackage: fresh.extractedFrom ? pkgMap.get(fresh.extractedFrom) : undefined,
              },
            })
          }
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
      packageStatusFilter: oneOf(['all', 'enabled', 'disabled']),
      visibilityFilter: oneOf(['all', 'visible', 'hidden', 'favorites']),
      primarySort: asString,
      secondarySort: asString,
      viewMode: oneOf(['grid', 'table']),
      cardWidth: asCardWidth,
      expandedByType: asObject,
    }),
  ),
)
