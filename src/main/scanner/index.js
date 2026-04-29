import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { isLocalPackage } from '@shared/local-package.js'
import { isVarFilename, canonicalVarFilename } from './var-reader.js'
import { detectLeaves } from './graph.js'
import { scanAndUpsert } from './ingest.js'
import {
  getPackageCacheInfo,
  getAllDbFilenamesWithDir,
  deletePackages,
  batchSetDirect,
  setStorageState,
  getSetting,
  setSetting,
} from '../db.js'
import { readAllPrefs, hidePackageContent, unhidePackageContent, migratePrefsExtensions } from '../vam-prefs.js'
import { runLocalScan } from './local.js'
import { pLimit } from '../p-limit.js'
import {
  buildFromDb,
  buildGraphOnly,
  setPrefsMap,
  updatePref,
  getPackageIndex,
  getReverseDeps,
  getContentByPackage,
} from '../store.js'
import { refreshLibraryDirs, getAllLibraryDirs } from '../library-dirs.js'
import { normalizeAuxDisabled } from '../watcher.js'

/**
 * Run a full library scan across the main dir and every registered aux dir.
 * @param {string} vamDir - VaM installation root
 * @param {function} onProgress - callback({ phase, step, total, message })
 * @returns {Promise<{ scanned: number, added: number, removed: number }>}
 */
