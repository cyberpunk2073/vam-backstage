import { useState, useCallback } from 'react'

const LS_PREFIX = 'panel:'

/**
 * Persists panel width to localStorage.
 * Reads synchronously on first render so panels never "jump".
 */
export function usePersistedPanelWidth(key, { min, max, defaultWidth }) {
  const lsKey = LS_PREFIX + key
  const [width, _setWidth] = useState(() => {
    try {
      const n = parseInt(localStorage.getItem(lsKey), 10)
      if (!Number.isNaN(n) && n >= min && n <= max) return n
    } catch {}
    return defaultWidth
  })

  const setWidth = useCallback(
    (w) => {
      _setWidth(w)
      try {
        localStorage.setItem(lsKey, String(w))
      } catch {}
    },
    [lsKey],
  )

  return [width, setWidth]
}
