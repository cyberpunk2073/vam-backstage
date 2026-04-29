import { readdir, readFile, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { classifyContents } from './classifier.js'
import { personAtomIdsJsonFromBuffer, PERSON_ATOM_ID_CONTENT_TYPES } from './ingest.js'
import { pLimit } from '../p-limit.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_ROOTS } from '@shared/local-package.js'
import { ensureLocalPackage, getLocalContentMeta, upsertContents, deleteContentsForPackagePaths } from '../db.js'

// Default libuv pool is 4 workers; 8 is 2× headroom for transient bursts.
// See VAR_STAT_CONCURRENCY in scanner/index.js for the same reasoning.
const LOCAL_STAT_CONCURRENCY = 8

/**
 * Walk loose-content roots — `Saves/` and `Custom/` under the VaM dir — and
 * sync the resulting items into the `contents` table under the synthetic
 * `__local__` package. Files are classified with the same rules used for
 * packaged content, so loose scenes/looks/poses/etc. show up in the gallery
 * with the right type and thumbnail.
 *
 * Mirrors the var scan's mtime+size gate, just at item granularity instead of
 * package granularity. Each loose file is `stat`ed once; if its `(mtime, size)`
 * matches the existing row AND its classification (display name, type,
 * thumbnail) is unchanged, the row is left alone — no re-readFile, no parse,
 * no DB write. Only changed/new items are upserted; only paths that vanished
 * are deleted. The per-item stat is the loose analog of the per-package stat
 * the var scanner does in `runScan()`.
 *
 * The classification fields are part of the gate (not just stat) so that
 * sibling-thumbnail additions still update the row even when the content
 * file's own mtime didn't move — `classifyContents` is sibling-aware, so
 * `thumbnailPath` can shift without the file itself changing.
 *
 * Both roots being inaccessible aborts reconciliation (transient FS failure
 * protection — don't blow away the whole local index on a momentary EACCES).
 */
export async function runLocalScan(vamDir) {
  if (!vamDir) return { added: 0, removed: 0, total: 0 }
  ensureLocalPackage()

  const fileList = []
  let anyRootWalked = false
  for (const root of LOCAL_CONTENT_ROOTS) {
    const walked = await walk(join(vamDir, root), vamDir, fileList)
    if (walked) anyRootWalked = true
  }
  if (!anyRootWalked) return { added: 0, removed: 0, total: 0 }

  const statByPath = new Map(fileList.map((f) => [f.path, { mtime: f.mtime, size: f.size }]))
  const items = classifyContents(fileList)
  const previousMeta = getLocalContentMeta(LOCAL_PACKAGE_FILENAME)

  const upsertRows = []
  let added = 0
  for (const item of items) {
    const cur = statByPath.get(item.internalPath)
    const prev = previousMeta.get(item.internalPath)
    const statMoved = !prev || prev.mtime !== cur.mtime || prev.size !== cur.size
    const classMoved =
      !prev ||
      prev.displayName !== item.displayName ||
      prev.type !== item.type ||
      prev.thumbnailPath !== item.thumbnailPath
    if (!statMoved && !classMoved) continue
    if (!prev) added++

    let personAtomIds = prev?.personAtomIds ?? null
    if (statMoved && PERSON_ATOM_ID_CONTENT_TYPES.has(item.type)) {
      let buf = null
      try {
        buf = await readFile(join(vamDir, item.internalPath))
      } catch {}
      personAtomIds = personAtomIdsJsonFromBuffer(buf, null)
    }

    upsertRows.push({
      packageFilename: LOCAL_PACKAGE_FILENAME,
      internalPath: item.internalPath,
      displayName: item.displayName,
      type: item.type,
      thumbnailPath: item.thumbnailPath,
      personAtomIds,
      fileMtime: cur.mtime,
      sizeBytes: cur.size,
    })
  }

  upsertContents(upsertRows)

  const wantPaths = new Set(items.map((i) => i.internalPath))
  const toDelete = []
  for (const path of previousMeta.keys()) {
    if (!wantPaths.has(path)) toDelete.push(path)
  }
  deleteContentsForPackagePaths(LOCAL_PACKAGE_FILENAME, toDelete)

  return { added, removed: toDelete.length, total: items.length }
}

/**
 * Two-pass walk: cheap recursive `readdir` collects every file path, then
 * `stat`s run under bounded concurrency. Pushes `{path, size, mtime}` records
 * into `out`. Returns false only if the root `readdir` itself fails (transient
 * EACCES, missing root) — sub-tree readdir failures are silently skipped.
 */
async function walk(dir, vamDir, out) {
  const files = []
  const ok = await collectLocalFiles(dir, files)
  if (!ok) return false
  if (files.length === 0) return true

  const limit = pLimit(LOCAL_STAT_CONCURRENCY)
  const records = await Promise.all(
    files.map((full) =>
      limit(async () => {
        try {
          const s = await stat(full)
          const rel = relative(vamDir, full).split(sep).join('/')
          return { path: rel, size: s.size, mtime: s.mtimeMs / 1000 }
        } catch {
          return null
        }
      }),
    ),
  )
  for (const r of records) if (r) out.push(r)
  return true
}

async function collectLocalFiles(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectLocalFiles(full, out)
    } else if (entry.isSymbolicLink()) {
      // Belt-and-braces against directory symlinks (e.g. JayJayWon's
      // BrowserAssist drops them under Saves/). On Windows, isDirectory()
      // returns false for these — explicit skip survives a future refactor.
      continue
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return true
}
