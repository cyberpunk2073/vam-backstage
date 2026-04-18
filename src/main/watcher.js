import { watch } from 'fs'
import chokidar from 'chokidar'
import { join, extname, basename, relative, sep } from 'path'
import { stat, mkdir, rename as fsRename } from 'fs/promises'
import { ADDON_PACKAGES, ADDON_PACKAGES_FILE_PREFS } from '../shared/paths.js'
import { isVarFilename, canonicalVarFilename } from './scanner/var-reader.js'
import { scanAndUpsert } from './scanner/ingest.js'
import { deletePackage, getPackageCacheInfo, setPackageEnabled } from './db.js'
import { buildFromDb, getPrefsMap, setPrefsMap, getPackageIndex, getForwardDeps, patchEnabled } from './store.js'
import { computeCascadeEnable } from './scanner/graph.js'
import { notify } from './notify.js'
import { enrichNewPackages } from './hub/scanner.js'

const DEBOUNCE_MS = 500

let packageWatcher = null
let prefsWatcher = null
let prefsDirPath = null
let vamDirPath = null
let pendingPackageEvents = new Map() // fullPath -> 'add'|'change'|'unlink'
let pendingPrefsEvents = new Map() // fullPath -> 'check'
let debounceTimer = null
let processing = false

// Paths the app itself is about to write — watcher should ignore these
const suppressedPaths = new Set()
const SUPPRESS_TTL_MS = 5000

// Package stems whose prefs sidecar events should be temporarily ignored
// (used during bulk writes where the caller rebuilds prefs from disk after)
const suppressedStems = new Set()

export function suppressPath(path) {
  suppressedPaths.add(path)
  setTimeout(() => suppressedPaths.delete(path), SUPPRESS_TTL_MS)
}

export function suppressPrefsStem(stem) {
  suppressedStems.add(stem)
}

export function unsuppressPrefsStem(stem) {
  suppressedStems.delete(stem)
}

export async function startWatcher(vamDir) {
  if (packageWatcher) return // already running
  vamDirPath = vamDir

  const addonDir = join(vamDir, ADDON_PACKAGES)
  const prefsDir = join(vamDir, ADDON_PACKAGES_FILE_PREFS)

  // Ensure prefs dir exists so chokidar can watch it
  await mkdir(prefsDir, { recursive: true }).catch(() => {})

  packageWatcher = chokidar.watch(addonDir, {
    ignoreInitial: true,
    depth: 10,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
  })
  packageWatcher
    .on('add', (p) => onPackageEvent(p, 'add'))
    .on('change', (p) => onPackageEvent(p, 'change'))
    .on('unlink', (p) => onPackageEvent(p, 'unlink'))
    .on('error', (err) => console.warn('Package watcher error:', err.message))

  initPrefsWatcher(prefsDir)

  console.log('FS watcher started:', addonDir)
}

function initPrefsWatcher(prefsDir) {
  if (prefsWatcher) {
    prefsWatcher.close()
    prefsWatcher = null
  }
  prefsDirPath = prefsDir
  try {
    prefsWatcher = watch(prefsDir, { recursive: true }, (_eventType, filename) => {
      if (filename) onPrefsEvent(filename)
    })
    prefsWatcher.on('error', (err) => {
      console.warn('Prefs watcher error:', err.message)
      if (err.code === 'EMFILE' || err.code === 'ENFILE') {
        setTimeout(() => initPrefsWatcher(prefsDir), 3000)
      }
    })
  } catch (err) {
    console.warn('Failed to start prefs watcher:', err.message)
  }
}

export function stopWatcher() {
  if (packageWatcher) {
    packageWatcher.close()
    packageWatcher = null
  }
  if (prefsWatcher) {
    prefsWatcher.close()
    prefsWatcher = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPackageEvents.clear()
  pendingPrefsEvents.clear()
  vamDirPath = null
}

function onPackageEvent(path, type) {
  if (!isVarFilename(basename(path))) return
  if (suppressedPaths.delete(path)) return
  pendingPackageEvents.set(path, type)
  scheduleBatch()
}

function onPrefsEvent(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  const ext = extname(normalized).toLowerCase()
  if (ext !== '.hide' && ext !== '.fav') return

  const segments = normalized.split('/')
  if (segments.length < 2) return
  if (suppressedStems.has(segments[0])) return

  const fullPath = join(prefsDirPath, relativePath)
  if (suppressedPaths.delete(fullPath)) return

  pendingPrefsEvents.set(fullPath, 'check')
  scheduleBatch()
}

function scheduleBatch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(processBatch, DEBOUNCE_MS)
}

