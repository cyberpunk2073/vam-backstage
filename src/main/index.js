import { app, shell, session, BrowserWindow, powerMonitor, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { openDatabase, closeDatabase, getSetting, setSetting, gcOrphanLabels } from './db.js'
import { buildFromDb, setPrefsMap } from './store.js'
import { readAllPrefs } from './vam-prefs.js'
import { registerAllHandlers } from './ipc/index.js'
import { initDownloadManager, onNetworkOnline } from './downloads/manager.js'
import { startWatcher, stopWatcher } from './watcher.js'
import { warmFileWatcherBackend } from './watcher-warm.js'
import { resolvePackageThumbnails } from './thumb-resolver.js'
import { runStartupMigrations } from './startup-migrations.js'
import { initNotify, notify } from './notify.js'
import { initLogForward, forwardLogToRenderer, flushBufferedLogs } from './log-forward.js'
import { runScan } from './scanner/index.js'
import { refreshLibraryDirs } from './library-dirs.js'
import { setPendingStartupUnreadable } from './ipc/scanner.js'
import { fetchPackagesJson, loadPackagesJsonFromCache } from './hub/packages-json.js'
import { scanHubDetails } from './hub/scanner.js'
import { initHubAuthWatch } from './hub/interactions.js'
import { initAutoUpdater } from './updater.js'
import { installRegistry } from './remote/registry.js'
import { startServer, stopServer } from './remote/server.js'
import { getServePort, getConnectUrl } from './remote/cli.js'
import { initAutostart, readAutostartUrl } from './remote/autostart.js'
import { DEFAULT_REMOTE_PORT } from '@shared/remote-config.js'
import { HUB_HTTP_USER_AGENT } from '@shared/hub-http.js'
import {
  attachMainWindowStatePersistence,
  loadMainWindowState,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} from './window-state.js'

// Wrap console.* once, very early, so that:
//   1. Benign GUEST_VIEW_MANAGER_CALL abort noise (from rapid Hub tab switches)
//      is dropped before reaching stderr.
//   2. Every remaining call is mirrored into the renderer DevTools console
//      via main:log, so opening DevTools (F12 in dev mode) shows main + renderer
//      logs interleaved.
{
  const nativeConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }
  const isGuestAbortNoise = (args) => {
    const s = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a))).join(' ')
    return (
      s.includes('GUEST_VIEW_MANAGER_CALL') &&
      (s.includes('ERR_ABORTED') || s.includes('ERR_FAILED') || /\(-[23]\)/.test(s))
    )
  }
  // The forward call is the only thing that can plausibly throw (IPC clone
  // failure, dead webContents). Catching it here keeps log calls side-effect-
  // only without burying real bugs in the noise filter or the native console.
  const wrap =
    (level) =>
    (...args) => {
      if ((level === 'warn' || level === 'error') && isGuestAbortNoise(args)) return
      nativeConsole[level](...args)
      try {
        forwardLogToRenderer(level, args)
      } catch {}
    }
  console.log = wrap('log')
  console.info = wrap('info')
  console.warn = wrap('warn')
  console.error = wrap('error')
  console.debug = wrap('debug')
}

let mainWindow = null

const HUB_ORIGIN = new URL('https://hub.virtamate.com').origin

// `npm run dev` sets VAM_DEV_USERDATA to isolate dev in a `-dev` userData;
// `dev:installed` leaves it unset to attach to the installed data. Must run
// before initAutostart and the `-client` swap so both inherit the dev root.
if (process.env.VAM_DEV_USERDATA) {
  app.setPath('userData', app.getPath('userData') + '-dev')
}

// Bind the client-autostart file to the BASE userData dir now, before the
// `-client` swap below — both instances must resolve the same path.
initAutostart(app.getPath('userData'))

