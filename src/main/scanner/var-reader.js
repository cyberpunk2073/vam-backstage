import yauzl from 'yauzl'
import JSON5 from 'json5'

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
 * Returns { meta, fileList } where meta is parsed JSON (or null)
 * and fileList is [{ path, size }].
 */
export async function readVar(varPath) {
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

  zipfile.close()

  return {
    meta,
    fileList: entries
      .filter((e) => !e.fileName.endsWith('/')) // skip directories
      .map((e) => ({ path: e.fileName, size: e.uncompressedSize })),
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

const VAR_EXT_RE = /\.var(\.disabled)?$/i

/**
 * Return the canonical .var filename (strip .disabled suffix if present).
 * "Foo.Bar.1.var.disabled" → "Foo.Bar.1.var"
 */
export function canonicalVarFilename(name) {
  return name.replace(/\.disabled$/i, '')
}

/**
 * True for filenames ending in .var or .var.disabled.
 */
export function isVarFilename(name) {
  return VAR_EXT_RE.test(name)
}

/**
 * Parse a .var (or .var.disabled) filename into { creator, packageName, version } or null.
 * Rejects dep-ref-only conventions (".latest", ".minN") — those are never valid on-disk versions.
 * Input: "AcidBubbles.Timeline.249.var" / "AcidBubbles.Timeline.249.var.disabled"
 */
export function parseVarFilename(filename) {
  const stem = filename.replace(VAR_EXT_RE, '')
  const parts = stem.split('.')
  if (parts.length < 3) return null
  const creator = parts[0]
  const version = parts[parts.length - 1]
  const lower = version.toLowerCase()
  if (lower === 'latest' || /^min\d+$/.test(lower)) return null
  const packageName = parts.slice(0, -1).join('.')
  return { creator, packageName, version }
}
