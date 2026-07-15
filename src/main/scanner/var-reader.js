import yauzl from 'yauzl'
import JSON5 from 'json5'
import { classifyContents } from './classifier.js'

const SCENE_ATOM_ID_TYPES = new Set(['scene', 'legacyScene', 'legacyLook'])

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) reject(err)
      else resolve(zipfile)
    })
  })
}

function readStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err)
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  })
}

/**
 * Read a .var file's central directory and meta.json.
 * Returns { meta, fileList, contentItems?, extracts? } where meta is parsed JSON (or null),
 * fileList is [{ path, size }].
 * When `options.extractSceneJsons` is true, also classifies contents, reads scene/legacyLook JSON
 * bodies in the same ZIP pass, and returns `contentItems` plus `extracts` (Map path → Buffer).
 */
export async function readVar(varPath, options = {}) {
  const extractSceneJsons = options.extractSceneJsons === true
  const zipfile = await openZip(varPath)

  // Iterate all entries in the central directory
  const entries = await new Promise((resolve, reject) => {
    const list = []
    zipfile.readEntry()
    zipfile.on('entry', (entry) => {
      list.push(entry)
      zipfile.readEntry()
    })
    zipfile.on('end', () => resolve(list))
    zipfile.on('error', reject)
  })

  const fileList = entries
    .filter((e) => !e.fileName.endsWith('/')) // skip directories
    .map((e) => ({ path: e.fileName, size: e.uncompressedSize }))

  // Read meta.json if present
  const metaEntry = entries.find((e) => e.fileName === 'meta.json')
  let meta = null
  if (metaEntry) {
    try {
      const buf = await readStream(zipfile, metaEntry)
      meta = JSON5.parse(buf.toString('utf-8'))
    } catch {
      // VaM's SimpleJSON tolerates trailing commas and other non-standard JSON;
      // many community .var packages have them, so JSON5 is required here.
      // Corrupt or unreadable meta.json — skip.
    }
  }

  let contentItems = null
  /** @type {Map<string, Buffer>} */
  let extracts = new Map()
  if (extractSceneJsons) {
    contentItems = classifyContents(fileList)
    const paths = [...new Set(contentItems.filter((c) => SCENE_ATOM_ID_TYPES.has(c.type)).map((c) => c.internalPath))]
    for (const p of paths) {
      const entry = entries.find((e) => e.fileName === p)
      if (!entry) continue
      try {
        extracts.set(p, await readStream(zipfile, entry))
      } catch {
        // Missing or corrupt entry — omit from extracts; ingest stores [] for atom ids.
      }
    }
  }

  zipfile.close()

  return {
    meta,
    fileList,
    contentItems,
    extracts,
  }
}

/**
 * Extract a single file from a .var ZIP by path. Returns Buffer or null.
 */
export async function extractFile(varPath, internalPath) {
  const results = await extractFiles(varPath, [internalPath])
  return results.get(internalPath) || null
}

/**
 * Extract multiple files from a .var ZIP in a single pass.
 * @param {string} varPath
 * @param {string[]} internalPaths
 * @returns {Promise<Map<string, Buffer>>} path → buffer (only found entries)
 */
export async function extractFiles(varPath, internalPaths) {
  const wanted = new Set(internalPaths)
  const results = new Map()
  if (wanted.size === 0) return results

  const zipfile = await openZip(varPath)
  return new Promise((resolve, reject) => {
    zipfile.readEntry()
    zipfile.on('entry', async (entry) => {
      if (wanted.has(entry.fileName)) {
        try {
          const buf = await readStream(zipfile, entry)
          results.set(entry.fileName, buf)
          wanted.delete(entry.fileName)
          if (wanted.size === 0) {
            zipfile.close()
            return resolve(results)
          }
        } catch (err) {
          zipfile.close()
          return reject(err)
        }
      }
      zipfile.readEntry()
    })
    zipfile.on('end', () => {
      zipfile.close()
      resolve(results)
    })
    zipfile.on('error', (err) => {
      zipfile.close()
      reject(err)
    })
  })
}

// Bare `.var` plus VaM's marker/legacy `.var.disabled` sibling.
const VAR_EXT_RE = /\.var(\.disabled)?$/i

/**
 * Return the canonical bare `.var` filename for any on-disk disable encoding:
 *  - VaM marker / legacy suffix: "Foo.Bar.1.var.disabled" → "Foo.Bar.1.var"
 *  - Qvaro rename:               "Foo.Bar.1.DISABLED"     → "Foo.Bar.1.var"
 * Both end in a trailing `.disabled` (case-insensitive); the Qvaro rename simply
 * drops the `.var` before it. Anything else is returned unchanged.
 */
export function canonicalVarFilename(name) {
  return name.replace(/(?:\.var)?\.disabled$/i, '.var')
}

/**
 * On-disk Qvaro name for a canonical `.var`: "Foo.Bar.1.var" → "Foo.Bar.1.DISABLED".
 * Only the trailing `.var` is swapped, so this is safe to apply to a full path.
 */
export function qvaroDisabledName(canonical) {
  return canonical.replace(/\.var$/i, '.DISABLED')
}

/**
 * True for filenames ending in `.var`, `.var.disabled`, or a Qvaro `.DISABLED`
 * rename. The `.var`/`.var.disabled` forms stay a loose extension gate (the real
 * validator is `parseVarFilename`); a bare `.DISABLED` is only accepted when it
 * parses as a real var, so unrelated `*.DISABLED` files aren't treated as packages.
 */
export function isVarFilename(name) {
  if (VAR_EXT_RE.test(name)) return true
  if (/\.disabled$/i.test(name)) return parseVarFilename(name) != null
  return false
}

/**
 * Parse a .var (or `.var.disabled` / Qvaro `.DISABLED`) filename into
 * { creator, packageName, version } or null. On-disk versions are always purely
 * numeric — dep-ref conventions like `.latest` and `.minN` are intentionally
 * rejected here so they can never become package rows.
 * Input: "AcidBubbles.Timeline.249.var" / ".var.disabled" / "AcidBubbles.Timeline.249.DISABLED"
 */
export function parseVarFilename(filename) {
  const stem = canonicalVarFilename(filename).replace(/\.var$/i, '')
  const parts = stem.split('.')
  if (parts.length < 3) return null
  const version = parts[parts.length - 1]
  if (!/^\d+$/.test(version)) return null
  return { creator: parts[0], packageName: parts.slice(0, -1).join('.'), version }
}