// Remote-mode switches, resolved once at startup from argv. `CONNECT_URL` set =
// this instance is a pure client head (backend suppressed, UI points at a
// remote server). `SERVE_PORT` set = expose the backend over the LAN.
//
// Connect resolution order: explicit CLI/env `--connect` wins; otherwise, when
// we're not being told to host (`--serve`), fall back to the persisted
// client-autostart URL. This is what makes a saved client head come up on a
// plain launch — no relaunch needed, since the connect URL is forwarded to the
// preload via additionalArguments in createWindow.
const SERVE_PORT = getServePort()
const CONNECT_URL = getConnectUrl() || (SERVE_PORT == null ? readAutostartUrl() : null)
const IS_CLIENT = !!CONNECT_URL
// Serving without a local window: headless host.
const HEADLESS_SERVE = SERVE_PORT != null && !IS_CLIENT

// A client and a server may run on the same machine; keep the client's
// userData (DB is unused, but window-state + persist:hub cookies are not) in a
// separate dir so the two instances don't clobber each other.
if (IS_CLIENT) {
  app.setPath('userData', app.getPath('userData') + '-client')
}

// Single-instance guard. After the client userData swap on purpose: the lock is
// keyed on the userData dir, so a client head and the normal/serve backend (which
// use different dirs) coexist, while two of the same kind don't — a duplicate
// backend against the shared backstage.db + Chromium profile causes IO errors and
// racing writers. The loser quits before opening anything (whenReady early-returns).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })
}

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

/** DevTools hotkeys are live whenever a dev build is running or the 7-tap unlock is set. */
function devHotkeysEnabled() {
  if (is.dev) return true
  try {
    return getSetting('developer_options_unlocked') === '1'
  } catch {
    return false
  }
}

/**
 * Reload (Cmd/Ctrl+R, Shift for force) and DevTools (F12 / Ctrl+Shift+I /
 * Cmd+Alt+I) hotkeys match default app-menu accelerators that target the
 * *top-level* window — so pressing them while the Hub <webview> guest is focused
 * blows away the whole renderer / opens the host's DevTools instead of acting on
 * the page you're looking at. Intercept at the guest: preventDefault also cancels
 * the menu shortcut (per Electron's before-input-event contract), so these act on
 * just the guest. Host-focused presses keep the default behavior. DevTools runs in
 * dev too since `optimizer.watchWindowShortcuts` only wires the host window.
 */
function attachWebviewShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.code === 'KeyR' && (input.meta || input.control) && !input.alt) {
      event.preventDefault()
      if (input.shift) contents.reloadIgnoringCache()
      else contents.reload()
      return
    }
    const isF12 = input.code === 'F12'
    const isInspector = input.code === 'KeyI' && input.shift && (input.control || input.meta || input.alt)
    if ((isF12 || isInspector) && devHotkeysEnabled()) {
      event.preventDefault()
      contents.toggleDevTools()
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
    attachWebviewShortcuts(contents)
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

/**
 * In dev (`is.dev`), `@electron-toolkit/utils`'s `optimizer.watchWindowShortcuts`
 * already wires F12. In packaged builds it doesn't, and additionally blocks
 * Ctrl+Shift+I / Cmd+Alt+I. Re-enable both when developer options are unlocked
 * so support users can open DevTools without a dev build. Setting is re-read
 * each press so the 7-tap unlock takes effect immediately.
 */
function attachDevToolsHotkeys(window) {
  if (is.dev) return
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const isF12 = input.code === 'F12'
    const isInspector = input.code === 'KeyI' && input.shift && (input.control || input.meta || input.alt)
    if (!isF12 && !isInspector) return
    let unlocked = false
    try {
      unlocked = getSetting('developer_options_unlocked') === '1'
    } catch {}
    if (!unlocked) return
    window.webContents.toggleDevTools()
  })
}

