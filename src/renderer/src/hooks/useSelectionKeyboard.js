import { useCallback } from 'react'
import { useKeyboardNav } from '@/hooks/useKeyboardNav'
import { isBulk } from '@/stores/selection'

/**
 * Binds the Explorer-style selection gestures to a grid/list view. The store side of the
 * model lives in `stores/selection.js`; this is the view side of the same contract, shared
 * by Library and Content so the two can't drift.
 *
 * Bare Arrow/Home/End single-selects (`onSingleSelect`, which owns the detail fetch),
 * Ctrl/Cmd moves the lead only, Shift extends from the anchor, Space toggles the lead,
 * Ctrl/Cmd+A selects all, and Escape collapses a bulk selection.
 *
 * @param {object} store - the Zustand store hook (`useLibraryStore` / `useContentStore`)
 * @param {Array} items - the filtered/sorted rows currently on screen
 * @param {Array} orderedIds - `items` mapped to selection keys, in display order
 * @param {function} getId - (item) => selection key
 * @param {function} onSingleSelect - (item) => void, the view's single-select runner
 * @param {number} columnCount - grid columns; 1 for table/list layouts
 */
export function useSelectionKeyboard({ store, items, orderedIds, getId, onSingleSelect, columnCount }) {
  const lead = store((s) => s.selectionLead)

  const moveLead = useCallback((item) => store.getState().setLead(getId(item)), [store, getId])

  const extend = useCallback(
    (item) => store.getState().selectRange(getId(item), orderedIds),
    [store, getId, orderedIds],
  )

  const toggleLead = useCallback(() => {
    const { selectionLead, toggleSelected } = store.getState()
    if (selectionLead != null) toggleSelected(selectionLead)
  }, [store])

  const selectAll = useCallback(() => store.getState().selectAll(orderedIds), [store, orderedIds])

  const close = useCallback(() => {
    const { selection, collapseSelection } = store.getState()
    if (isBulk(selection)) collapseSelection()
  }, [store])

  useKeyboardNav({
    items,
    selectedId: lead,
    getId,
    columnCount,
    onMoveSelect: onSingleSelect,
    onMoveLead: moveLead,
    onExtend: extend,
    onToggleLead: toggleLead,
    onSelectAll: selectAll,
    onClose: close,
  })
}
