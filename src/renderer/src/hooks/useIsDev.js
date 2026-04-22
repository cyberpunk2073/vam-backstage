import { useEffect, useState } from 'react'

/**
 * True when dev-only UI should be shown: either running under Electron dev
 * (`is.dev`), or the user manually unlocked developer options from Settings
 * (seven taps on the version string → `developer_options_unlocked = '1'`).
 * Mirrors the main-process gating used by dev/extract IPC handlers.
 *
 * Re-fetches on every mount so a mid-session toggle in Settings takes effect
 * the next time a consumer renders. The cached value seeds initial render to
 * avoid a flash of hidden-then-shown entries.
 */

let cached = null

async function loadDevFlag() {
  const [isDev, unlocked] = await Promise.all([
    window.api.dev.isDev(),
    window.api.settings.get('developer_options_unlocked'),
  ])
  return !!isDev || unlocked === '1'
}

export function useIsDev() {
  const [isDev, setIsDev] = useState(cached ?? false)
  useEffect(() => {
    let active = true
    loadDevFlag().then((v) => {
      cached = v
      if (active) setIsDev(v)
    })
    return () => {
      active = false
    }
  }, [])
  return isDev
}
