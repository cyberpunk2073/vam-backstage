import { useMemo, useState } from 'react'
import { Tag } from 'lucide-react'
import { LabelChip } from '@/components/labels/LabelChip'
import { LabelManageMenu } from '@/components/labels/LabelManageMenu'
import { useLabelRename } from '@/components/labels/useLabelRename'
import { labelColor } from '@/lib/labels'
import { stripNegationPrefix } from './chip-utils'
import { usePolarityList } from './usePolarityList'
import { useCombobox } from './useCombobox'
import { ChipRow, ComboboxField, ComboboxLabel, ComboboxPopup, ComboboxRow } from './Combobox'

/**
 * Labels filter widget — like `TagsAutocomplete` but values are label IDs and
 * each chip / row gets a leading colored dot. No "Create" affordance — labels
 * are born only by being applied (see UX plan §12). Right-click on a chip or
 * row opens the management menu (rename / recolor / delete + enable/disable
 * all packages).
 */
export function LabelsAutocomplete({
  value = [],
  onChange,
  labels = [],
  placeholder = 'Filter by label…',
  allowNegate = false,
}) {
  const [query, setQuery] = useState('')
  const { renamingId, renameDraft, setRenameDraft, startRename, commitRename, cancelRename } = useLabelRename()
  const { items, selectedSet, add, remove, toggle, clear } = usePolarityList(value, onChange, allowNegate)
  const negateById = useMemo(() => new Map(items.map((i) => [i.value, i.negate])), [items])

  const labelMap = useMemo(() => {
    const m = new Map()
    for (const l of labels) m.set(l.id, l)
    return m
  }, [labels])
  const selected = useMemo(() => items.map((item) => labelMap.get(item.value)).filter(Boolean), [items, labelMap])

  const { negate: rawPendingNegate, query: matchQuery } = stripNegationPrefix(query)
  const pendingNegate = allowNegate && rawPendingNegate
  const q = (allowNegate ? matchQuery : query).trim().toLowerCase()

  const matches = useMemo(() => {
    const all = labels.filter((l) => !selectedSet.has(l.id))
    if (!q) return all.slice(0, 30)
    const prefix = []
    const rest = []
    for (const l of all) {
      const lower = l.name.toLowerCase()
      if (lower.startsWith(q)) prefix.push(l)
      else if (lower.includes(q)) rest.push(l)
    }
    return [...prefix, ...rest].slice(0, 30)
  }, [labels, selectedSet, q])

  const addLabel = (id, negate = false) => {
    add(id, negate)
    setQuery('')
    combobox.inputRef.current?.focus()
  }

  const combobox = useCombobox({
    matches,
    onSelect: (label) => addLabel(label.id, pendingNegate),
  })

  return (
    <div ref={combobox.containerRef} className="relative">
      {selected.length > 0 && (
        <ChipRow onClear={clear} showClear={selected.length > 1}>
          {selected.map((label) => (
            <LabelManageMenu
              key={label.id}
              label={label}
              applicationCount={(label.packageCount || 0) + (label.contentCount || 0)}
              onStartRename={() => startRename(label)}
              onDeleted={() => remove(label.id)}
            >
              <LabelChip
                label={label}
                size="sm"
                interactive
                filled
                negated={!!negateById.get(label.id)}
                onClick={allowNegate ? () => toggle(label.id) : undefined}
                onNameDoubleClick={() => startRename(label)}
                onRemove={() => remove(label.id)}
                renaming={renamingId === label.id}
                editValue={renameDraft}
                onEditChange={setRenameDraft}
                onCommit={commitRename}
                onCancel={cancelRename}
              />
            </LabelManageMenu>
          ))}
        </ChipRow>
      )}
      <ComboboxField
        icon={Tag}
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
        <ComboboxPopup listRef={combobox.listRef} maxHeight="max-h-60">
          {matches.map((label, i) => {
            const total = (label.packageCount || 0) + (label.contentCount || 0)
            return (
              <LabelManageMenu
                key={label.id}
                label={label}
                applicationCount={total}
                onStartRename={() => startRename(label)}
              >
                <ComboboxRow
                  active={i === combobox.hlIndex}
                  negate={pendingNegate}
                  onSelect={() => addLabel(label.id, pendingNegate)}
                  onHover={() => combobox.setHlIndex(i)}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: labelColor(label) }} />
                  <ComboboxLabel negate={pendingNegate}>{label.name}</ComboboxLabel>
                  {total > 0 && <span className="text-text-tertiary text-[11px] shrink-0">{total}</span>}
                </ComboboxRow>
              </LabelManageMenu>
            )
          })}
        </ComboboxPopup>
      )}
    </div>
  )
}
