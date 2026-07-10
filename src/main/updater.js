import { app, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { notify } from './notify.js'
import { getDb, getSetting, setSetting } from './db.js'
import { stageMacUpdate, installMacUpdateAndRestart, installMacUpdateOnQuitSync } from './mac-update.js'

const DEV_ROLLING_TAG = 'dev-latest'
// Squirrel.Mac rejects our ad-hoc signature, so the mac install path is a custom
// bundle swap (see mac-update.js); electron-updater is only used for check+download.
const isMac = process.platform === 'darwin'

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

// A client head runs with no local DB (see initBackend in index.js), yet the
// updater IPC handlers are still registered. Guard the DB touch so they never
// hit an undefined `db` (which threw on the client, most visibly on reconnect
// reloads): with no DB we assume the 'stable' channel and drop the write.
function readChannel() {
  if (!getDb()) return 'stable'
  return getSetting('update_channel') === 'dev' ? 'dev' : 'stable'
}

function writeChannel(channel) {
  if (getDb()) setSetting('update_channel', channel)
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
    ipcMain.handle('updater:install', async () => {
      if (is.dev) return { ok: true, disabled: true }
      if (isMac) return installMacUpdateAndRestart()
      autoUpdater.quitAndInstall(false, true)
      return { ok: true }
    })
    ipcMain.handle('updater:check', () =>
      is.dev ? Promise.resolve({ ok: true, disabled: true, dev: true }) : runCheck(),
    )
    ipcMain.handle('updater:getChannel', () => readChannel())
    ipcMain.handle('updater:setChannel', async (_, channel) => {
      if (channel !== 'stable' && channel !== 'dev') {
        return { ok: false, error: `invalid channel: ${String(channel)}` }
      }
      writeChannel(channel)
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
  // On mac this flag is what hands the zip to Squirrel right after download
  // (MacUpdater.updateDownloaded), which then fails signature validation — keep
  // it off there; our will-quit hook below provides the same behavior.
  autoUpdater.autoInstallOnAppQuit = !isMac

  autoUpdater.on('error', (e) => {
    notify('updater:error', { message: e instanceof Error ? e.message : String(e) })
  })
  autoUpdater.on('update-available', (info) => {
    notify('updater:update-available', { version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    if (isMac) {
      // Announce "ready" only once the bundle is actually extracted and staged,
      // so the Restart button never points at a half-prepared update.
      stageMacUpdate(info.downloadedFile).then(
        () => notify('updater:update-downloaded', { version: info.version }),
        (e) =>
          notify('updater:error', {
            message: `Update could not be prepared: ${e instanceof Error ? e.message : String(e)}`,
          }),
      )
      return
    }
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
    if (isMac) installMacUpdateOnQuitSync()
    if (dailyCheckTimer != null) {
      clearInterval(dailyCheckTimer)
      dailyCheckTimer = null
    }
  })
}
