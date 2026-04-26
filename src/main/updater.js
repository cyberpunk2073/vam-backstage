import { app, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { notify } from './notify.js'
import { getSetting, setSetting } from './db.js'

const DEV_ROLLING_TAG = 'dev-latest'

let ipcHandlersRegistered = false
let fullUpdaterInitialized = false
let dailyCheckTimer = null

// Dev uses the generic provider pointed at a fixed rolling release URL, so we never hit
// GitHubProvider's releases.atom walk (which orders tags lexicographically and would
// always surface `vX.Y.Z` stable tags above `dev-latest`). Stable falls back to the
// default feed parsed from `app-update.yml` (embedded at build time from
// `electron-builder.yml`'s `publish` block), so owner/repo live in a single place.
async function applyChannel(channel) {
  const cfg = await autoUpdater.configOnDisk.value
  if (channel === 'dev') {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `https://github.com/${cfg.owner}/${cfg.repo}/releases/download/${DEV_ROLLING_TAG}`,
    })
  } else {
    autoUpdater.setFeedURL(cfg)
  }
  // GenericProvider reads `channel` for latest.yml vs beta.yml; always use latest.yml here.
  autoUpdater.channel = 'latest'
  autoUpdater.allowPrerelease = false
  // `channel` setter forces allowDowngrade=true; we never want that.
  autoUpdater.allowDowngrade = false
}

function readChannel() {
  return getSetting('update_channel') === 'dev' ? 'dev' : 'stable'
}

async function runCheck(extra = {}) {
  try {
    const r = await autoUpdater.checkForUpdates()
    if (r == null) return { ok: true, disabled: true, ...extra }
    return {
      ok: true,
      disabled: false,
      isUpdateAvailable: r.isUpdateAvailable === true,
      latestVersion: r.updateInfo?.version ?? null,
      ...extra,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...extra }
  }
}

export function initAutoUpdater() {
  if (!ipcHandlersRegistered) {
    ipcHandlersRegistered = true
    ipcMain.handle('updater:install', () => {
      if (is.dev) return
      autoUpdater.quitAndInstall(false, true)
    })
    ipcMain.handle('updater:check', () =>
      is.dev ? Promise.resolve({ ok: true, disabled: true, dev: true }) : runCheck(),
    )
    ipcMain.handle('updater:getChannel', () => readChannel())
    ipcMain.handle('updater:setChannel', async (_, channel) => {
      if (channel !== 'stable' && channel !== 'dev') {
        return { ok: false, error: `invalid channel: ${String(channel)}` }
      }
      setSetting('update_channel', channel)
      if (is.dev) {
        return { ok: true, channel }
      }
      void applyChannel(channel)
        .then(() => runCheck({ channel }))
        .catch(() => {})
      return { ok: true, channel }
    })
  }

  if (is.dev || fullUpdaterInitialized) return
  fullUpdaterInitialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    notify('updater:update-available', { version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    notify('updater:update-downloaded', { version: info.version })
  })

  void applyChannel(readChannel())
    .then(() => autoUpdater.checkForUpdates())
    .catch(() => {})

  if (dailyCheckTimer != null) clearInterval(dailyCheckTimer)
  dailyCheckTimer = setInterval(
    () => {
      void runCheck()
    },
    24 * 60 * 60 * 1000,
  )

  app.on('will-quit', () => {
    if (dailyCheckTimer != null) {
      clearInterval(dailyCheckTimer)
      dailyCheckTimer = null
    }
  })
}