async function processBatch() {
  if (processing) {
    scheduleBatch() // reschedule if already processing
    return
  }
  processing = true

  const pkgEvents = new Map(pendingPackageEvents)
  const prefsEvents = new Map(pendingPrefsEvents)
  pendingPackageEvents.clear()
  pendingPrefsEvents.clear()

  let packagesChanged = false
  let contentsChanged = false
  const newlyScannedEnabled = [] // enabled filenames that were freshly added/changed

  // --- Package events ---
  if (pkgEvents.size > 0) {
    // Group events by canonical filename to detect .var ↔ .var.disabled renames
    const byCanonical = new Map()
    for (const [fullPath, type] of pkgEvents) {
      const name = basename(fullPath)
      const isDisabled = /\.disabled$/i.test(name)
      const canonical = isDisabled ? canonicalVarFilename(name) : name
      if (!byCanonical.has(canonical)) byCanonical.set(canonical, [])
      byCanonical.get(canonical).push({ fullPath, type, isDisabled })
    }

    for (const [canonical, events] of byCanonical) {
      const unlinkEvent = events.find((e) => e.type === 'unlink')
      const addEvent = events.find((e) => e.type === 'add' || e.type === 'change')

      // Rename pair: unlink of one extension + add of the other → just flip is_enabled
      if (unlinkEvent && addEvent && unlinkEvent.isDisabled !== addEvent.isDisabled) {
        setPackageEnabled(canonical, !addEvent.isDisabled)
        packagesChanged = true
        continue
      }

      // Normal processing: unlinks first, then adds/changes
      for (const { fullPath, isDisabled } of events.filter((e) => e.type === 'unlink')) {
        try {
          // Check if the other extension exists on disk (rename where add event
          // is delayed by awaitWriteFinish and will arrive in a later batch)
          const altPath = isDisabled ? fullPath.replace(/\.disabled$/i, '') : fullPath + '.disabled'
          let altExists = false
          try {
            await stat(altPath)
            altExists = true
          } catch {}
          if (altExists) {
            setPackageEnabled(canonical, isDisabled) // the remaining file's state
            packagesChanged = true
          } else {
            deletePackage(canonical)
            packagesChanged = true
            contentsChanged = true
          }
        } catch (err) {
          console.warn('Watcher: unlink failed for', canonical, err.message)
        }
      }
      for (const { fullPath, type, isDisabled } of events.filter((e) => e.type !== 'unlink')) {
        try {
          const changed = await scanSingleVar(fullPath, !isDisabled)
          if (changed) {
            packagesChanged = true
            contentsChanged = true
            if (!isDisabled) newlyScannedEnabled.push(canonical)
          }
        } catch (err) {
          console.warn(`Watcher: ${type} failed for`, canonical, err.message)
          notify('scan:unreadable', { filename: canonical })
        }
      }
    }

    if (packagesChanged) buildFromDb()

    // Cascade-enable disabled deps needed by newly added enabled packages
    if (newlyScannedEnabled.length > 0) {
      const pkgIndex = getPackageIndex()
      const fwd = getForwardDeps()
      const allToEnable = new Set()
      for (const fn of newlyScannedEnabled) {
        for (const dep of computeCascadeEnable(fn, pkgIndex, fwd)) allToEnable.add(dep)
      }
      if (allToEnable.size > 0 && vamDirPath) {
        const addonDir = join(vamDirPath, ADDON_PACKAGES)
        for (const depFn of allToEnable) {
          const oldPath = join(addonDir, depFn + '.disabled')
          const newPath = join(addonDir, depFn)
          suppressPath(oldPath)
          suppressPath(newPath)
          try {
            await fsRename(oldPath, newPath)
          } catch {
            continue
          }
          setPackageEnabled(depFn, true)
        }
        patchEnabled([...allToEnable], true)
      }
    }

    if (newlyScannedEnabled.length > 0) {
      enrichNewPackages(newlyScannedEnabled)
    }
  }

  // --- Prefs/sidecar events ---
  if (prefsEvents.size > 0) {
    const prefsDir = join(vamDirPath, ADDON_PACKAGES_FILE_PREFS)
    const prefsMap = getPrefsMap()

    for (const [fullPath] of prefsEvents) {
      try {
        const rel = relative(prefsDir, fullPath)
        const segments = rel.split(sep)
        if (segments.length < 2) continue

        const pkgStem = segments[0]
        const pkgFilename = pkgStem + '.var'
        const sidecarExt = extname(fullPath).toLowerCase()
        const contentRelPath = segments.slice(1).join('/')
        const internalPath = contentRelPath.slice(0, -sidecarExt.length)
        const key = pkgFilename + '/' + internalPath

        // fs.watch gives rename for both create and delete — stat to get current state
        let exists = false
        try {
          await stat(fullPath)
          exists = true
        } catch {}

        if (!prefsMap.has(key)) prefsMap.set(key, { hidden: false, favorite: false })
        const prefs = prefsMap.get(key)

        if (sidecarExt === '.hide') prefs.hidden = exists
        else if (sidecarExt === '.fav') prefs.favorite = exists
      } catch (err) {
        console.warn('Watcher: prefs event failed:', err.message)
      }
    }

    setPrefsMap(prefsMap)
    contentsChanged = true
  }

  // --- Notify renderer ---
  if (packagesChanged) notify('packages:updated')
  if (contentsChanged) notify('contents:updated')

  processing = false
}

async function scanSingleVar(fullPath, isEnabled = true) {
  const filename = canonicalVarFilename(basename(fullPath))

  let s
  try {
    s = await stat(fullPath)
  } catch {
    return false
  }

  const mtime = s.mtimeMs / 1000
  const size = s.size
  const enabledInt = isEnabled ? 1 : 0

  const cached = getPackageCacheInfo(filename)
  if (cached && cached.file_mtime === mtime && cached.size_bytes === size) {
    if (cached.is_enabled !== enabledInt) setPackageEnabled(filename, isEnabled)
    return false // no change
  }

  const result = await scanAndUpsert(fullPath, { isEnabled, isDirect: 1 })
  return result != null
}
