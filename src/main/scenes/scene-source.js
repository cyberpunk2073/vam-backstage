/**
 * Reads a scene (or legacy appearance) JSON and (optionally) its sibling .jpg
 * thumbnail from either a .var package or from disk (legacy/local files).
 * Legacy appearance JSONs share the same on-disk shape as a scene with a
 * single Person atom, so they flow through this reader unchanged.
 *
 * TODO(db-caching): cache a per-scene summary during scan (person atom ids,
 * presence of a sibling `.jpg` thumbnail) so the extract probe doesn't have
 * to re-open the zip and re-parse the scene JSON every time the menu opens.
 * The actual scene JSON and thumbnail bytes are still read on demand at
 * extract time — only the summary would be cached. Hook into
 * src/main/scanner/classifier.js when we're ready.
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import JSON5 from 'json5'
import { ADDON_PACKAGES } from '../../shared/paths.js'
import { extractFiles } from '../scanner/var-reader.js'
import { getPackageIndex } from '../store.js'

function resolveVarPath(addonDir, filename) {
  const pkg = getPackageIndex().get(filename)
  return join(addonDir, !pkg || pkg.is_enabled ? filename : filename + '.disabled')
}

function thumbPathFor(internalPath) {
  return internalPath.replace(/\.json$/i, '.jpg')
}

/**
 * Parse a scene JSON string. Native `JSON.parse` is ~10x faster than `JSON5.parse`,
 * so try it first; fall back to JSON5 for SimpleJSON tolerance (trailing commas etc).
 */
function parseSceneJson(s) {
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

  if (packageFilename) {
    const addonDir = join(vamDir, ADDON_PACKAGES)
    const varPath = resolveVarPath(addonDir, packageFilename)
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
