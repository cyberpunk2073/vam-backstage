import { useEffect, useRef, useState } from 'react'

/** setHlIndex updater that wraps around and scrolls the target row into view. */
function moveHighlight(dir, len, listRef) {
  return (i) => {
    const next = dir === 'down' ? (i < len - 1 ? i + 1 : 0) : i > 0 ? i - 1 : len - 1
    listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
    return next
  }
}

/**
 * Headless input-anchored combobox: owns open/highlight state, refs, outside-click
 * dismissal, highlight reset on `matches` change, and the shared keyboard grammar
 * (Arrow up/down, Enter, comma, Escape). Everything value-shaped is injected:
 *
 *  - `matches`      the current suggestion array (entries or objects).
 *  - `onSelect(m,i)` commit the highlighted match.
 *  - `onCommitRaw(trigger)` optional free-text commit on Enter/comma with no
 *                    highlight; return truthy to consume the event. `trigger` is
 *                    `'enter'` or `'comma'` so callers can close only on Enter.
 *  - `commaCommits`  route the `,` key to `onCommitRaw`.
 *  - `onEscape()`    optional; return truthy to swallow Escape (e.g. clear a draft)
 *                    instead of closing the popup.
 */
export function useCombobox({ matches, onSelect, onCommitRaw, commaCommits = false, onEscape }) {
  const [open, setOpen] = useState(false)
  const [hlIndex, setHlIndex] = useState(-1)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    setHlIndex(-1)
  }, [matches])

  const showList = open && matches.length > 0

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' && showList) {
      e.preventDefault()
      setHlIndex(moveHighlight('down', matches.length, listRef))
    } else if (e.key === 'ArrowUp' && showList) {
      e.preventDefault()
      setHlIndex(moveHighlight('up', matches.length, listRef))
    } else if (e.key === 'Enter') {
      if (showList && hlIndex >= 0 && hlIndex < matches.length) {
        e.preventDefault()
        onSelect(matches[hlIndex], hlIndex)
      } else if (onCommitRaw?.('enter')) {
        e.preventDefault()
      }
    } else if (e.key === ',' && commaCommits) {
      if (onCommitRaw?.('comma')) e.preventDefault()
    } else if (e.key === 'Escape') {
      if (onEscape?.()) {
        e.preventDefault()
      } else if (open) {
        e.preventDefault()
        setOpen(false)
      }
    }
  }

  return { open, setOpen, showList, hlIndex, setHlIndex, containerRef, inputRef, listRef, onKeyDown }
}
