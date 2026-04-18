/** Shared Zustand slice for multi-select type filter (used by Library + Content stores). */
export function typeFilterSlice(set, get) {
  return {
    selectedTypes: [],
    toggleType: (type) => {
      const { selectedTypes } = get()
      if (type === 'All') {
        set({ selectedTypes: [] })
        return
      }
      const idx = selectedTypes.indexOf(type)
      set({ selectedTypes: idx >= 0 ? selectedTypes.filter((t) => t !== type) : [...selectedTypes, type] })
    },
    selectSingleType: (type) => {
      if (type === 'All') {
        set({ selectedTypes: [] })
        return
      }
      const { selectedTypes } = get()
      set({ selectedTypes: selectedTypes.length === 1 && selectedTypes[0] === type ? [] : [type] })
    },
  }
}
