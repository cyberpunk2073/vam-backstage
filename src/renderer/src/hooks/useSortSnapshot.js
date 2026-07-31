import { useCallback, useRef } from 'react'

/**
 * Freeze the sort inputs of selected items. An edit that changes a sort key — a type override, mostly —
 * would otherwise slide the item the user is working on out from under them; with this the comparator
 * keeps reading the values that item had when it was selected, while everything else sorts on live data.
 *
 * Returns a resolver to wrap the comparator's operands with. Only the comparator sees the frozen copy, so
 * rendering still reads live data and badges update in place. An item is captured the first time it gets
 * sorted while selected and released as soon as it isn't, so deselecting settles just that one item.
 *
 * Holding a reference is enough to hold the old values because the stores rebuild items on every fetch
 * rather than mutating them. Everything is dropped when `key` changes, so picking a new sort or filter
 * sorts against live data at once.
 */
export function useSortSnapshot() {
  const frozenRef = useRef(null)

  return useCallback(({ frozenIds, key, getId }) => {
    if (frozenRef.current?.key !== key) frozenRef.current = { key, items: new Map() }
    const { items } = frozenRef.current
    return (item) => {
      const id = getId(item)
      if (!frozenIds.has(id)) {
        items.delete(id)
        return item
      }
      const frozen = items.get(id)
      if (frozen) return frozen
      items.set(id, item)
      return item
    }
  }, [])
}
