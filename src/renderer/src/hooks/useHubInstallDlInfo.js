import { useDownloadStore } from '@/stores/useDownloadStore'
import { useShallow } from 'zustand/react/shallow'

/** Aggregate download progress for a hub resource and its dependency queue (matches Hub detail panel). */
export function useHubInstallDlInfo(rid) {
  const r = String(rid)
  return useDownloadStore(
    useShallow((s) => {
      const main = s.byHubResourceId.get(r)
      if (!main) return null
      const related = s.items.filter(
        (d) => d.status !== 'cancelled' && (d.hub_resource_id === r || d.parent_ref === main.package_ref),
      )
      const total = related.length
      const completed = related.filter((d) => d.status === 'completed').length
      const failed = related.filter((d) => d.status === 'failed').length
      const hasActive = related.some((d) => d.status === 'active' || d.status === 'queued')
      if (!hasActive && completed === total) return null
      let totalSize = 0,
        loadedSize = 0
      for (const d of related) {
        const sz = d.file_size || 0
        totalSize += sz
        if (d.status === 'completed') loadedSize += sz
        else if (d.status === 'active') loadedSize += s.liveProgress[d.id]?.bytesLoaded ?? 0
      }
      const progress =
        totalSize > 0
          ? Math.round((loadedSize / totalSize) * 100)
          : total > 0
            ? Math.round((completed / total) * 100)
            : 0
      return {
        total,
        completed,
        failed,
        progress,
        active: hasActive,
        packageRef: main.package_ref || null,
      }
    }),
  )
}
