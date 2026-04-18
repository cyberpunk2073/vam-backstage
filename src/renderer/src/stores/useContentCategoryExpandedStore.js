import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useContentCategoryExpandedStore = create(
  persist(
    (set) => ({
      /** Explicit false = collapsed; missing key = expanded */
      expandedByType: {},

      toggle: (type) => {
        set((s) => {
          const cur = s.expandedByType[type] ?? true
          return { expandedByType: { ...s.expandedByType, [type]: !cur } }
        })
      },
    }),
    {
      name: 'content-category-expanded',
      partialize: (s) => {
        const slim = {}
        for (const [k, v] of Object.entries(s.expandedByType)) {
          if (v === false) slim[k] = false
        }
        return { expandedByType: slim }
      },
    },
  ),
)
