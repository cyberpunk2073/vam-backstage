import { create } from 'zustand'

/**
 * Single source of truth for the app-wide labels list. Labels are reference
 * data — same set used by the Library and Content views — so they don't
 * belong in either view's store. Modeled on `useInstalledStore` /
 * `useStatusStore`: small focused module fetched once at app start and
 * re-fetched on the `labels:updated` IPC event.
 *
 * Subscription wiring lives at the app root (see `App.jsx`); GC of dead ids
 * from view-scoped `selectedLabelIds` filters happens there too, so this
 * store doesn't need to know about the views.
 */
export const useLabelsStore = create((set, get) => ({
  labels: [],
  /** id → label, kept in sync with `labels` so `useLabelObjects` is `O(1)`. */
  byId: new Map(),

  fetchLabels: async () => {
    try {
      const labels = await window.api.labels.list()
      const prev = get().labels
      const same =
        prev.length === labels.length &&
        prev.every((p, i) => {
          const n = labels[i]
          return (
            p.id === n.id &&
            p.name === n.name &&
            p.color === n.color &&
            p.packageCount === n.packageCount &&
            p.contentCount === n.contentCount
          )
        })
      if (same) return
      const byId = new Map(labels.map((l) => [l.id, l]))
      set({ labels, byId })
    } catch (err) {
      console.warn('Failed to fetch labels:', err.message)
    }
  },

  /** Merge into a label in `labels` + `byId` right after a successful mutation; `labels:updated` + fetchLabels reconciles. */
  applyLabelPatch: (id, partial) =>
    set((s) => {
      const prev = s.byId.get(id)
      if (!prev) return s
      const next = { ...prev, ...partial }
      return {
        labels: s.labels.map((l) => (l.id === id ? next : l)),
        byId: new Map(s.byId).set(id, next),
      }
    }),
}))
