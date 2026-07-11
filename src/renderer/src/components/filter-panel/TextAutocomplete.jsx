import { useMemo } from 'react'
import { User } from 'lucide-react'
import { rankSuggestions } from './chip-utils'
import { useCombobox } from './useCombobox'
import { ComboboxField, ComboboxPopup, ComboboxRow } from './Combobox'

/** Single-line filter with Hub `users`-style suggestions: substring match, ordered by occurrence count. */
export function TextAutocomplete({ value = '', onChange, suggestions = {}, placeholder = 'Search…' }) {
  const q = value.trim().toLowerCase()
  const matches = useMemo(() => rankSuggestions(suggestions, q), [suggestions, q])

  const pick = (name) => {
    onChange(name)
    combobox.setOpen(false)
  }

  const combobox = useCombobox({ matches, onSelect: ([name]) => pick(name) })

  return (
    <div ref={combobox.containerRef} className="relative">
      <ComboboxField
        icon={User}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          combobox.setOpen(true)
        }}
        onFocus={() => combobox.setOpen(true)}
        onKeyDown={combobox.onKeyDown}
        placeholder={placeholder}
        onClear={() => {
          onChange('')
          combobox.setOpen(false)
        }}
        clearLabel="Clear"
      />
      {combobox.showList && (
        <ComboboxPopup listRef={combobox.listRef}>
          {matches.map(([name, count], i) => (
            <ComboboxRow
              key={name}
              active={i === combobox.hlIndex}
              onSelect={() => pick(name)}
              onHover={() => combobox.setHlIndex(i)}
            >
              <span className="truncate flex-1">{name}</span>
              <span className="text-text-tertiary text-[11px] shrink-0">{count}</span>
            </ComboboxRow>
          ))}
        </ComboboxPopup>
      )}
    </div>
  )
}
