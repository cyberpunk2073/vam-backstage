import { useMemo, useState } from 'react'
import { User } from 'lucide-react'
import { PolarityTagChip, rankSuggestions, stripNegationPrefix } from './chip-utils'
import { useCombobox } from './useCombobox'
import { ChipRow, ComboboxField, ComboboxPopup, ComboboxRow } from './Combobox'

/**
 * Author filter: single live positive substring (chip-less) + optional exclude
 * chip blocklist. Prefixed `-`/`!` input commits an exclude and restores the
 * positive value in the box.
 */
export function AuthorAutocomplete({
  value = '',
  onChange,
  excluded = [],
  onExcludedChange,
  suggestions = {},
  placeholder = 'Filter by author…',
}) {
  const [draft, setDraft] = useState(null)
  const excludedList = useMemo(() => (Array.isArray(excluded) ? excluded : []), [excluded])
  const excludedSet = useMemo(() => new Set(excludedList.map((a) => a.toLowerCase())), [excludedList])

  const displayValue = draft !== null ? draft : value
  const { negate: pendingNegate, query: matchQuery } = stripNegationPrefix(displayValue)
  const q = matchQuery.trim().toLowerCase()

  const matches = useMemo(
    () => rankSuggestions(suggestions, q, (name) => excludedSet.has(name.toLowerCase())),
    [suggestions, excludedSet, q],
  )

  const commitExclude = (name) => {
    const trimmed = name.trim()
    if (!trimmed || excludedSet.has(trimmed.toLowerCase())) {
      setDraft(null)
      return
    }
    onExcludedChange([...excludedList, trimmed])
    setDraft(null)
    combobox.inputRef.current?.focus()
  }

  const pickSuggestion = (name) => {
    if (pendingNegate) commitExclude(name)
    else {
      onChange(name)
      setDraft(null)
    }
    combobox.setOpen(false)
  }

  const promoteExclude = (name) => {
    onExcludedChange(excludedList.filter((a) => a !== name))
    onChange(name)
    setDraft(null)
  }

  const combobox = useCombobox({
    matches,
    onSelect: ([name]) => pickSuggestion(name),
    onCommitRaw: (trigger) => {
      if (!(pendingNegate && matchQuery.trim())) return false
      commitExclude(matchQuery)
      if (trigger === 'enter') combobox.setOpen(false)
      return true
    },
    commaCommits: true,
    onEscape: () => {
      if (draft === null) return false
      setDraft(null)
      return true
    },
  })

  const onInputChange = (raw) => {
    if (stripNegationPrefix(raw).negate) setDraft(raw)
    else {
      setDraft(null)
      onChange(raw)
    }
    combobox.setOpen(true)
  }

  return (
    <div ref={combobox.containerRef} className="relative">
      {excludedList.length > 0 && (
        <ChipRow onClear={() => onExcludedChange([])} showClear={excludedList.length > 1}>
          {excludedList.map((name) => (
            <PolarityTagChip
              key={name}
              label={name}
              negate
              onToggle={() => promoteExclude(name)}
              onRemove={() => onExcludedChange(excludedList.filter((a) => a !== name))}
            />
          ))}
        </ChipRow>
      )}
      <ComboboxField
        icon={User}
        inputRef={combobox.inputRef}
        value={displayValue}
        onChange={(e) => onInputChange(e.target.value)}
        onFocus={() => combobox.setOpen(true)}
        onKeyDown={combobox.onKeyDown}
        placeholder={placeholder}
        onClear={() => {
          if (draft !== null) setDraft(null)
          else {
            onChange('')
            combobox.setOpen(false)
          }
        }}
        clearLabel="Clear"
      />
      {combobox.showList && (
        <ComboboxPopup listRef={combobox.listRef}>
          {matches.map(([name, count], i) => (
            <ComboboxRow
              key={name}
              active={i === combobox.hlIndex}
              onSelect={() => pickSuggestion(name)}
              onHover={() => combobox.setHlIndex(i)}
            >
              <span className="truncate flex-1">{pendingNegate ? `− ${name}` : name}</span>
              <span className="text-text-tertiary text-[11px] shrink-0">{count}</span>
            </ComboboxRow>
          ))}
        </ComboboxPopup>
      )}
    </div>
  )
}
