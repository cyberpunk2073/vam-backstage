import { useInstallStatus } from './useInstallStatus'
import { useHubInstallDlInfo } from './useHubInstallDlInfo'
import { useDownloadStore } from '../stores/useDownloadStore'

/**
 * Resolves the current install/download action state for a hub resource.
 * Returns a discriminated `state` string plus the underlying data each consumer needs.
 *
 * @param {string} rid - stringified hub resource_id
 * @param {{ isExternal: boolean }} opts
 * @returns {{ state: 'downloading'|'queued'|'installed'|'installed-dep'|'external'|'failed'|'install', dlInfo, installStatus }}
 */
export function useHubInstallState(rid, { isExternal } = {}) {
  const installStatus = useInstallStatus(rid)
  const dlInfo = useHubInstallDlInfo(rid)
  const mainDlStatus = useDownloadStore((s) => {
    const d = s.byHubResourceId.get(rid)
    if (!d || d.status === 'completed' || d.status === 'cancelled') return null
    return d.status
  })
  const pendingInstall = useDownloadStore((s) => s.pendingInstalls.has(rid))

  let state
  if (dlInfo?.active) state = 'downloading'
  else if (pendingInstall) state = 'queued'
  else if (installStatus.installed && installStatus.isDirect) state = 'installed'
  else if (installStatus.installed) state = 'installed-dep'
  else if (isExternal) state = 'external'
  else if (mainDlStatus === 'failed') state = 'failed'
  else state = 'install'

  return { state, dlInfo, installStatus }
}
