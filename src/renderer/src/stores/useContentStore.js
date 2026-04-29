import { create } from 'zustand'
import { toast } from '@/components/Toast'
import { typeFilterSlice } from './typeFilterSlice'

const FILTER_DEFAULTS = {
  search: '',
  authorSearch: '',
  selectedTypes: [],
  selectedPackageTypes: [],
  selectedTags: [],
  selectedLabelIds: [],
  packageFilter: 'all',
  visibilityFilter: 'visible',
}

export const useContentStore = create((set, get) => ({
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
      search,
      visibilityFilter: 'all',
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
      selectedPackageTypes: idx >= 0 ? selectedPackageTypes.filter((t) => t !== type) : [...selectedPackageTypes, type],
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
  setSelectedTags: (selectedTags) => set({ selectedTags }),
  setSelectedLabelIds: (selectedLabelIds) => set({ selectedLabelIds }),
  setPackageFilter: (packageFilter) => set({ packageFilter }),
  setVisibilityFilter: (visibilityFilter) => set({ visibilityFilter }),
  setPrimarySort: (primarySort) => set({ primarySort }),
  setSecondarySort: (secondarySort) => set({ secondarySort }),
  setViewMode: (viewMode) => {
    set({ viewMode })
    void window.api.settings.set('content_view_mode', viewMode)
  },
  setCardWidth: (cardWidth) => {
    set({ cardWidth })
    void window.api.settings.set('content_card_width', String(cardWidth))
  },

  hydrateContentVisualPreferences: async () => {
    try {
      const [vm, widthStr] = await Promise.all([
        window.api.settings.get('content_view_mode'),
        window.api.settings.get('content_card_width'),
      ])
      const patch = {}
      if (vm === 'grid' || vm === 'table') patch.viewMode = vm
      const w = parseInt(String(widthStr ?? ''), 10)
      if (!Number.isNaN(w) && w >= 100 && w <= 500) patch.cardWidth = w
      if (Object.keys(patch).length) set(patch)
    } catch {}
  },

  fetchContents: async () => {
    try {
      const contents = await window.api.contents.list({})
      set({ contents })
    } catch (err) {
      console.error('Failed to fetch contents:', err)
    }
  },

  selectItem: async (item) => {
    if (!item) {
      set({ selectedItem: null, selectedPackage: null, bulkSelectedIds: [], bulkAnchorId: null })
      return
    }
    set({ selectedItem: item, bulkSelectedIds: [], bulkAnchorId: null })
    try {
      const pkg = await window.api.packages.detail(item.packageFilename)
      set({ selectedPackage: pkg })
    } catch (err) {
      toast(`Failed to load package detail: ${err.message}`)
      set({ selectedPackage: null })
    }
  },

  clearSelection: () => set({ selectedItem: null, selectedPackage: null }),

  toggleBulkSelect: (id) =>
    set((s) => {
      const had = s.bulkSelectedIds.includes(id)
      const next = had ? s.bulkSelectedIds.filter((x) => x !== id) : [...s.bulkSelectedIds, id]
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
      if (fresh) set({ selectedItem: fresh })
      const pkg = await window.api.packages.detail(selectedItem.packageFilename)
      set({ selectedPackage: pkg })
    } catch {}
  },
}))
