import { useMemo } from 'react'
import { emitPolarityItems, toPolarityItems } from './chip-utils'

/**
 * State machine for a multi-value chip field with include/exclude polarity.
 * Normalizes `value` to `{ value, negate }[]` and emits back in the caller's
 * shape (plain values when `allowNegate` is false). `add` returns false when the
 * value is already present so callers can still reset their input.
 */
export function usePolarityList(value, onChange, allowNegate) {
  const items = useMemo(() => toPolarityItems(value), [value])
  const selectedSet = useMemo(() => new Set(items.map((i) => i.value)), [items])

  const add = (v, negate = false) => {
    if (selectedSet.has(v)) return false
    onChange(emitPolarityItems([...items, { value: v, negate: allowNegate && negate }], allowNegate))
    return true
  }
  const remove = (v) =>
    onChange(
      emitPolarityItems(
        items.filter((i) => i.value !== v),
        allowNegate,
      ),
    )
  const toggle = (v) => {
    if (!allowNegate) return
    onChange(items.map((i) => (i.value === v ? { ...i, negate: !i.negate } : i)))
  }
  const clear = () => onChange([])

  return { items, selectedSet, add, remove, toggle, clear }
}