function createWindow() {
  // Client head has no DB, so window-state read/persist (both go through the
  // settings table) is skipped — fall back to default geometry.
  const saved = IS_CLIENT ? null : loadMainWindowState()
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
      // The preload needs the connect URL synchronously (before any async IPC)
      // to decide which transport to build. It's the only value forwarded;
      // version/dev flags come from the client's own local IPC handlers.
      ...(CONNECT_URL ? { additionalArguments: [`--connect=${CONNECT_URL}`] } : {}),
    },
  })
  if (!IS_CLIENT) attachMainWindowStatePersistence(mainWindow)

  mainWindow.on('ready-to-show', () => {
    if (saved?.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Defense-in-depth against file drag-and-drop: if a `.var` is dropped onto the
  // window at a moment the renderer's DropImport handler isn't mounted (e.g.
  // during the first-run wizard, or before React hydrates), Electron would
  // otherwise navigate the top frame to the dropped `file://` URL and blow away
  // the app. Block any top-frame navigation away from the app's own document.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  attachNativeTextContextMenu(mainWindow.webContents, mainWindow)
  attachDevToolsHotkeys(mainWindow)

  mainWindow.webContents.on('did-finish-load', () => flushBufferedLogs())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Identify programmatic Hub / CDN traffic as VaM Backstage. Applies to
 * `net.fetch` and anything else on defaultSession. Leave `persist:hub` alone —
 * the Hub webview and cookie-bound scrape requests must keep Electron's UA so
 * Cloudflare's `cf_clearance` still matches.
 */
function installDefaultSessionUserAgent(ses = session.defaultSession) {
  ses.setUserAgent(HUB_HTTP_USER_AGENT)
}

/**
 * The Hub serves .var downloads with a `content-disposition: attachment;
 * filename="<pkg>.var"` header, and package names can contain non-ASCII
 * characters (e.g. Chinese: `Qing.黑色符文（免费版）.1.var`). Electron's
 * `net.fetch` throws an uncatchable error when a response header carries
 * non-ASCII bytes (electron/electron#42244), which kills the download before
 * our own try/catch ever runs.
 *
 * We never read `content-disposition` — filenames come from the Hub metadata —
 * so we just url-encode the value into valid ASCII so the parser stops choking.
 * Only this header can carry a user-supplied filename; every other header (and
 * every already-ASCII value) is passed through byte-identical, so unrelated
 * default-session traffic (thumbnails, avatars, the JSON API) is untouched.
 *
 * Must be a session-level hook: net.fetch throws while constructing the
 * Response, so there is no per-call header interception point.
 */
function installDownloadHeaderSanitizer(ses = session.defaultSession) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {}
    let changed = false
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== 'content-disposition') continue
      headers[key] = headers[key].map((v) => {
        if (!/[^\u0020-\u007e]/.test(v)) return v
        changed = true
        return encodeURIComponent(v)
      })
    }
    callback(changed ? { responseHeaders: headers } : {})
  })
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
  // Capture handler registrations into the remote registry BEFORE registering
  // them, so hot-starting the server later can dispatch to every channel.
  installRegistry()
  // Register IPC before DB open so a failed migration/open still exposes handlers
  // (renderer otherwise gets "No handler registered" for every channel).
  registerAllHandlers()
  initNotify(() => mainWindow)
  initLogForward(() => mainWindow)
  setupHubConsent()
  initHubAuthWatch()
  installDefaultSessionUserAgent()

  // Client head: no local DB / scan / watcher / downloads. Everything data-side
  // is served by the remote instance over the transport.
  if (IS_CLIENT) return

  openDatabase()
  runStartupMigrations()
  try {
    const removed = gcOrphanLabels()
    if (removed > 0) console.info(`[labels] gc removed ${removed} orphan label${removed === 1 ? '' : 's'} at startup`)
  } catch (err) {
    console.warn('[labels] startup gc failed:', err.message)
  }
  loadPackagesJsonFromCache()
  installDownloadHeaderSanitizer()
  initDownloadManager()

  refreshLibraryDirs()

  // Load existing data immediately so the UI has something to show
  const vamDir = getSetting('vam_dir')
  const scanDone = getSetting('initial_scan_done')
  if (vamDir && scanDone) {
    try {
      buildFromDb()
    } catch {}
    // startWatcher runs after startupScan (see startupScan finally) — starting the
    // FS watcher before the full library scan contends on the same volume and can
    // make walkForVars take minutes instead of sub-second.
  }
}

