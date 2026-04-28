import { useMemo } from 'react'
import { useLabelsStore } from '../../stores/useLabelsStore'

/**
 * Resolve `[id, ...]` against the cached labels map. Single source — the
 * shared `useLabelsStore` — so cards in any view always see fresh labels
 * regardless of which view triggered the mutation.
 */
export function useLabelObjects(ids) {
  const byId = useLabelsStore((s) => s.byId)
  return useMemo(() => {
    if (!ids?.length || !byId.size) return []
    const out = []
    for (const id of ids) {
      const l = byId.get(id)
      if (l) out.push(l)
    }
    return out
  }, [ids, byId])
}
