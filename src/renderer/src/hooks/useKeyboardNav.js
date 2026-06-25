import { useEffect, useCallback } from 'react'

function isEditableTarget(el) {
  if (!el || el.tagName == null) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function blurGridCardFocus() {
  const active = document.activeElement
  if (active instanceof Element && active.closest('[data-grid-card]')) active.blur()
}

/** @returns {number} next flat index, or -1 when unchanged */
export function gridNavIndex(items, idx, cols, direction) {
  if (!items.length) return -1
  if (idx < 0) return direction === 'up' || direction === 'left' ? items.length - 1 : 0

  let next = idx

  switch (direction) {
    case 'right':
      if (idx + 1 < items.length) next = idx + 1
      break
    case 'left':
      if (idx > 0) next = idx - 1
      break
    case 'down':
      if (idx + cols < items.length) next = idx + cols
      break
    case 'up':
      if (idx - cols >= 0) next = idx - cols
      break
  }

  return next
}

/**
 * Keyboard navigation for lists and virtualised grids.
 *
 * @param {Array} items - the filtered/sorted list
 * @param {*} selectedId - currently selected item's id (or null)
 * @param {function} onSelect - (item) => void
 * @param {function} onClose - () => void  (Escape handler, optional)
 * @param {function} getId - (item) => id  (defaults to item.filename or item.id)
 * @param {number} [columnCount=1] - grid columns; 1 keeps linear list navigation
 */
export function useKeyboardNav({ items, selectedId, onSelect, onClose, getId, columnCount = 1 }) {
  const getKey = useCallback(
    (item) => {
      if (getId) return getId(item)
      return item.filename ?? item.id
    },
    [getId],
  )

  const cols = Math.max(1, columnCount | 0)
  const isGrid = cols > 1

  useEffect(() => {
    function handler(e) {
      if (isEditableTarget(e.target)) return

      if (e.key === 'Escape' && onClose) {
        e.preventDefault()
        onClose()
        return
      }

      if (!items.length) return

      const idx = selectedId != null ? items.findIndex((i) => getKey(i) === selectedId) : -1

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        blurGridCardFocus()
        const next = isGrid ? gridNavIndex(items, idx, cols, 'down') : Math.min(items.length - 1, idx + 1)
        if (next >= 0) onSelect(items[next])
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        blurGridCardFocus()
        const next = isGrid ? gridNavIndex(items, idx, cols, 'up') : Math.max(0, idx < 0 ? items.length - 1 : idx - 1)
        if (next >= 0) onSelect(items[next])
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        blurGridCardFocus()
        const next = isGrid ? gridNavIndex(items, idx, cols, 'right') : Math.min(items.length - 1, idx + 1)
        if (next >= 0) onSelect(items[next])
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        blurGridCardFocus()
        const next = isGrid ? gridNavIndex(items, idx, cols, 'left') : Math.max(0, idx < 0 ? items.length - 1 : idx - 1)
        if (next >= 0) onSelect(items[next])
      } else if (e.key === 'Home') {
        e.preventDefault()
        blurGridCardFocus()
        onSelect(items[0])
      } else if (e.key === 'End') {
        e.preventDefault()
        blurGridCardFocus()
        onSelect(items[items.length - 1])
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [items, selectedId, onSelect, onClose, getKey, cols, isGrid])
}