async function startupScan() {
  if (IS_CLIENT) return
  const vamDir = getSetting('vam_dir')
  const scanDone = getSetting('initial_scan_done')
  if (!vamDir || !scanDone) return

  if (getSetting('needs_rescan')) {
    setSetting('needs_rescan', null)
  }

  let hubBackfill = null
  try {
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
    //
    // The whole chain is detached from this try block: it uses the network
    // pool, while startWatcher's parcel subscriptions touch the libuv FS pool
    // (one-shot stat per dir). Pools are disjoint, so we run the two chains
    // concurrently and await both in the finally below.
    hubBackfill = (async () => {
      try {
        await fetchPackagesJson()
      } catch (err) {
        console.warn('[startup] packages.json refresh failed:', err.message)
      }
      try {
        await scanHubDetails((data) => notify('hub-scan:progress', data))
      } catch (err) {
        console.warn('[startup] hub detail backfill failed:', err.message)
      }
      try {
        await resolvePackageThumbnails()
      } catch (err) {
        console.warn('[startup] thumbnail resolution failed:', err.message)
      }
    })()
  } finally {
    const branches = []
    if (vamDir && getSetting('initial_scan_done')) branches.push(startWatcher(vamDir))
    if (hubBackfill) branches.push(hubBackfill)
    if (branches.length) await Promise.allSettled(branches)
  }
}

app.whenReady().then(async () => {
  // Lost the single-instance lock: quit is in flight, don't touch DB/profile.
  if (!gotSingleInstanceLock) return

  // Warm @parcel/watcher's native backend on a worker thread, before the heavy startup scan
  // and window creation, so the real (main-thread) watchers attach without the ~5s
  // Explorer-launch stall. Fire-and-forget; startWatcher awaits it. See watcher-warm.js.
  // Client head has no watcher, so skip it.
  if (!IS_CLIENT) warmFileWatcherBackend()

  electronApp.setAppUserModelId('com.cyberpunk2073.vam-backstage')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    initBackend()
  } catch (err) {
    console.error('Backend init failed:', err)
  }
  // Download manager only exists on the data-side instance.
  if (!IS_CLIENT) powerMonitor.on('resume', onNetworkOnline)
  registerWebviewWindowOpenHandler()

  // Headless host: no local window, and no auto-updater (nothing to surface the
  // install prompt to). The process stays alive because `window-all-closed`
  // never fires with zero windows.
  if (!HEADLESS_SERVE) {
    createWindow()
    initAutoUpdater()
  }

  startupScan()

  // Auto-start the LAN server when requested via CLI/env (headless, handled
  // above via HEADLESS_SERVE) or via the persisted "start on launch" preference
  // (windowed). CLI/env wins on port; the setting falls back to the last-used
  // port. Client heads never host. The setting lives in the local DB, so it is
  // never read in client mode (no DB there) — another reason client auto-connect
  // isn't a persisted flag.
  if (!IS_CLIENT) {
    let servePort = SERVE_PORT
    const autoStart = getSetting('remote_mode_enabled') === '1' && getSetting('remote_serve_on_launch') === '1'
    if (servePort == null && autoStart) {
      servePort = parseInt(getSetting('remote_serve_port'), 10) || DEFAULT_REMOTE_PORT
    }
    if (servePort != null) {
      const res = await startServer(servePort)
      if (!res.ok) console.error(`[remote] server did not start: ${res.error}`)
    }
  }

  app.on('activate', () => {
    if (!HEADLESS_SERVE && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Async shutdown drain. stopWatcher awaits parcel's native unsubscribe, which
// detaches the watcher thread's N-API threadsafe-function refs. If we don't
// await it before the env tears down, parcel's worker dispatches back into a
// freed env and triggers `napi_fatal_error` (the harmless-looking native stack
// trace on close). We intercept will-quit, drain cleanup, then force-exit.
//
// Force-exit with `app.exit(0)` (not `app.quit()`): a signal-initiated quit
// (Ctrl-C/SIGINT, which Electron consumes natively) reaches here already inside
// a quit cycle we just preventDefault'd, and calling `app.quit()` from that same
// tick is swallowed — the quit never restarts and the process hangs (on macOS it
// then orphans in the dock, since window-all-closed doesn't quit on darwin).
// `app.exit(0)` terminates unconditionally once our cleanup has run.
let draining = false
app.on('will-quit', (event) => {
  event.preventDefault()
  if (draining) return
  draining = true
  ;(async () => {
    try {
      await stopServer()
    } catch {}
    try {
      await stopWatcher()
    } catch {}
    try {
      closeDatabase()
    } catch {}
    app.exit(0)
  })()
})
