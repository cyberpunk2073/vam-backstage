/**
 * Fixture helpers for integration tests that drive the real scanner against a
 * real (temp) filesystem.
 *
 * Build a tempdir VaM layout with `mkTempVamDir()`, optionally add aux dirs
 * with `mkAuxDir()`, fabricate `.var` packages programmatically with
 * `buildVar()`, and place them on disk (with optional `.disabled` suffix) via
 * `placeVar()`. Cleanup is opt-in (`cleanup()`); on Windows leave a
 * `process.on('exit', cleanup)` if you really care about leftover tempdirs.
 *
 * The DB path is wired through `VAM_DB_PATH`. Call `openTestDatabase()` once
 * per test (or in `beforeEach`) to get a fresh, migrated SQLite file under the
 * tempdir's root.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import yazl from 'yazl'
import { ADDON_PACKAGES, ADDON_PACKAGES_FILE_PREFS } from '../../src/shared/paths.js'
import { LOCAL_CONTENT_ROOTS } from '../../src/shared/local-package.js'

/**
 * Scaffold a temp VaM root with the standard subdirs and a unique DB path.
 * Returns the layout plus a `cleanup()` that recursively removes the tempdir.
 *
 * @returns {Promise<{
 *   vamDir: string,
 *   addonPackages: string,
 *   prefsDir: string,
 *   savesDir: string,
 *   customDir: string,
 *   dbPath: string,
 *   cleanup: () => Promise<void>,
 * }>}
 */
export async function mkTempVamDir() {
  const root = await mkdtemp(join(tmpdir(), 'vam-test-'))
  const vamDir = join(root, 'VaM')
  const addonPackages = join(vamDir, ADDON_PACKAGES)
  const prefsDir = join(vamDir, ADDON_PACKAGES_FILE_PREFS)
  const savesDir = join(vamDir, LOCAL_CONTENT_ROOTS[0])
  const customDir = join(vamDir, LOCAL_CONTENT_ROOTS[1])
  await mkdir(addonPackages, { recursive: true })
  await mkdir(prefsDir, { recursive: true })
  await mkdir(savesDir, { recursive: true })
  await mkdir(customDir, { recursive: true })
  const dbPath = join(root, 'backstage.db')
  return {
    vamDir,
    addonPackages,
    prefsDir,
    savesDir,
    customDir,
    dbPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/**
 * Create a sibling tempdir on the same filesystem as the VaM root. Use as an
 * aux library dir; `applyStorageState` requires same-FS for atomic rename.
 */
export async function mkAuxDir(vamDir) {
  const parent = join(vamDir, '..')
  return mkdtemp(join(parent, 'vam-aux-'))
}

/**
 * Build a `.var` ZIP buffer programmatically.
 *
 * @param {object} args
 * @param {string} args.name — canonical filename, e.g. "Author.Pkg.1.var"
 * @param {object} [args.meta] — JS object serialized as `meta.json` (omit to skip)
 * @param {Record<string, Buffer | string>} [args.files] — internal path → contents
 * @param {string} [args.metaRaw] — raw meta.json bytes (overrides `meta`); use to
 *   inject malformed JSON for the JSON5-fallback path.
 * @returns {Promise<Buffer>}
 */
export function buildVar({ meta, files = {}, metaRaw } = {}) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    if (metaRaw != null) {
      zip.addBuffer(Buffer.from(metaRaw), 'meta.json')
    } else if (meta) {
      zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2)), 'meta.json')
    }
    for (const [path, content] of Object.entries(files)) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
      zip.addBuffer(buf, path)
    }
    const chunks = []
    zip.outputStream.on('data', (c) => chunks.push(c))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
    zip.end()
  })
}

/**
 * Write a built `.var` buffer to a library directory. Pass `disabled: true` to
 * land the file with the `.var.disabled` suffix (only meaningful in main).
 */
export async function placeVar(dirPath, name, varBuffer, { disabled = false } = {}) {
  const finalName = disabled ? name + '.disabled' : name
  const fullPath = join(dirPath, finalName)
  await writeFile(fullPath, varBuffer)
  return fullPath
}

/**
 * Open and migrate a fresh SQLite DB at `dbPath`. Sets `VAM_DB_PATH` first so
 * `getDatabasePath()` resolves to the tempdir without dragging in Electron.
 * Returns the better-sqlite3 handle for direct row-level seeding when needed.
 *
 * ⚠ If this throws `NODE_MODULE_VERSION ...` you're invoking Vitest under
 * host Node. Use `npm test`, which runs Vitest under Electron's bundled
 * Node — the runtime the `better-sqlite3` binding is compiled for. See the
 * comment on `openDatabase` in `src/main/db.js`.
 */
export async function openTestDatabase(dbPath) {
  process.env.VAM_DB_PATH = dbPath
  const db = await import('../../src/main/db.js')
  db.setDatabasePathOverride(dbPath)
  return db.openDatabase()
}
