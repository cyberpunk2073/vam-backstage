/**
 * The selection model shared by the Library and Content stores.
 *
 * Each keeps one ordered `selection` array of keys — package filenames or content ids —
 * and its length decides the mode: one pick is a single selection (detail panel), more is
 * bulk (gallery + bulk toolbar).
 */

export const isBulk = (selection) => selection.length > 1

/** The lone pick when the selection is a single selection, else null. */
export const soleSelected = (selection) => (selection.length === 1 ? selection[0] : null)

/**
 * Build a store's `setSelection` — the only writer of selection state, taking a key or an
 * ordered array of them.
 *
 * A selection of one is a single selection, so `loadSingle` (the store's detail fetch) is
 * kicked off here rather than in each caller: that is the whole single/bulk reconciliation.
 * A lone pick is always its own anchor. Emptying is ignored — the selection stays non-empty
 * while the list has rows, and each store's `clearSelection` is the one deliberate wipe.
 */
export function selectionWriter(set, loadSingle) {
  return (next, anchor) => {
    const list = next == null ? [] : Array.isArray(next) ? next : [next]
    if (!list.length) return Promise.resolve()
    set({
      selection: list,
      selectionAnchor: list.length === 1 ? list[0] : (anchor ?? list[list.length - 1]),
    })
    return list.length === 1 ? loadSingle(list[0]) : Promise.resolve()
  }
}
