import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { isVarFilename, canonicalVarFilename } from './var-reader.js'
import { detectLeaves } from './graph.js'
import { scanAndUpsert } from './ingest.js'
import { inheritFromOlderVersion } from './inherit.js'
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
  effectivePackageType,
} from '../store.js'
import { isLocalPackage } from '@shared/local-package.js'
import { refreshLibraryDirs, getAllLibraryDirs, libraryRelSubpath } from '../library-dirs.js'
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
  /** Map<filename, { packageName, contentItems }> for freshly-added rows. Doubles
   * as the "new filenames" set via `.has()` / `.keys()` — extra metadata is used
   * by the inheritance pass below, key membership by leaf detection downstream. */
  const newAdditions = new Map()
  const unreadable = []
  for (let i = 0; i < varFiles.length; i++) {
    const { filename, fullPath, mtime, size, storageState, libraryDirId, subpath } = varFiles[i]
    onProgress({ phase: 'reading', step: i + 1, total: varFiles.length, message: filename })

    const cached = getPackageCacheInfo(filename)
    if (cached && cached.file_mtime === mtime && cached.size_bytes === size) {
      // Cache hit (unchanged bytes) still reconciles location: storage_state, the
      // library dir, and the subfolder the file now lives in (a same-mtime move
      // into/out of a subdir, or a backfilled v24 row whose subpath is still '').
      if (
        cached.storage_state !== storageState ||
        (cached.library_dir_id ?? null) !== (libraryDirId ?? null) ||
        (cached.subpath ?? '') !== subpath
      ) {
        setStorageState(filename, storageState, libraryDirId, subpath)
      }
      continue // scan cache hit
    }

    try {
      const result = await scanAndUpsert(fullPath, { storageState, libraryDirId, subpath, isDirect: 0 })
      if (!result) continue
      scanned++
      if (!cached) {
        added++
        newAdditions.set(filename, { packageName: result.packageName, contentItems: result.contentItems })
      }
    } catch (err) {
      console.warn(`Failed to scan ${filename}:`, err.message)
      unreadable.push(filename)
    }
  }

  // Inherit user-set settings (labels, content visibility sidecars, custom
  // category) from the previous version of each freshly-added package — but
  // only on non-initial scans. The first ever scan indexes packages that have
  // always been on disk; users haven't had a chance to set anything yet, and
  // any sidecars already on disk are read separately by `readAllPrefs` in the
  // finalize phase below. Skipping inheritance on the initial pass also avoids
  // reorganizing existing on-disk sidecar layouts that the user may have
  // intentionally curated per stem. The `first_seen_at` gate inside
  // `inheritFromOlderVersion` keeps mass-additions (multiple new versions in
  // one scan) from picking one of the other still-empty new peers as a donor.
  if (!isInitialScan && newAdditions.size > 0) {
    for (const [filename, info] of newAdditions) {
      try {
        await inheritFromOlderVersion({
          filename,
          packageName: info.packageName,
          contentItems: info.contentItems,
          vamDir,
        })
      } catch (err) {
        console.warn(`Inherit from older version failed for ${filename}:`, err.message)
      }
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

  const needsLeafDetection = isInitialScan || newAdditions.size > 0 || removed.length > 0
  if (needsLeafDetection && varFiles.length > 0) {
    buildGraphOnly()
    const pkgIdx = getPackageIndex()
    const rev = getReverseDeps()
    const leaves = detectLeaves(pkgIdx, rev)

    if (isInitialScan) {
      batchSetDirect([...pkgIdx.keys()].map((fn) => [fn, leaves.has(fn)]))
    } else {
      const updates = [...newAdditions.keys()].map((fn) => [fn, leaves.has(fn)])
      for (const fn of pkgIdx.keys()) {
        if (newAdditions.has(fn)) continue
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
            subpath: libraryRelSubpath(dir, fullPath),
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
 * Declarative table of every auto-hide rule. Each entry contributes a
 * `matches(pkgCtx, content)` predicate that decides whether the rule wants
 * the given content item hidden in the given package. All four rules
 * (`deps` + the three `foreign_*`) share one engine — apply/remove sweeps
 * walk the table generically and the only cross-rule logic lives in
 * `isClaimedByAnyExcept`.
 *
 * `pkgCtx = { filename, is_direct, effective_type }` is a minimal package
 * shape that works for both the in-memory `packageIndex` row (during a
 * sweep) and the partial info we have mid-install (in `postDownloadIntegrate`,
 * where `packageIndex` hasn't been rebuilt yet).
 *
 * Adding a new rule is a single table entry. Looks/Scenes are deliberately
 * omitted — they're commonly bundled as demos.
 *
 * Targeted-sweep + deference invariant:
 *   - `applyAutoHideRule(X)` hides items in rule X's claim that aren't
 *     already hidden.
 *   - `removeAutoHideRule(X)` unhides items in rule X's claim that *are*
 *     hidden AND aren't still claimed by any other active rule. Caller
 *     flips X's setting off before calling so X is naturally excluded.
 *   - The user's "Turn on/off without sweep" path simply flips the setting
 *     and skips the engine entirely; future installs honor the new state
 *     via `computeAutoHidePathsForNewPackage`.
 */
const AUTO_HIDE_RULES = [
  {
    id: 'deps',
    settingKey: 'auto_hide_deps',
    matches: (ctx) => !ctx.is_direct,
  },
  {
    id: 'foreign_hair',
    settingKey: 'auto_hide_foreign_hair',
    matches: (ctx, c) => ctx.effective_type !== 'Hairstyles' && (c.type === 'hairItem' || c.type === 'hairPreset'),
  },
  {
    id: 'foreign_poses',
    settingKey: 'auto_hide_foreign_poses',
    matches: (ctx, c) => ctx.effective_type !== 'Poses' && (c.type === 'pose' || c.type === 'legacyPose'),
  },
  {
    id: 'foreign_clothing',
    settingKey: 'auto_hide_foreign_clothing',
    matches: (ctx, c) =>
      ctx.effective_type !== 'Clothing' && (c.type === 'clothingItem' || c.type === 'clothingPreset'),
  },
]

function makePkgCtx(filename, pkg) {
  return { filename, is_direct: !!pkg.is_direct, effective_type: effectivePackageType(pkg) }
}

/**
 * Returns true iff some *other* rule (different id) is currently enabled
 * AND would itself claim this item. This is the only place the engine
 * needs cross-rule awareness — `removeAutoHideRule` consults it to leave
 * items alone that another active rule still wants hidden.
 */
function isClaimedByAnyExcept(ctx, content, excludeRuleId) {
  for (const r of AUTO_HIDE_RULES) {
    if (r.id === excludeRuleId) continue
    if (getSetting(r.settingKey) !== '1') continue
    if (r.matches(ctx, content)) return true
  }
  return false
}

/**
 * Compute the union of `.hide` paths to write for a freshly installed
 * package, across every currently-enabled rule. Caller passes
 * `effectiveType` and `isDirect` directly because the in-memory
 * `packageIndex` is stale between `scanAndUpsert` and `buildGraphOnly`;
 * `contentItems` are in upserter shape (`internalPath`, no `hidden` field
 * yet — fresh-on-disk means nothing is already hidden).
 */
export function computeAutoHidePathsForNewPackage(filename, effectiveType, isDirect, contentItems) {
  if (isLocalPackage(filename)) return []
  const ctx = { filename, is_direct: !!isDirect, effective_type: effectiveType ?? null }
  const hits = new Set()
  for (const rule of AUTO_HIDE_RULES) {
    if (getSetting(rule.settingKey) !== '1') continue
    for (const c of contentItems) {
      if (rule.matches(ctx, c)) hits.add(c.internalPath)
    }
  }
  return [...hits]
}

function findRule(ruleId) {
  const rule = AUTO_HIDE_RULES.find((r) => r.id === ruleId)
  if (!rule) throw new Error(`Unknown auto-hide rule: ${ruleId}`)
  return rule
}

/**
 * Walk every non-local package and collect content paths the given rule
 * wants to act on. `pick(ctx, c)` returns the path to act on or null —
 * apply mode picks not-yet-hidden items; remove mode picks currently-hidden
 * items that no other active rule still claims.
 */
function collectRuleWork(rule, pick) {
  const pkgIndex = getPackageIndex()
  const cbp = getContentByPackage()
  const work = []
  let totalItems = 0
  for (const [filename, pkg] of pkgIndex) {
    if (isLocalPackage(filename)) continue
    const ctx = makePkgCtx(filename, pkg)
    const items = cbp.get(filename) || []
    const paths = []
    for (const c of items) {
      if (!rule.matches(ctx, c)) continue
      const p = pick(ctx, c)
      if (p != null) paths.push(p)
    }
    if (paths.length > 0) {
      work.push({ filename, paths })
      totalItems += paths.length
    }
  }
  return { work, totalItems }
}

/**
 * Apply rule `ruleId`: hide items in its claim that aren't already hidden.
 * Idempotent — re-running with the same setting state is a no-op.
 * @param {string} vamDir
 * @param {string} ruleId
 * @param {(data: { current: number, total: number, filename?: string, items: number }) => void} [onProgress]
 */
export async function applyAutoHideRule(vamDir, ruleId, onProgress = () => {}) {
  const rule = findRule(ruleId)
  const { work, totalItems } = collectRuleWork(rule, (_ctx, c) => (c.hidden ? null : c.internal_path))

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
 * Remove rule `ruleId`: unhide items in its claim that are currently hidden
 * AND not still claimed by any other active rule. The caller is expected to
 * have already flipped `rule.settingKey` to `'0'` so this rule itself is no
 * longer "active" from `isClaimedByAnyExcept`'s perspective; the deference
 * helper would still skip the same `ruleId` either way, so order isn't
 * load-bearing — it just keeps semantics intuitive.
 * @param {string} vamDir
 * @param {string} ruleId
 * @param {(data: { current: number, total: number, filename?: string, items: number }) => void} [onProgress]
 */
export async function removeAutoHideRule(vamDir, ruleId, onProgress = () => {}) {
  const rule = findRule(ruleId)
  const { work, totalItems } = collectRuleWork(rule, (ctx, c) => {
    if (!c.hidden) return null
    if (isClaimedByAnyExcept(ctx, c, rule.id)) return null
    return c.internal_path
  })

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
