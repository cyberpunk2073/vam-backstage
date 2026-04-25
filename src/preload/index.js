import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  packages: {
    list: (filters) => ipcRenderer.invoke('packages:list', filters),
    detail: (filename) => ipcRenderer.invoke('packages:detail', filename),
    stats: () => ipcRenderer.invoke('packages:stats'),
    statusCounts: () => ipcRenderer.invoke('packages:status-counts'),
    typeCounts: () => ipcRenderer.invoke('packages:type-counts'),
    tagCounts: () => ipcRenderer.invoke('packages:tag-counts'),
    authorCounts: () => ipcRenderer.invoke('packages:author-counts'),
    install: (ref) => ipcRenderer.invoke('packages:install', ref),
    installMissing: (filename, autoQueueDeps) =>
      ipcRenderer.invoke('packages:install-missing', { filename, autoQueueDeps }),
    installAllMissing: () => ipcRenderer.invoke('packages:install-all-missing'),
    installDepsBatch: (items, autoQueueDeps) =>
      ipcRenderer.invoke('packages:install-deps-batch', { items, autoQueueDeps }),
    installDep: (hubFileData) => ipcRenderer.invoke('packages:install-dep', hubFileData),
    missingDeps: () => ipcRenderer.invoke('packages:missing-deps'),
    enrichFromHub: (stems) => ipcRenderer.invoke('packages:enrich-from-hub', stems),
    removeOrphans: () => ipcRenderer.invoke('packages:remove-orphans'),
    checkUpdates: (opts) => ipcRenderer.invoke('packages:check-updates', opts),
    uninstall: (filename) => ipcRenderer.invoke('packages:uninstall', filename),
    promote: (filename, hubResourceId) => ipcRenderer.invoke('packages:promote', filename, hubResourceId),
    forceRemove: (filename) => ipcRenderer.invoke('packages:force-remove', filename),
    toggleEnabled: (filename) => ipcRenderer.invoke('packages:toggle-enabled', filename),
    setTypeOverride: (filenameOrPayload, typeOverride) =>
      typeof filenameOrPayload === 'object' && filenameOrPayload !== null && 'filenames' in filenameOrPayload
        ? ipcRenderer.invoke('packages:set-type-override', filenameOrPayload)
        : ipcRenderer.invoke('packages:set-type-override', { filename: filenameOrPayload, typeOverride }),
    fileList: (filename) => ipcRenderer.invoke('packages:file-list', filename),
    redownload: (filename) => ipcRenderer.invoke('packages:redownload', filename),
  },
  contents: {
    list: (filters) => ipcRenderer.invoke('contents:list', filters),
    typeCounts: () => ipcRenderer.invoke('contents:type-counts'),
    visibilityCounts: () => ipcRenderer.invoke('contents:visibility-counts'),
    toggleHidden: (payload) => ipcRenderer.invoke('contents:toggle-hidden', payload),
    toggleFavorite: (payload) => ipcRenderer.invoke('contents:toggle-favorite', payload),
    setHiddenBatch: (payload) => ipcRenderer.invoke('contents:set-hidden-batch', payload),
    setFavoriteBatch: (payload) => ipcRenderer.invoke('contents:set-favorite-batch', payload),
  },
  thumbnails: {
    get: (keys) => ipcRenderer.invoke('thumbnails:get', keys),
  },
  avatars: {
    get: (usernames) => ipcRenderer.invoke('avatars:get', usernames),
  },
  hub: {
    search: (params) => ipcRenderer.invoke('hub:search', params),
    detail: (id) => ipcRenderer.invoke('hub:detail', id),
    filters: () => ipcRenderer.invoke('hub:filters'),
    invalidateCaches: () => ipcRenderer.invoke('hub:invalidateCaches'),
    checkAvailability: (refs) => ipcRenderer.invoke('hub:check-availability', refs),
    localSnapshot: (resourceIds) => ipcRenderer.invoke('hub:localSnapshot', resourceIds),
    scanPackages: () => ipcRenderer.invoke('hub:scan-packages'),
  },
  downloads: {
    list: () => ipcRenderer.invoke('downloads:list'),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    retry: (id) => ipcRenderer.invoke('downloads:retry', id),
    clearCompleted: () => ipcRenderer.invoke('downloads:clear-completed'),
    clearFailed: () => ipcRenderer.invoke('downloads:clear-failed'),
    removeFailed: (id) => ipcRenderer.invoke('downloads:remove-failed', id),
    isPaused: () => ipcRenderer.invoke('downloads:is-paused'),
    pauseAll: () => ipcRenderer.invoke('downloads:pause-all'),
    resumeAll: () => ipcRenderer.invoke('downloads:resume-all'),
    cancelAll: () => ipcRenderer.invoke('downloads:cancel-all'),
  },
  scan: {
    start: () => ipcRenderer.invoke('scan:start'),
    applyAutoHide: () => ipcRenderer.invoke('scan:apply-auto-hide'),
    removeAutoHide: () => ipcRenderer.invoke('scan:remove-auto-hide'),
  },
  integrity: {
    check: () => ipcRenderer.invoke('integrity:check'),
  },
  startup: {
    consumeUnreadable: () => ipcRenderer.invoke('startup:consume-unreadable'),
  },
  wizard: {
    detectVamDir: () => ipcRenderer.invoke('wizard:detect-vam-dir'),
    browseVamDir: (defaultPath) => ipcRenderer.invoke('wizard:browse-vam-dir', defaultPath),
    enrichHub: () => ipcRenderer.invoke('wizard:enrich-hub'),
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getDatabasePath: () => ipcRenderer.invoke('settings:getDatabasePath'),
  },
  dev: {
    isDev: () => ipcRenderer.invoke('dev:is-dev'),
    nukeDatabase: () => ipcRenderer.invoke('dev:nuke-database'),
    browserAssistDirExists: () => ipcRenderer.invoke('dev:browser-assist-dir-exists'),
    syncBrowserAssist: () => ipcRenderer.invoke('dev:sync-browser-assist'),
  },
  extract: {
    probeScene: (p) => ipcRenderer.invoke('extract:probe-scene', p),
    probePackage: (fn) => ipcRenderer.invoke('extract:probe-package', fn),
    run: (p) => ipcRenderer.invoke('extract:run', p),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (fullPath) => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
  },
  updater: {
    install: () => ipcRenderer.invoke('updater:install'),
    check: () => ipcRenderer.invoke('updater:check'),
    getChannel: () => ipcRenderer.invoke('updater:getChannel'),
    setChannel: (channel) => ipcRenderer.invoke('updater:setChannel', channel),
  },

  // Event subscriptions — each returns a cleanup function
  on: (channel, callback) => {
    const handler = (_, ...args) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  // Convenience: well-known event channels
  onPackagesUpdated: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('packages:updated', handler)
    return () => ipcRenderer.removeListener('packages:updated', handler)
  },
  onContentsUpdated: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('contents:updated', handler)
    return () => ipcRenderer.removeListener('contents:updated', handler)
  },
  onDownloadsUpdated: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('downloads:updated', handler)
    return () => ipcRenderer.removeListener('downloads:updated', handler)
  },
  onDownloadProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
  onDownloadFailed: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download:failed', handler)
    return () => ipcRenderer.removeListener('download:failed', handler)
  },
  onScanProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  },
  onIntegrityProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('integrity:progress', handler)
    return () => ipcRenderer.removeListener('integrity:progress', handler)
  },
  onScanUnreadable: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('scan:unreadable', handler)
    return () => ipcRenderer.removeListener('scan:unreadable', handler)
  },
  onHubScanProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('hub-scan:progress', handler)
    return () => ipcRenderer.removeListener('hub-scan:progress', handler)
  },
  onApplyAutoHideProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('auto-hide:progress', handler)
    return () => ipcRenderer.removeListener('auto-hide:progress', handler)
  },
  onUpdateAvailable: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('updater:update-available', handler)
    return () => ipcRenderer.removeListener('updater:update-available', handler)
  },
  onUpdateDownloaded: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('updater:update-downloaded', handler)
    return () => ipcRenderer.removeListener('updater:update-downloaded', handler)
  },
}

// When the browser detects network recovery, notify the main process so
// downloads waiting on retry backoff can resume immediately.
window.addEventListener('online', () => {
  ipcRenderer.invoke('downloads:network-online').catch(() => {})
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
