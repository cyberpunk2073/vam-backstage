import { stat } from 'fs/promises'
import { basename } from 'path'
import { readVar, parseVarFilename, canonicalVarFilename } from './var-reader.js'
import { classifyContents, derivePackageType } from './classifier.js'
import { extractDepRefs } from './graph.js'
import { upsertPackage, insertContents, deleteContentsForPackage } from '../db.js'

/**
 * Read a .var file, classify its contents, and upsert the package + contents into the DB.
 * @param {string} fullPath - absolute path to the .var file on disk
 * @param {object} [opts]
 * @param {boolean} [opts.isEnabled=true]
 * @param {number}  [opts.isDirect=0] - 0 or 1
 * @param {string}  [opts.typeOverride] - if set, used instead of derived type
 * @returns {Promise<{ filename, contentItems, meta, size } | null>} null if filename unparseable
 */
export async function scanAndUpsert(fullPath, { isEnabled = true, isDirect = 0, typeOverride } = {}) {
  const filename = canonicalVarFilename(basename(fullPath))
  const s = await stat(fullPath)
  const { meta, fileList } = await readVar(fullPath)
  const parsed = parseVarFilename(filename)
  if (!parsed) return null

  const contentItems = classifyContents(fileList)
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
    isEnabled: isEnabled ? 1 : 0,
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
      })),
    )
  }

  return { filename, contentItems, meta, size: s.size }
}
