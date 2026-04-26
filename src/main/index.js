import { app, shell, session, BrowserWindow, powerMonitor, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { openDatabase, closeDatabase, getSetting, setSetting } from './db.js'
import { buildFromDb, setPrefsMap } from './store.js'
import { readAllPrefs } from './vam-prefs.js'
import { registerAllHandlers } from './ipc/index.js'
import { initDownloadManager, onNetworkOnline } from './downloads/manager.js'
import { startWatcher, stopWatcher } from './watcher.js'
import { resolvePackageThumbnails } from './thumb-resolver.js'
import { initNotify, notify } from './notify.js'
import { runScan } from './scanner/index.js'
import { setPendingStartupUnreadable } from './ipc/scanner.js'
import { fetchPackagesJson, loadPackagesJsonFromCache } from './hub/packages-json.js'
import { scanHubDetails } from './hub/scanner.js'
import { initAutoUpdater } from './updater.js'
import {
  attachMainWindowStatePersistence,
  loadMainWindowState,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} from './window-state.js'

// Electron logs unhandled IPC rejections for aborted/failed guest navigations to stderr;
// these are benign noise when switching Hub detail tabs rapidly.
{
  const orig = { error: console.error.bind(console), warn: console.warn.bind(console) }
  const isGuestAbortNoise = (args) => {
    const s = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a))).join(' ')
    return (
      s.includes('GUEST_VIEW_MANAGER_CALL') &&
      (s.includes('ERR_ABORTED') || s.includes('ERR_FAILED') || /\(-[23]\)/.test(s))
    )
  }
  console.error = (...a) => {
    if (!isGuestAbortNoise(a)) orig.error(...a)
  }
  console.warn = (...a) => {
    if (!isGuestAbortNoise(a)) orig.warn(...a)
  }
}

let mainWindow = null

const HUB_ORIGIN = new URL('https://hub.virtamate.com').origin

/**
 * Chromium often does not show the native text edit menu in Electron; with a hidden menu bar
 * it may never appear. Use standard menu roles for inputs and Copy for selected text elsewhere.
 */
function attachNativeTextContextMenu(webContents, popupHostWindow) {
  webContents.on('context-menu', (event, params) => {
    const { isEditable, selectionText, editFlags, x, y } = params
    const ef = editFlags || {}

    if (isEditable) {
      event.preventDefault()
      const menu = Menu.buildFromTemplate([
        { role: 'cut', enabled: !!ef.canCut },
        { role: 'copy', enabled: !!ef.canCopy },
        { role: 'paste', enabled: !!ef.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: !!ef.canSelectAll },
      ])
      menu.popup({ window: popupHostWindow, x, y })
      return
    }

    if (selectionText && selectionText.trim().length > 0) {
      event.preventDefault()
      Menu.buildFromTemplate([{ role: 'copy' }]).popup({ window: popupHostWindow, x, y })
    }
  })
}

/** Deny all popup windows from <webview> guests; open non-hub URLs externally. */
function registerWebviewWindowOpenHandler() {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    if (mainWindow) {
      attachNativeTextContextMenu(contents, mainWindow)
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (url && url !== 'about:blank') {
        try {
          if (new URL(url).origin !== HUB_ORIGIN) shell.openExternal(url)
        } catch {
          if (url.startsWith('http') || url.startsWith('mailto:')) shell.openExternal(url)
        }
      }
      return { action: 'deny' }
    })
  })
}

function createWindow() {
  const saved = loadMainWindowState()
  mainWindow = new BrowserWindow({
    title: 'VaM Backstage',
    width: saved?.width ?? DEFAULT_WIDTH,
    height: saved?.height ?? DEFAULT_HEIGHT,
    ...(saved && { x: saved.x, y: saved.y }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0b10',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true,
    },
  })
  attachMainWindowStatePersistence(mainWindow)

  mainWindow.on('ready-to-show', () => {
    if (saved?.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  attachNativeTextContextMenu(mainWindow.webContents, mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function setupHubConsent() {
  const hubSession = session.fromPartition('persist:hub')
  await hubSession.cookies.set({
    url: 'https://hub.virtamate.com',
    name: 'vamhubconsent',
    value: '1',
  })
}

function initBackend() {
  openDatabase()
  loadPackagesJsonFromCache()
  initNotify(() => mainWindow)
  registerAllHandlers()
  setupHubConsent()
  initDownloadManager()

  // Load existing data immediately so the UI has something to show
  const vamDir = getSetting('vam_dir')
  const scanDone = getSetting('initial_scan_done')
  if (vamDir && scanDone) {
    try {
      buildFromDb()
    } catch {}
    startWatcher(vamDir)
  }
}

async function startupScan() {
  const vamDir = getSetting('vam_dir')
  const scanDone = getSetting('initial_scan_done')
  if (!vamDir || !scanDone) return

  if (getSetting('needs_rescan')) {
    setSetting('needs_rescan', null)
  }

  try {
    const scanResult = await runScan(vamDir, (progress) => notify('scan:progress', progress))
    setPendingStartupUnreadable(scanResult.unreadable?.length ? scanResult.unreadable : null)
  } catch (err) {
    console.warn('Startup scan failed:', err.message)
    setPendingStartupUnreadable(null)
    if (!getSetting('initial_scan_done')) setSetting('initial_scan_done', '1')
    try {
      const prefs = await readAllPrefs(vamDir)
      setPrefsMap(prefs)
    } catch {}
    buildFromDb()
  }

  notify('packages:updated')
  notify('contents:updated')

  // Hub backfill chain: refresh packages.json → enrich local packages with
  // hub_resource_id + hub detail (bounded by pLimit(10) in hub/scanner.js) →
  // fetch any missing CDN thumbnails. Each step strictly follows the previous
  // so scanHubDetails sees the fresh index and resolvePackageThumbnails sees
  // the hub_resource_ids scanHubDetails just wrote.
  fetchPackagesJson({ refreshTimestamp: true })
    .catch((err) => console.warn('[startup] packages.json refresh failed:', err.message))
    .then(() => scanHubDetails((data) => notify('hub-scan:progress', data)))
    .catch((err) => console.warn('[startup] hub detail backfill failed:', err.message))
    .finally(() => resolvePackageThumbnails())
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.cyberpunk2073.vam-backstage')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    initBackend()
  } catch (err) {
    console.error('Backend init failed:', err)
  }
  powerMonitor.on('resume', onNetworkOnline)
  registerWebviewWindowOpenHandler()
  createWindow()
  initAutoUpdater()
  startupScan()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  stopWatcher()
  closeDatabase()
})
