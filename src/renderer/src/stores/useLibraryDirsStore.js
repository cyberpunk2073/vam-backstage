import { create } from 'zustand'

/**
 * App-wide cache of the library directory registry (main + aux dirs with their
 * roles). Populated at startup and refreshed on every `packages:updated` event
 * (dir add/remove/role-flip all notify it). Gates the whole Archive feature in
 * the renderer: the Archived facet, Archive actions, and detail-panel button are
 * hidden unless at least one archive-role dir is registered.
 */
export const useLibraryDirsStore = create((set) => ({
  main: null,
  aux: [],
  loaded: false,
  fetch: async () => {
    try {
      const r = await window.api.libraryDirs.list()
      set({ main: r.main ?? null, aux: r.aux || [], loaded: true })
    } catch (err) {
      console.warn('library-dirs:list failed:', err.message)
      set({ loaded: true })
    }
  },
}))
