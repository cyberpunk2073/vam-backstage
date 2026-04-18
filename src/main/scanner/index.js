import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { ADDON_PACKAGES } from '../../shared/paths.js'
import { isVarFilename, canonicalVarFilename } from './var-reader.js'
import { detectLeaves } from './graph.js'
import { scanAndUpsert } from './ingest.js'
import {
  getPackageCacheInfo,
  getAllDbFilenames,
  deletePackages,
  batchSetDirect,
  setPackageEnabled,
  getSetting,
  setSetting,
} from '../db.js'
import { readAllPrefs, hidePackageContent, migratePrefsExtensions } from '../vam-prefs.js'
import {
  buildFromDb,
  buildGraphOnly,
  setPrefsMap,
  updatePref,
  getPackageIndex,
  getReverseDeps,
  getContentByPackage,
} from '../store.js'

/**
 * Run a full library scan.
 * @param {string} vamDir - VaM installation root
 * @param {function} onProgress - callback({ phase, step, total, message })
 * @returns {Promise<{ scanned: number, added: number, removed: number }>}
 */
export async function runScan(vamDir, onProgress = () => {}) {
  const addonDir = join(vamDir, ADDON_PACKAGES)
  const isInitialScan = !getSetting('initial_scan_done')

  // Phase 1: Index .var files on disk
  onProgress({ phase: 'indexing', step: 0, total: 0, message: 'Indexing .var files…' })
  const varFiles = await walkForVars(addonDir)
  onProgress({
    phase: 'indexing',
    step: varFiles.length,
    total: varFiles.length,
    message: `Found ${varFiles.length} .var files`,
  })

  // Phase 2: Read manifests (with scan cache)
  let scanned = 0,
    added = 0
  const newFilenames = new Set()
  const unreadable = []
  for (let i = 0; i < varFiles.length; i++) {
    const { filename, fullPath, mtime, size, isEnabled } = varFiles[i]
    onProgress({ phase: 'reading', step: i + 1, total: varFiles.length, message: filename })
    const enabledInt = isEnabled ? 1 : 0

    const cached = getPackageCacheInfo(filename)
    if (cached && cached.file_mtime === mtime && cached.size_bytes === size) {
      if (cached.is_enabled !== enabledInt) setPackageEnabled(filename, isEnabled)
      continue // scan cache hit
    }

    try {
      const result = await scanAndUpsert(fullPath, { isEnabled, isDirect: 0 })
      if (!result) continue
      scanned++
      if (!cached) {
        added++
        newFilenames.add(filename)
      }
    } catch (err) {
      console.warn(`Failed to scan ${filename}:`, err.message)
      unreadable.push(filename)
    }
  }

  // Phase 3: Build dependency graph — remove stale packages, classify direct vs dependency
  onProgress({ phase: 'graph', step: 0, total: 1, message: 'Detecting removed packages…' })
  const diskFilenames = new Set(varFiles.map((v) => v.filename))
  const dbFilenames = getAllDbFilenames()
  const removed = dbFilenames.filter((f) => !diskFilenames.has(f))
  if (removed.length > 0) deletePackages(removed)

  const needsLeafDetection = isInitialScan || newFilenames.size > 0 || removed.length > 0
  if (needsLeafDetection && varFiles.length > 0) {
    buildGraphOnly()
    const pkgIdx = getPackageIndex()
    const rev = getReverseDeps()
    const leaves = detectLeaves(pkgIdx, rev)

    if (isInitialScan) {
      batchSetDirect([...pkgIdx.keys()].map((fn) => [fn, leaves.has(fn)]))
    } else {
      const updates = [...newFilenames].map((fn) => [fn, leaves.has(fn)])
      for (const fn of pkgIdx.keys()) {
        if (newFilenames.has(fn)) continue
        const hadRevDeps = rev.has(fn) && rev.get(fn).size > 0
        const pkg = pkgIdx.get(fn)
        if (!hadRevDeps && !pkg.is_direct) updates.push([fn, true])
      }
      if (updates.length > 0) batchSetDirect(updates)
    }
  }
  onProgress({ phase: 'graph', step: 1, total: 1, message: 'Dependency graph built' })

  // Phase 6: Finalize — rebuild in-memory store
  onProgress({ phase: 'finalizing', step: 0, total: 1, message: 'Loading preferences…' })
  if (getSetting('needs_prefs_migration')) {
    await migratePrefsExtensions(vamDir)
    setSetting('needs_prefs_migration', null)
  }
  const prefs = await readAllPrefs(vamDir)
  setPrefsMap(prefs)

  onProgress({ phase: 'finalizing', step: 1, total: 1, message: 'Building indexes…' })
  buildFromDb()

  if (isInitialScan) {
    setSetting('initial_scan_done', '1')
  }

  return { scanned, added, removed: removed.length, unreadable }
}

/**
 * Recursively find all .var and .var.disabled files under a directory.
 * Returns [{ filename, fullPath, mtime, size, isEnabled }]
 * filename is always the canonical .var form.
 * Within a single directory, .var takes precedence if both .var and .var.disabled exist.
 */
async function walkForVars(dir) {
  const results = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const localFiles = new Map()
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...(await walkForVars(fullPath)))
      } else if (entry.isFile() && isVarFilename(entry.name)) {
        const isDisabled = /\.disabled$/i.test(entry.name)
        const canonical = isDisabled ? canonicalVarFilename(entry.name) : entry.name
        const existing = localFiles.get(canonical)
        if (existing && !existing.isDisabled) continue // .var already found, skip .var.disabled
        localFiles.set(canonical, { fullPath, isDisabled })
      }
    }
    for (const [canonical, { fullPath, isDisabled }] of localFiles) {
      try {
        const s = await stat(fullPath)
        results.push({ filename: canonical, fullPath, mtime: s.mtimeMs / 1000, size: s.size, isEnabled: !isDisabled })
      } catch {}
    }
  } catch {}
  return results
}

/**
 * Apply auto-hide to dependency packages' content after initial scan.
 * Creates .hide for items in dep packages that aren't already hidden.
 * @param {string} vamDir
 * @param {(data: { current: number, total: number, filename?: string, items: number }) => void} [onProgress]
 */
export async function applyAutoHide(vamDir, onProgress = () => {}) {
  const pkgIndex = getPackageIndex()
  const cbp = getContentByPackage()

  const work = []
  let totalItems = 0
  for (const [filename, pkg] of pkgIndex) {
    if (pkg.is_direct) continue
    const items = cbp.get(filename) || []
    const paths = items.filter((c) => !c.hidden).map((c) => c.internal_path)
    if (paths.length > 0) {
      work.push({ filename, paths })
      totalItems += paths.length
    }
  }

  onProgress({ current: 0, total: work.length, items: totalItems })
  let done = 0
  for (const { filename, paths } of work) {
    onProgress({ current: done, total: work.length, filename, items: totalItems })
    await hidePackageContent(vamDir, filename, paths)
    for (const p of paths) updatePref(filename, p, 'hidden', true)
    done++
  }
  onProgress({ current: work.length, total: work.length, items: totalItems })
}
