import { create } from 'zustand'

export const useStatusStore = create((set) => ({
  stats: {
    directCount: 0,
    depCount: 0,
    totalCount: 0,
    brokenCount: 0,
    totalContent: 0,
    totalSize: 0,
    directSize: 0,
    depSize: 0,
    contentByType: {},
    missingDepCount: 0,
  },

  scan: null, // { phase, step, total, message } or null when idle

  fetchStats: async () => {
    try {
      const stats = await window.api.packages.stats()
      set({ stats })
    } catch (err) {
      console.error('Failed to fetch stats:', err)
    }
  },

  setScan: (scan) => set({ scan }),
}))
