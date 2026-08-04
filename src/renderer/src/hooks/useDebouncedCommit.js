import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Local draft that commits to store after `delayMs` of idle typing.
 * Call `onChange(value, { immediate: true })` (Enter / autocomplete / clear) to flush early.
 * Empty string always commits immediately so clearing feels instant.
 *
 * @param {string} committed  value from the store
 * @param {(v: string) => void} setCommitted
 * @param {number} delayMs
 * @param {{ prepare?: (v: string) => string }} [options]  `prepare` runs before store write (e.g. trim)
 */
export function useDebouncedCommit(committed, setCommitted, delayMs, options = {}) {
  const prepare = options.prepare
  const [draft, setDraft] = useState(committed)
  const draftRef = useRef(committed)
  const timerRef = useRef(null)

  useEffect(() => {
    setDraft(committed)
    draftRef.current = committed
  }, [committed])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const write = useCallback(
    (raw) => {
      const next = prepare ? prepare(raw) : raw
      setCommitted(next)
    },
    [setCommitted, prepare],
  )

  const onChange = useCallback(
    (value, opts) => {
      setDraft(value)
      draftRef.current = value
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const prepared = prepare ? prepare(value) : value
      if (opts?.immediate || prepared === '') {
        setCommitted(prepared)
        return
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (draftRef.current !== value) return
        write(value)
      }, delayMs)
    },
    [setCommitted, delayMs, prepare, write],
  )

  return { draft, onChange }
}
