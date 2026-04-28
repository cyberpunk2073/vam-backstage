import { useDownloadStore } from '../stores/useDownloadStore'

/**
 * Resolves the current state of a Library "Update to vX" action for one package.
 * Reads optimistic `pendingUpdates` (set synchronously on click), the queue
 * indexed by hub-target filename, and the live progress for active transfers.
 *
 * @param {{ filename: string }} pkg - the locally-installed package the button is rendered for
 * @param {{ hubFilename?: string, hubVersion?: number, hubResourceId?: string, packageName?: string }} updateInfo
 * @returns {{ state: 'available'|'pending'|'queued'|'downloading'|'failed', progress: number|null, dl: object|null }}
 */
export function useLibraryUpdateState(pkg, updateInfo) {
  const filename = pkg?.filename || null
  const hubFilename = updateInfo?.hubFilename || null

  const pending = useDownloadStore((s) => (filename ? s.pendingUpdates.has(filename) : false))

  const dl = useDownloadStore((s) => {
    if (!hubFilename) return null
    return s.byPackageRef.get(hubFilename) || s.byPackageRef.get(hubFilename.replace(/\.var$/i, '')) || null
  })

  const progress = useDownloadStore((s) => {
    if (!dl || dl.status !== 'active') return null
    return s.liveProgress[dl.id]?.progress ?? null
  })

  let state = 'available'
  if (pending) state = 'pending'
  else if (dl?.status === 'active') state = 'downloading'
  else if (dl?.status === 'queued') state = 'queued'
  else if (dl?.status === 'failed') state = 'failed'

  return { state, progress, dl }
}