export async function runScan(vamDir, onProgress = () => {}) {
  refreshLibraryDirs()
  const dirs = getAllLibraryDirs() // [{ id: null|number, path }] (main first)
  const isInitialScan = !getSetting('initial_scan_done')

  // Phase 1: Index .var files on disk
  onProgress({ phase: 'indexing', step: 0, total: 0, message: 'Indexing .var files…' })
  const varFiles = []
  // Cross-dir collision policy: main wins, then offload dirs by created_at ascending.
  // `dirs` is already in that order, so dedup-by-first-seen implements the policy.
  // The shadowed copies are byte-identical (.var is content-addressed and immutable),
  // so silently picking one is invisible to the user.
  const seenFilenames = new Set()
  // Track which dir ids we successfully reached so we don't treat packages
  // sitting in a temporarily-offline offload dir (unmounted drive, etc.) as removed.
  const reachableDirIds = new Set()
  for (const dir of dirs) {
    const { results, ok } = await walkForVars(dir.path, dir.id)
    if (!ok) {
      console.warn(`[scanner] Library directory unreachable, skipping prune for it: ${dir.path}`)
      continue
    }
    reachableDirIds.add(dir.id ?? null)
    for (const r of results) {
      if (seenFilenames.has(r.filename)) continue
      seenFilenames.add(r.filename)
      varFiles.push(r)
    }
  }
  const offlineCount = dirs.length - reachableDirIds.size
  onProgress({
    phase: 'indexing',
    step: varFiles.length,
    total: varFiles.length,
    message: `Found ${varFiles.length} .var files${offlineCount ? ` (${offlineCount} dir(s) offline)` : ''}`,
  })

  // Phase 2: Read manifests (with scan cache)
  let scanned = 0,
    added = 0
  const newFilenames = new Set()
  const unreadable = []
  for (let i = 0; i < varFiles.length; i++) {
    const { filename, fullPath, mtime, size, storageState, libraryDirId } = varFiles[i]
    onProgress({ phase: 'reading', step: i + 1, total: varFiles.length, message: filename })

    const cached = getPackageCacheInfo(filename)
    if (cached && cached.file_mtime === mtime && cached.size_bytes === size) {
      if (cached.storage_state !== storageState || (cached.library_dir_id ?? null) !== (libraryDirId ?? null)) {
        setStorageState(filename, storageState, libraryDirId)
      }
      continue // scan cache hit
    }

    try {
      const result = await scanAndUpsert(fullPath, { storageState, libraryDirId, isDirect: 0 })
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
  // Removed = rows whose home dir we successfully scanned AND whose canonical filename
  // wasn't seen on disk. Offline-aux protection (skip prune for packages whose dir
  // failed to enumerate) AND `__local__` sentinel exclusion (it's never on disk).
  const removed = getAllDbFilenamesWithDir()
    .filter(
      (r) =>
        !isLocalPackage(r.filename) && reachableDirIds.has(r.library_dir_id ?? null) && !diskFilenames.has(r.filename),
    )
    .map((r) => r.filename)
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

  onProgress({ phase: 'local', step: 0, total: 1, message: 'Indexing loose Saves/Custom…' })
  try {
    await runLocalScan(vamDir)
  } catch (err) {
    console.warn('Local content scan failed:', err.message)
  }
  onProgress({ phase: 'local', step: 1, total: 1, message: 'Loose content indexed' })

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

// Default libuv pool is 4 workers; 8 is 2× headroom for transient bursts.
// Higher values just pad the queue without adding parallelism. The limiter is
// call-scoped (one per walkForVars call) — a recursive per-directory limiter
// would compound and reproduce the cross-phase contention failure mode.
const VAR_STAT_CONCURRENCY = 8

/**
 * Recursively find all `.var` (and `.var.disabled`) files under `dir`.
 *
 * Returns `{ results: [{ filename, fullPath, mtime, size, storageState, libraryDirId }], ok }`:
 *  - `ok` is false only when the root `dir` itself was unreachable (offline aux dir,
 *    missing path); caller uses this to skip pruning packages that may still live there.
 *  - Unreadable subdirectories are silently skipped without flipping `ok`.
 *
 * `filename` is always the canonical `.var` form. Within one directory the suffix-less
 * `.var` wins if both variants are present.
 *
 * Aux dirs (`libraryDirId != null`) are always suffix-less in our model. Stray
 * `.var.disabled` files from external tooling are normalized via `normalizeAuxDisabled`
 * (rename to bare `.var` when no sibling exists, otherwise unlink). One-time fixup.
 *
 * Two-pass for performance: collect dirents (cheap, sequential by directory) then `stat`
 * candidates under `pLimit(VAR_STAT_CONCURRENCY)` so AV / cross-FS latency doesn't
 * serialize on a single libuv worker. Symlinks skipped explicitly (Windows quirk:
 * directory symlinks return `isDirectory() === false` so we'd otherwise miss them
 * here only to have chokidar follow them later).
 */
async function walkForVars(dir, libraryDirId) {
  const t0 = Date.now()
  const candidates = []
  const ok = await collectVarCandidates(dir, candidates, true)
  if (!ok) return { results: [], ok: false }

  const limit = pLimit(VAR_STAT_CONCURRENCY)
  const records = await Promise.all(
    candidates.map((c) =>
      limit(async () => {
        let { fullPath, isDisabled, canonical } = c
        if (libraryDirId != null && isDisabled) {
          const bare = await normalizeAuxDisabled(fullPath)
          if (!bare) return null
          fullPath = bare
          isDisabled = false
        }
        try {
          const s = await stat(fullPath)
          const storageState = libraryDirId != null ? 'offloaded' : isDisabled ? 'disabled' : 'enabled'
          return {
            filename: canonical,
            fullPath,
            mtime: s.mtimeMs / 1000,
            size: s.size,
            storageState,
            libraryDirId,
          }
        } catch {
          return null
        }
      }),
    ),
  )
  const results = records.filter(Boolean)
  console.info(
    `Library scan: indexed ${results.length} .var files in ${Date.now() - t0} ms (libraryDirId=${libraryDirId ?? 'main'})`,
  )
  return { results, ok: true }
}

/**
 * Recursive dirent walk that pushes `{canonical, fullPath, isDisabled}` candidates
 * into `out`. Returns false only when the **root** `dir` is unreachable so the
 * caller can distinguish "nothing here" from "couldn't read here". Sub-directory
 * read failures are silently skipped (matches today's silent-skip semantics).
 */
export async function collectVarCandidates(dir, out, isRoot) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return !isRoot
  }
  const localFiles = new Map()
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      // Belt-and-braces: the load-bearing Windows quirk is that isDirectory()
      // returns false for directory symlinks (so we skip them by accident);
      // explicit check survives any future refactor that resolves symlinks.
      continue
    } else if (entry.isDirectory()) {
      await collectVarCandidates(fullPath, out, false)
    } else if (entry.isFile() && isVarFilename(entry.name)) {
      const isDisabled = /\.disabled$/i.test(entry.name)
      const canonical = isDisabled ? canonicalVarFilename(entry.name) : entry.name
      const existing = localFiles.get(canonical)
      if (existing && !existing.isDisabled) continue // .var already found, skip .var.disabled
      localFiles.set(canonical, { fullPath, isDisabled })
    }
  }
  for (const [canonical, { fullPath, isDisabled }] of localFiles) {
    out.push({ canonical, fullPath, isDisabled })
  }
  return true
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

/**
 * Remove .hide from all hidden content in dependency packages (e.g. when user turns off auto-hide).
 * @param {string} vamDir
 * @param {(data: { current: number, total: number, filename?: string, items: number }) => void} [onProgress]
 */
export async function removeAutoHide(vamDir, onProgress = () => {}) {
  const pkgIndex = getPackageIndex()
  const cbp = getContentByPackage()

  const work = []
  let totalItems = 0
  for (const [filename, pkg] of pkgIndex) {
    if (pkg.is_direct) continue
    const items = cbp.get(filename) || []
    const paths = items.filter((c) => c.hidden).map((c) => c.internal_path)
    if (paths.length > 0) {
      work.push({ filename, paths })
      totalItems += paths.length
    }
  }

  onProgress({ current: 0, total: work.length, items: totalItems })
  let done = 0
  for (const { filename, paths } of work) {
    onProgress({ current: done, total: work.length, filename, items: totalItems })
    await unhidePackageContent(vamDir, filename, paths)
    for (const p of paths) updatePref(filename, p, 'hidden', false)
    done++
  }
  onProgress({ current: work.length, total: work.length, items: totalItems })
}
