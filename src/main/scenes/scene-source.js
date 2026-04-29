/**
 * Reads a scene (or legacy appearance) JSON and (optionally) its sibling .jpg
 * thumbnail from either a .var package or from disk (legacy/local files).
 * Legacy appearance JSONs share the same on-disk shape as a scene with a
 * single Person atom, so they flow through this reader unchanged.
 *
 * Person atom ids for probe are cached in `contents.person_atom_ids` at scan time;
 * this reader is still used for extract-write and for probe fallback before the
 * first rescan after a DB upgrade.
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import JSON5 from 'json5'
import { isLocalPackage } from '@shared/local-package.js'
import { extractFiles } from '../scanner/var-reader.js'
import { getPackageIndex } from '../store.js'
import { pkgVarPath } from '../library-dirs.js'

function thumbPathFor(internalPath) {
  return internalPath.replace(/\.json$/i, '.jpg')
}

/**
 * Parse a scene JSON string. Native `JSON.parse` is ~10x faster than `JSON5.parse`,
 * so try it first; fall back to JSON5 for SimpleJSON tolerance (trailing commas etc).
 */
export function parseSceneJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return JSON5.parse(s)
  }
}

/**
 * Read a scene JSON + sibling thumbnail. When the scene lives in a .var, the
 * `SELF:/` prefix is rewritten to `<packageStem>:/` before parsing (single pass,
 * no re-serialize) for correct cross-ref resolution.
 *
 * @returns {Promise<{ sceneJson: object, thumbBuffer: Buffer|null }>}
 */
export async function readScene({ vamDir, packageFilename, internalPath }) {
  if (!vamDir) throw new Error('VaM directory not configured')
  if (!internalPath) throw new Error('internalPath required')

  const thumbPath = thumbPathFor(internalPath)

  if (packageFilename && !isLocalPackage(packageFilename)) {
    const pkg = getPackageIndex().get(packageFilename)
    const varPath = pkgVarPath(pkg)
    if (!varPath) throw new Error(`Package not found or library dir missing: ${packageFilename}`)
    const extracted = await extractFiles(varPath, [internalPath, thumbPath])
    const sceneBuf = extracted.get(internalPath)
    if (!sceneBuf) throw new Error(`Scene JSON not found in ${packageFilename}: ${internalPath}`)
    const selfName = packageFilename.replace(/\.var$/i, '')
    const raw = sceneBuf
      .toString('utf-8')
      .split('SELF:/')
      .join(selfName + ':/')
    const sceneJson = parseSceneJson(raw)
    const thumbBuffer = extracted.get(thumbPath) || null
    return { sceneJson, thumbBuffer }
  }

  const scenePath = join(vamDir, internalPath)
  const sceneBuf = await readFile(scenePath)
  const sceneJson = parseSceneJson(sceneBuf.toString('utf-8'))
  const thumbFull = join(vamDir, thumbPath)
  let thumbBuffer = null
  if (existsSync(thumbFull)) {
    try {
      thumbBuffer = await readFile(thumbFull)
    } catch {
      thumbBuffer = null
    }
  }
  return { sceneJson, thumbBuffer }
}
