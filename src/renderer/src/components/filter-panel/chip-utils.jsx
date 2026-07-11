import { X } from 'lucide-react'

/** Normalize filter chip lists: plain values → `{ value, negate: false }`. */
export function toPolarityItems(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    item && typeof item === 'object' && 'value' in item
      ? { value: item.value, negate: !!item.negate }
      : { value: item, negate: false },
  )
}

/** Serialize back out: `{value,negate}[]` when the field supports negation, else plain values. */
export function emitPolarityItems(items, allowNegate) {
  return allowNegate ? items : items.map((i) => i.value)
}

/** Strip a leading `-` / `!` for autocomplete matching; returns `{ negate, query }`. */
export function stripNegationPrefix(raw) {
  const t = String(raw || '')
  if (t[0] === '-' || t[0] === '!') return { negate: true, query: t.slice(1) }
  return { negate: false, query: t }
}

/**
 * Rank `{ name: count }` suggestions for a query: prefix matches first, then
 * substring matches, each ordered by count desc then name. Empty query returns
 * the full list by count. `isExcluded(name)` drops already-chosen entries.
 */
export function rankSuggestions(suggestions, q, isExcluded, limit = 20) {
  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  const entries = Object.entries(suggestions).filter(([name]) => !isExcluded?.(name))
  if (!q) return entries.sort(byCount).slice(0, limit)
  const prefix = []
  const rest = []
  for (const entry of entries) {
    const lower = entry[0].toLowerCase()
    if (lower.startsWith(q)) prefix.push(entry)
    else if (lower.includes(q)) rest.push(entry)
  }
  return [...prefix.sort(byCount), ...rest.sort(byCount)].slice(0, limit)
}

/** Blue (include) / red (exclude) pill for tags and excluded authors. */
export function PolarityTagChip({ label, negate, onToggle, onRemove }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] leading-tight ${
        negate ? 'bg-error/15 text-error' : 'bg-accent-blue/15 text-accent-blue'
      } ${onToggle ? 'cursor-pointer' : ''}`}
      onClick={onToggle}
      title={onToggle ? (negate ? 'Click to include' : 'Click to exclude') : undefined}
    >
      {negate && <span className="font-medium leading-none">−</span>}
      <span>{label}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="hover:text-text-primary cursor-pointer"
      >
        <X size={10} />
      </button>
    </span>
  )
}
