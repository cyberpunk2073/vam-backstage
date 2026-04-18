import { useInstalledStore } from '../stores/useInstalledStore'

const NOT_INSTALLED = Object.freeze({ installed: false, isDirect: false, filename: null })

/**
 * Canonical install-status for a hub package.  Reads from the single
 * `useInstalledStore` — no caller-provided props, no download-state mixing.
 *
 * @param {string} hubResourceId
 * @returns {{ installed: boolean, isDirect: boolean, filename: string|null }}
 */
export function useInstallStatus(hubResourceId) {
  return useInstalledStore((s) => s.byHubResourceId.get(String(hubResourceId)) ?? NOT_INSTALLED)
}
