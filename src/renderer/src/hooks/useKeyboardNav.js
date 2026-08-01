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

/** Space activates whatever control has focus, so it stays hands-off unless focus is on the
 *  grid itself. Cards are buttons too, hence the `data-grid-card` exemption. */
function spaceWouldActivate(el) {
  if (!(el instanceof Element)) return false
  if (el.closest('[data-grid-card]')) return false
  return !!el.closest('button, a, summary, [role="button"], [role="menuitem"], [role="checkbox"]')
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

/** Flat index a navigation key targets, or -1 when the key isn't one (or can't move). */
function navTargetIndex(key, items, idx, cols, isGrid) {
  switch (key) {
    case 'ArrowDown':
      return isGrid ? gridNavIndex(items, idx, cols, 'down') : Math.min(items.length - 1, idx + 1)
    case 'ArrowUp':
      return isGrid ? gridNavIndex(items, idx, cols, 'up') : Math.max(0, idx < 0 ? items.length - 1 : idx - 1)
    case 'ArrowRight':
      return isGrid ? gridNavIndex(items, idx, cols, 'right') : Math.min(items.length - 1, idx + 1)
    case 'ArrowLeft':
      return isGrid ? gridNavIndex(items, idx, cols, 'left') : Math.max(0, idx < 0 ? items.length - 1 : idx - 1)
    case 'Home':
      return 0
    case 'End':
      return items.length - 1
    default:
      return -1
  }
}

/**
 * Keyboard navigation for lists and virtualised grids (Explorer-style).
 *
 * - Bare Arrow/Home/End → `onMoveSelect` (caller decides; selection views move the lead
 *   in bulk and single-select otherwise)
 * - Ctrl/Cmd+Arrow/Home/End → `onMoveLead` (focus only)
 * - Shift+Arrow/Home/End → `onExtend` (range from anchor)
 * - Space → `onToggleLead`
 * - Ctrl/Cmd+A → `onSelectAll`
 * - Escape → `onClose`
 *
 * @param {Array} items - the filtered/sorted list
 * @param {*} selectedId - current lead id (or null)
 * @param {function} [onMoveSelect] - (item) => void
 * @param {function} [onMoveLead] - (item) => void
 * @param {function} [onExtend] - (item) => void
 * @param {function} [onToggleLead] - () => void
 * @param {function} [onSelectAll] - () => void
 * @param {function} [onClose] - () => void
 * @param {function} [getId] - (item) => id
 * @param {number} [columnCount=1] - grid columns; 1 keeps linear list navigation
 */
export function useKeyboardNav({
  items,
  selectedId,
  onMoveSelect,
  onMoveLead,
  onExtend,
  onToggleLead,
  onSelectAll,
  onClose,
  getId,
  columnCount = 1,
}) {
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

      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && onSelectAll) {
        e.preventDefault()
        onSelectAll()
        return
      }

      const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (e.key === ' ' && onToggleLead && bare && !spaceWouldActivate(e.target)) {
        e.preventDefault()
        blurGridCardFocus()
        onToggleLead()
        return
      }

      const idx = selectedId != null ? items.findIndex((i) => getKey(i) === selectedId) : -1
      const next = navTargetIndex(e.key, items, idx, cols, isGrid)
      const item = next >= 0 ? items[next] : null
      if (!item) return

      e.preventDefault()
      blurGridCardFocus()

      if (e.shiftKey && onExtend) onExtend(item)
      else if ((e.metaKey || e.ctrlKey) && onMoveLead) onMoveLead(item)
      else if (onMoveSelect) onMoveSelect(item)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [items, selectedId, onMoveSelect, onMoveLead, onExtend, onToggleLead, onSelectAll, onClose, getKey, cols, isGrid])
}
