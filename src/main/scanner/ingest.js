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
 */
export function personAtomIdsJsonFromBuffer(buf, packageFilename = null) {
  if (!buf || buf.length === 0) return '[]'
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
    return '[]'
  }
}

/**
 * Read a .var file, classify its contents, and upsert the package + contents into the DB.
 * @param {string} fullPath - absolute path to the .var file on disk
 * @param {object} [opts]
 * @param {'enabled'|'disabled'|'offloaded'} [opts.storageState='enabled']
 * @param {number|null} [opts.libraryDirId=null] - NULL for main, aux dir id otherwise
 * @param {number}  [opts.isDirect=0] - 0 or 1
 * @param {string}  [opts.typeOverride] - if set, used instead of derived type
 * @returns {Promise<{ filename, contentItems, meta, size } | null>} null if filename unparseable
 */
export async function scanAndUpsert(
  fullPath,
  { storageState = 'enabled', libraryDirId = null, isDirect = 0, typeOverride } = {},
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
    depRefs: JSON.stringify(depRefs),
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

  return { filename, contentItems, meta, size: s.size }
}
