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

/** Apply a new selection array: length 1 promotes to detail, longer stays bulk. */
function commitContentSelection(get, set, next, anchorId) {
  if (next.length === 0) return
  if (next.length === 1) {
    const item = get().contents.find((c) => c.id === next[0])
    if (item) {
      void get().selectItem(item)
      return
    }
  }
  set({ bulkSelectedIds: next, bulkAnchorId: anchorId })
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

      /**
       * Selection model: `bulkSelectedIds` is always the ordered selection.
       * Length 1 → detail panel (`selectedItem` / `selectedPackage` are the cache).
       * Length > 1 → bulk/gallery. Never empty while contents exist; auto-select refills.
       */
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
        // `selectedPackage` is a cache, not selection state: leave the outgoing one in place so the
        // panel's package row doesn't blank for the length of the IPC.
        set({ selectedItem: linkedItem, bulkSelectedIds: [item.id], bulkAnchorId: item.id })
        try {
          // Extracted presets show their owning package (Extracted from …); plain
          // items show their own package.
          const pkg = await window.api.packages.detail(item.extractedFrom || item.packageFilename)
          const { bulkSelectedIds: picks } = get()
          if (picks.length === 1 && picks[0] === item.id) set({ selectedPackage: pkg })
        } catch (err) {
          toast(`Failed to load package detail: ${err.message}`)
          set({ selectedPackage: null })
        }
      },

      clearSelection: () => set({ selectedItem: null, selectedPackage: null, bulkSelectedIds: [], bulkAnchorId: null }),

      /** Collapse multi-selection to the anchor (or first still-present pick). Used by Escape / Deselect. */
      collapseSelection: () => {
        const { bulkAnchorId, bulkSelectedIds, contents } = get()
        const byId = new Map(contents.map((c) => [c.id, c]))
        const target =
          (bulkAnchorId != null ? byId.get(bulkAnchorId) : null) ||
          bulkSelectedIds.map((id) => byId.get(id)).find(Boolean)
        if (target) void get().selectItem(target)
      },

      toggleBulkSelect: (id) => {
        const base = get().bulkSelectedIds
        const had = base.includes(id)
        // Never empty: ctrl-deselecting the only pick is a no-op.
        if (had && base.length <= 1) return
        const next = had ? base.filter((x) => x !== id) : [...base, id]
        commitContentSelection(get, set, next, id)
      },

      /**
       * Shift-range select. Plain shift replaces the selection with the range (Explorer);
       * additive (Ctrl/Cmd+Shift) unions. Anchor is unchanged so overshooting is correctable.
       */
      rangeBulkSelect: (id, orderedIds, anchorId, { additive = false } = {}) => {
        const s = get()
        const base = s.bulkSelectedIds
        const anchor = anchorId ?? s.bulkAnchorId ?? id
        const i1 = orderedIds.indexOf(anchor)
        const i2 = orderedIds.indexOf(id)
        let next
        if (i1 < 0 || i2 < 0) {
          next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
        } else {
          const lo = Math.min(i1, i2)
          const hi = Math.max(i1, i2)
          const range = orderedIds.slice(lo, hi + 1)
          if (additive) {
            const onList = new Set(orderedIds)
            const offList = base.filter((x) => !onList.has(x))
            const selected = new Set([...base, ...range])
            next = [...offList, ...orderedIds.filter((x) => selected.has(x))]
          } else {
            next = range
          }
        }
        // Keep the existing anchor when set so repeated Shift-clicks can shrink the range.
        commitContentSelection(get, set, next, s.bulkAnchorId ?? anchor)
      },

      selectAllBulk: (orderedIds) => {
        if (!orderedIds.length) return
        commitContentSelection(get, set, orderedIds, orderedIds[orderedIds.length - 1] ?? null)
      },

      clearBulkSelection: () =>
        set({ bulkSelectedIds: [], bulkAnchorId: null, selectedItem: null, selectedPackage: null }),

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
