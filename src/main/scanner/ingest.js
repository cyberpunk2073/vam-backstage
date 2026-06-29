import { stat } from 'fs/promises'
import { basename } from 'path'
import { readVar, parseVarFilename, canonicalVarFilename } from './var-reader.js'
import { derivePackageType } from './classifier.js'
import { extractDepRefs } from './graph.js'
import { upsertPackage, insertContents, deleteContentsForPackage } from '../db.js'
import { parseSceneJson } from '../scenes/scene-source.js'
import { getPersonAtoms } from '../scenes/extractor.js'

export const PERSON_ATOM_ID_CONTENT_TYPES = new Set(['scene', 'legacyScene', 'legacyLook'])

/**
 * Parse a scene/legacy-look JSON buffer and return its Person atom ids as a
 * JSON-encoded string array (the storage shape used by `contents.person_atom_ids`).
 * If `packageFilename` is provided the buffer is treated as .var-sourced and
 * `SELF:/` references are rewritten to the package's stem; for loose files
 * (no package), the buffer is parsed as-is.
 *
 * Returns `null` when the buffer is missing/empty or fails to parse — this
 * distinguishes "we couldn't read this scene" from `'[]'` ("scene parsed,
 * no Person atoms"). The local scanner's stat-gate doesn't re-read on
 * unchanged files, so a permanently-broken scene won't be re-parsed; but a
 * partially-written scene that finishes later will trigger another read
 * (statMoved) and convert null → real ids. Probe consumers fall back to
 * reading the source on null (see scenes/extract.js).
 */
export function personAtomIdsJsonFromBuffer(buf, packageFilename = null) {
  if (!buf || buf.length === 0) return null
  try {
    let raw = buf.toString('utf-8')
    if (packageFilename) {
      const selfName = packageFilename.replace(/\.var$/i, '')
      raw = raw.split('SELF:/').join(selfName + ':/')
    }
    const sceneJson = parseSceneJson(raw)
    const atoms = getPersonAtoms(sceneJson)
    return JSON.stringify(atoms.map((a) => a.id))
  } catch {
    return null
  }
}

/**
 * Read a .var file, classify its contents, and upsert the package + contents into the DB.
 * @param {string} fullPath - absolute path to the .var file on disk
 * @param {object} [opts]
 * @param {'enabled'|'disabled'|'offloaded'} [opts.storageState='enabled']
 * @param {number|null} [opts.libraryDirId=null] - NULL for main, aux dir id otherwise
 * @param {string}  [opts.subpath=''] - POSIX relative dir within the library dir ('' = root)
 * @param {number}  [opts.isDirect=0] - 0 or 1
 * @param {string}  [opts.typeOverride] - if set, used instead of derived type
 * @param {number}  [opts.firstSeenAt] - unix seconds stamped as the row's discovery time on
 *   INSERT only (ignored on re-scan). Callers ingesting a batch pass one shared value so the
 *   whole run shares a `first_seen_at`; defaults to now for single-file ingests.
 * @returns {Promise<{ filename, contentItems, meta, size, pkgType, packageName } | null>} null if filename unparseable
 */
export async function scanAndUpsert(
  fullPath,
  { storageState = 'enabled', libraryDirId = null, subpath = '', isDirect = 0, typeOverride, firstSeenAt } = {},
) {
  const filename = canonicalVarFilename(basename(fullPath))
  const s = await stat(fullPath)
  const { meta, contentItems, extracts } = await readVar(fullPath, { extractSceneJsons: true })
  const parsed = parseVarFilename(filename)
  if (!parsed) return null

  const depRefs = meta ? extractDepRefs(meta, filename) : []
  const pkgType = typeOverride || derivePackageType(contentItems)

  upsertPackage({
    filename,
    creator: parsed.creator,
    packageName: parsed.packageName,
    version: parsed.version,
    type: pkgType,
    title: meta?.title || parsed.packageName.split('.').pop(),
    description: meta?.description?.trim() || null,
    license: meta?.licenseType || null,
    sizeBytes: s.size,
    fileMtime: s.mtimeMs / 1000,
    isDirect: isDirect ? 1 : 0,
    storageState,
    libraryDirId: libraryDirId == null ? null : libraryDirId,
    subpath: subpath || '',
    depRefs: JSON.stringify(depRefs),
    ...(firstSeenAt != null && { firstSeenAt }),
  })

  deleteContentsForPackage(filename)
  if (contentItems.length > 0) {
    insertContents(
      contentItems.map((item) => ({
        packageFilename: filename,
        internalPath: item.internalPath,
        displayName: item.displayName,
        type: item.type,
        thumbnailPath: item.thumbnailPath,
        personAtomIds: PERSON_ATOM_ID_CONTENT_TYPES.has(item.type)
          ? personAtomIdsJsonFromBuffer(extracts.get(item.internalPath), filename)
          : null,
      })),
    )
  }

  return { filename, contentItems, meta, size: s.size, pkgType, packageName: parsed.packageName }
}
