/**
 * The selection model shared by the Library and Content stores.
 *
 * Each keeps one ordered `selection` array of keys — package filenames or content ids —
 * and its length decides the mode: one pick is a single selection (detail panel), more is
 * bulk (gallery + bulk toolbar).
 *
 * Two positions ride alongside the array (Explorer-style):
 * - `selectionAnchor` — fixed end of a Shift-range
 * - `selectionLead` — keyboard/mouse focus (scroll + focus ring); may sit on an unselected
 *   item after Ctrl-nav or after toggling the lead off
 *
 * Gesture summary (see also `useKeyboardNav`):
 * - Click / bare Arrow|Home|End → replace selection; both positions = that item
 * - Ctrl/Cmd+Click / Space → toggle lead (or clicked item); both positions = that item
 * - Shift+Click / Shift+Arrow|Home|End → range anchor→lead; lead moves, anchor stays
 * - Ctrl/Cmd+Arrow|Home|End → move lead only
 * - Ctrl/Cmd+A → all; anchor = first, lead = last
 * - Esc (bulk) → collapse to lead
 */

export const isBulk = (selection) => selection.length > 1

/** The lone pick when the selection is a single selection, else null. */
export const soleSelected = (selection) => (selection.length === 1 ? selection[0] : null)

/**
 * Build a store's `setSelection` — the only writer of selection state, taking a key or an
 * ordered array of them plus optional `{ anchor, lead }`.
 *
 * A selection of one is a single selection, so `loadSingle` (the store's detail fetch) is
 * kicked off here rather than in each caller: that is the whole single/bulk reconciliation.
 * A lone pick is always its own anchor and lead. Emptying is ignored — the selection stays
 * non-empty while the list has rows, and each store's `clearSelection` is the one deliberate wipe.
 */
function selectionWriter(set, get, loadSingle) {
  return (next, { anchor, lead } = {}) => {
    const list = next == null ? [] : Array.isArray(next) ? next : [next]
    if (!list.length) return Promise.resolve()
    if (list.length === 1) {
      set({ selection: list, selectionAnchor: list[0], selectionLead: list[0] })
      return loadSingle(list[0])
    }
    set({
      selection: list,
      selectionAnchor: anchor ?? get().selectionAnchor ?? list[0],
      selectionLead: lead ?? list[list.length - 1],
    })
    return Promise.resolve()
  }
}

/**
 * Shared mutators on top of `setSelection`.
 *
 * `isLive(state)` returns a predicate telling whether a key still exists in the store's
 * backing list, so collapsing can skip keys an action removed under us.
 */
export function selectionMutators(set, get, loadSingle, { isLive } = {}) {
  const setSelection = selectionWriter(set, get, loadSingle)

  return {
    setSelection,

    /** Ctrl/Cmd+Arrow: move focus without changing the selection or shift-anchor. */
    setLead: (id) => {
      if (id == null || get().selectionLead === id) return
      set({ selectionLead: id })
    },

    /** Escape / Deselect: drop to a single selection at the lead, skipping dead keys. */
    collapseSelection: () => {
      const state = get()
      const live = isLive ? isLive(state) : () => true
      const target = [state.selectionLead, state.selectionAnchor, ...state.selection].find(
        (key) => key != null && live(key),
      )
      return setSelection(target)
    },

    toggleSelected: (id) => {
      const base = get().selection
      const had = base.includes(id)
      // Never empty: ctrl-deselecting the only pick is a no-op.
      if (had && base.length <= 1) return Promise.resolve()
      // Explorer: after toggle, both positions land on the toggled item (may be unselected).
      const next = had ? base.filter((x) => x !== id) : [...base, id]
      return setSelection(next, { anchor: id, lead: id })
    },

    /**
     * Shift-range select. Plain shift replaces the selection with the range (Explorer);
     * additive (Ctrl/Cmd+Shift) unions. Anchor is unchanged so overshooting is correctable.
     * Lead becomes the endpoint.
     */
    selectRange: (id, orderedIds, { additive = false } = {}) => {
      const { selection, selectionAnchor } = get()
      const anchor = selectionAnchor ?? id
      const i1 = orderedIds.indexOf(anchor)
      const i2 = orderedIds.indexOf(id)
      let next
      if (i1 < 0 || i2 < 0) {
        next = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]
      } else {
        const lo = Math.min(i1, i2)
        const hi = Math.max(i1, i2)
        const range = orderedIds.slice(lo, hi + 1)
        if (additive) {
          const onList = new Set(orderedIds)
          const offList = selection.filter((x) => !onList.has(x))
          const selected = new Set([...selection, ...range])
          next = [...offList, ...orderedIds.filter((x) => selected.has(x))]
        } else {
          next = range
        }
      }
      return setSelection(next, { anchor, lead: id })
    },

    selectAll: (orderedIds) => {
      if (!orderedIds.length) return Promise.resolve()
      return setSelection([...orderedIds], {
        anchor: orderedIds[0],
        lead: orderedIds[orderedIds.length - 1],
      })
    },
  }
}
