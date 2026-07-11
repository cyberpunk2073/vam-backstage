import { useMemo, useState } from 'react'
import { Hash } from 'lucide-react'
import { PolarityTagChip, rankSuggestions, stripNegationPrefix } from './chip-utils'
import { usePolarityList } from './usePolarityList'
import { useCombobox } from './useCombobox'
import { ChipRow, ComboboxField, ComboboxLabel, ComboboxPopup, ComboboxRow } from './Combobox'

export function TagsAutocomplete({
  value = [],
  onChange,
  suggestions = {},
  placeholder = 'Filter by tags…',
  allowNegate = false,
}) {
  const [query, setQuery] = useState('')
  const { items, selectedSet, add, remove, toggle, clear } = usePolarityList(value, onChange, allowNegate)

  const { negate: rawPendingNegate, query: matchQuery } = stripNegationPrefix(query)
  const pendingNegate = allowNegate && rawPendingNegate
  const commitText = allowNegate ? matchQuery : query
  const q = commitText.trim().toLowerCase()

  const matches = useMemo(
    () => rankSuggestions(suggestions, q, (tag) => selectedSet.has(tag)),
    [suggestions, selectedSet, q],
  )

  const addTag = (tag, negate = false) => {
    const trimmed = tag.trim()
    if (trimmed) add(trimmed, negate)
    setQuery('')
    combobox.inputRef.current?.focus()
  }
  const commitRaw = () => {
    if (!commitText.trim()) return false
    addTag(commitText, pendingNegate)
    return true
  }

  const combobox = useCombobox({
    matches,
    onSelect: ([tag]) => addTag(tag, pendingNegate),
    onCommitRaw: commitRaw,
    commaCommits: true,
  })

  return (
    <div ref={combobox.containerRef} className="relative">
      {items.length > 0 && (
        <ChipRow
          onClear={() => {
            clear()
            setQuery('')
          }}
        >
          {items.map((item) => (
            <PolarityTagChip
              key={item.value}
              label={item.value}
              negate={item.negate}
              onToggle={allowNegate ? () => toggle(item.value) : undefined}
              onRemove={() => remove(item.value)}
            />
          ))}
        </ChipRow>
      )}
      <ComboboxField
        icon={Hash}
        inputRef={combobox.inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          combobox.setOpen(true)
        }}
        onFocus={() => combobox.setOpen(true)}
        onKeyDown={combobox.onKeyDown}
        placeholder={placeholder}
        onClear={() => {
          setQuery('')
          combobox.setOpen(false)
        }}
      />
      {combobox.showList && (
        <ComboboxPopup listRef={combobox.listRef}>
          {matches.map(([tag, count], i) => (
            <ComboboxRow
              key={tag}
              active={i === combobox.hlIndex}
              negate={pendingNegate}
              onSelect={() => addTag(tag, pendingNegate)}
              onHover={() => combobox.setHlIndex(i)}
            >
              <ComboboxLabel negate={pendingNegate}>{tag}</ComboboxLabel>
              <span className="text-text-tertiary text-[11px] shrink-0">{count}</span>
            </ComboboxRow>
          ))}
        </ComboboxPopup>
      )}
    </div>
  )
}
