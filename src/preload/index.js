import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { createRemoteTransport } from './remote-transport.js'

// `--connect=<url>` is forwarded here via webPreferences.additionalArguments in
// client mode. It must be read synchronously to pick the transport before any
// api method runs. Without it, the transport is a thin passthrough to IPC, so
// the normal local app is behaviourally unchanged.
const connectArg = process.argv.find((a) => a.startsWith('--connect='))
const connectUrl = connectArg ? connectArg.slice('--connect='.length) : null

const transport = connectUrl
  ? createRemoteTransport(connectUrl)
  : {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, callback) => {
        const handler = (_e, ...args) => callback(...args)
        ipcRenderer.on(channel, handler)
        return () => ipcRenderer.removeListener(channel, handler)
      },
      remote: { isRemote: false },
    }

const invoke = transport.invoke

const api = {
  packages: {
    list: (filters) => invoke('packages:list', filters),
    detail: (filename) => invoke('packages:detail', filename),
    stats: () => invoke('packages:stats'),
    statusCounts: () => invoke('packages:status-counts'),
    typeCounts: () => invoke('packages:type-counts'),
    tagCounts: () => invoke('packages:tag-counts'),
    authorCounts: () => invoke('packages:author-counts'),
    install: (ref) => invoke('packages:install', ref),
    installMissing: (filename, autoQueueDeps) => invoke('packages:install-missing', { filename, autoQueueDeps }),
    installAllMissing: () => invoke('packages:install-all-missing'),
    installDepsBatch: (items, autoQueueDeps) => invoke('packages:install-deps-batch', { items, autoQueueDeps }),
    installDep: (hubFileData) => invoke('packages:install-dep', hubFileData),
    missingDeps: () => invoke('packages:missing-deps'),
    enrichFromHub: (stems) => invoke('packages:enrich-from-hub', stems),
    removeOrphans: () => invoke('packages:remove-orphans'),
    checkUpdates: (opts) => invoke('packages:check-updates', opts),
    uninstall: (filename) => invoke('packages:uninstall', filename),
    promote: (filename, hubResourceId) => invoke('packages:promote', filename, hubResourceId),
    forceRemove: (filename) => invoke('packages:force-remove', filename),
    toggleEnabled: (filename) => invoke('packages:toggle-enabled', filename),
    setEnabled: (filenames, enabled) => invoke('packages:set-enabled', { filenames, enabled }),
    setTypeOverride: (filenameOrPayload, typeOverride) =>
      typeof filenameOrPayload === 'object' && filenameOrPayload !== null && 'filenames' in filenameOrPayload
        ? invoke('packages:set-type-override', filenameOrPayload)
        : invoke('packages:set-type-override', { filename: filenameOrPayload, typeOverride }),
    fileList: (filename) => invoke('packages:file-list', filename),
    redownload: (filename) => invoke('packages:redownload', filename),
    setHubResource: (filename, id) => invoke('packages:setHubResource', filename, id),
  },
  contents: {
    list: (filters) => invoke('contents:list', filters),
    typeCounts: () => invoke('contents:type-counts'),
    visibilityCounts: () => invoke('contents:visibility-counts'),
    toggleHidden: (payload) => invoke('contents:toggle-hidden', payload),
    toggleFavorite: (payload) => invoke('contents:toggle-favorite', payload),
    setHiddenBatch: (payload) => invoke('contents:set-hidden-batch', payload),
    setFavoriteBatch: (payload) => invoke('contents:set-favorite-batch', payload),
  },
  labels: {
    list: () => invoke('labels:list'),
    create: ({ name }) => invoke('labels:create', { name }),
    rename: ({ id, name }) => invoke('labels:rename', { id, name }),
    recolor: ({ id, color }) => invoke('labels:recolor', { id, color }),
    delete: ({ id }) => invoke('labels:delete', { id }),
    applyToPackages: ({ id, filenames, applied }) => invoke('labels:apply-packages', { id, filenames, applied }),
    applyToContents: ({ id, items, applied }) => invoke('labels:apply-contents', { id, items, applied }),
  },
  thumbnails: {
    get: (keys) => invoke('thumbnails:get', keys),
  },
  avatars: {
    get: (usernames) => invoke('avatars:get', usernames),
  },
  hub: {
    search: (params) => invoke('hub:search', params),
    detail: (id) => invoke('hub:detail', id),
    filters: () => invoke('hub:filters'),
    invalidateCaches: () => invoke('hub:invalidateCaches'),
    checkAvailability: (refs) => invoke('hub:check-availability', refs),
    localSnapshot: (resourceIds) => invoke('hub:localSnapshot', resourceIds),
    scanPackages: () => invoke('hub:scan-packages'),
    isLoggedIn: () => invoke('hub:isLoggedIn'),
    resourceUserState: (id) => invoke('hub:resourceUserState', id),
    toggleFavorite: (id) => invoke('hub:toggleFavorite', id),
    toggleBookmark: (id, currentlyBookmarked) => invoke('hub:toggleBookmark', id, currentlyBookmarked),
    toggleLike: (id, currentlyLiked) => invoke('hub:toggleLike', id, currentlyLiked),
  },
  wishlist: {
    list: () => invoke('wishlist:list'),
    ids: () => invoke('wishlist:ids'),
    add: (resourceId, snapshot) => invoke('wishlist:add', resourceId, snapshot),
    remove: (resourceId) => invoke('wishlist:remove', resourceId),
  },
  downloads: {
    list: () => invoke('downloads:list'),
    cancel: (id) => invoke('downloads:cancel', id),
    retry: (id) => invoke('downloads:retry', id),
    clearCompleted: () => invoke('downloads:clear-completed'),
    clearFailed: () => invoke('downloads:clear-failed'),
    removeFailed: (id) => invoke('downloads:remove-failed', id),
    isPaused: () => invoke('downloads:is-paused'),
    pauseAll: () => invoke('downloads:pause-all'),
    resumeAll: () => invoke('downloads:resume-all'),
    cancelAll: () => invoke('downloads:cancel-all'),
  },
  scan: {
    start: () => invoke('scan:start'),
    applyAutoHide: (ruleId) => invoke('scan:apply-auto-hide', ruleId),
    removeAutoHide: (ruleId) => invoke('scan:remove-auto-hide', ruleId),
  },
  integrity: {
    check: () => invoke('integrity:check'),
  },
  startup: {
    consumeUnreadable: () => invoke('startup:consume-unreadable'),
  },
  wizard: {
    detectVamDir: () => invoke('wizard:detect-vam-dir'),
    browseVamDir: (defaultPath) => invoke('wizard:browse-vam-dir', defaultPath),
    enrichHub: () => invoke('wizard:enrich-hub'),
  },
  settings: {
    get: (key) => invoke('settings:get', key),
    set: (key, value) => invoke('settings:set', key, value),
    getDatabasePath: () => invoke('settings:getDatabasePath'),
  },
  libraryDirs: {
    list: () => invoke('library-dirs:list'),
    browse: () => invoke('library-dirs:browse'),
    add: (path) => invoke('library-dirs:add', path),
    remove: (id) => invoke('library-dirs:remove', id),
  },
  dev: {
    isDev: () => invoke('dev:is-dev'),
    nukeDatabase: () => invoke('dev:nuke-database'),
    browserAssistDirExists: () => invoke('dev:browser-assist-dir-exists'),
    syncBrowserAssist: () => invoke('dev:sync-browser-assist'),
  },
  extract: {
    probeScene: (p) => invoke('extract:probe-scene', p),
    probePackage: (fn) => invoke('extract:probe-package', fn),
    resolveSource: (p) => invoke('extract:resolve-source', p),
    run: (p) => invoke('extract:run', p),
    runForPackages: (p) => invoke('extract:run-for-packages', p),
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
    showItemInFolder: (fullPath) => invoke('shell:showItemInFolder', fullPath),
  },
  app: {
    getVersion: () => invoke('app:version'),
  },
  updater: {
    install: () => invoke('updater:install'),
    check: () => invoke('updater:check'),
    getChannel: () => invoke('updater:getChannel'),
    setChannel: (channel) => invoke('updater:setChannel', channel),
  },
  remote: {
    isRemote: transport.remote.isRemote,
    url: transport.remote.url ?? null,
    status: () => invoke('remote:status'),
    localIps: () => invoke('remote:local-ips'),
    getAutoconnect: () => invoke('remote:get-autoconnect'),
    setAutoconnect: (url) => invoke('remote:set-autoconnect', url),
    startServer: (port) => invoke('remote:start', port),
    stopServer: () => invoke('remote:stop'),
    connect: (url) => invoke('remote:relaunch-connect', url),
    disconnect: () => invoke('remote:relaunch-disconnect'),
    onStatus: (cb) => transport.remote.onStatus?.(cb) ?? (() => {}),
  },

  // Event subscriptions — each returns a cleanup function. All route through the
  // transport, which delivers events from the socket (remote mode) and/or the
  // local ipcRenderer, with the event object already stripped.
  on: (channel, callback) => transport.on(channel, callback),
  // Convenience: well-known event channels
  onPackagesUpdated: (cb) => transport.on('packages:updated', () => cb()),
  onWishlistUpdated: (cb) => transport.on('wishlist:updated', () => cb()),
  onContentsUpdated: (cb) => transport.on('contents:updated', () => cb()),
  onLabelsUpdated: (cb) => transport.on('labels:updated', () => cb()),
  onDownloadsUpdated: (cb) => transport.on('downloads:updated', () => cb()),
  onDownloadProgress: (cb) => transport.on('download:progress', (data) => cb(data)),
  onDownloadFailed: (cb) => transport.on('download:failed', (data) => cb(data)),
  onScanProgress: (cb) => transport.on('scan:progress', (data) => cb(data)),
  onIntegrityProgress: (cb) => transport.on('integrity:progress', (data) => cb(data)),
  onScanUnreadable: (cb) => transport.on('scan:unreadable', (data) => cb(data)),
  onHubScanProgress: (cb) => transport.on('hub-scan:progress', (data) => cb(data)),
  onHubAuthChanged: (cb) => transport.on('hub:auth-changed', (data) => cb(data)),
  onApplyAutoHideProgress: (cb) => transport.on('auto-hide:progress', (data) => cb(data)),
  onUpdateAvailable: (cb) => transport.on('updater:update-available', (data) => cb(data)),
  onUpdateDownloaded: (cb) => transport.on('updater:update-downloaded', (data) => cb(data)),
}

// Mirror main-process logs into the renderer DevTools console. Errors sent
// from the main process arrive as { __mainLogError, name, message, stack };
// rehydrate to a real Error so DevTools renders them with a clickable stack.
ipcRenderer.on('main:log', (_e, payload) => {
  if (!payload) return
  const { level, args } = payload
  const fn = console[level] || console.log
  const restored = (args || []).map((a) => {
    if (a && typeof a === 'object' && a.__mainLogError) {
      const err = new Error(a.message)
      err.name = a.name || 'Error'
      err.stack = a.stack
      return err
    }
    return a
  })
  fn('%c[main]', 'color:#888', ...restored)
})

// When the browser detects network recovery, notify the (possibly remote)
// download manager so downloads waiting on retry backoff can resume immediately.
window.addEventListener('online', () => {
  invoke('downloads:network-online').catch(() => {})
})

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
