import { useEffect, useCallback } from 'react'

/**
 * Keyboard navigation for lists.
 *
 * @param {Array} items - the filtered/sorted list
 * @param {*} selectedId - currently selected item's id (or null)
 * @param {function} onSelect - (item) => void
 * @param {function} onClose - () => void  (Escape handler, optional)
 * @param {function} getId - (item) => id  (defaults to item.filename or item.id)
 */
export function useKeyboardNav({ items, selectedId, onSelect, onClose, getId }) {
  const getKey = useCallback(
    (item) => {
      if (getId) return getId(item)
      return item.filename ?? item.id
    },
    [getId],
  )

  useEffect(() => {
    function handler(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return

      if (e.key === 'Escape' && onClose) {
        e.preventDefault()
        onClose()
        return
      }

      if (!items.length) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault()
        const idx = selectedId != null ? items.findIndex((i) => getKey(i) === selectedId) : -1
        const next = Math.min(items.length - 1, idx + 1)
        onSelect(items[next])
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault()
        const idx = selectedId != null ? items.findIndex((i) => getKey(i) === selectedId) : items.length
        const prev = Math.max(0, idx - 1)
        onSelect(items[prev])
      } else if (e.key === 'Home') {
        e.preventDefault()
        if (items.length) onSelect(items[0])
      } else if (e.key === 'End') {
        e.preventDefault()
        if (items.length) onSelect(items[items.length - 1])
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [items, selectedId, onSelect, onClose, getKey])
}
