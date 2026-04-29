import { stat } from 'fs/promises'
import { crc32 } from 'zlib'
import yauzl from 'yauzl'
import { pkgVarPath } from '../library-dirs.js'
import { getPackageIndex } from '../store.js'

/**
 * Full integrity verification of a .var ZIP archive.
 * Opens the ZIP, decompresses every entry, and checks CRC32 against the central directory.
 * @returns {{ ok: boolean, error?: string }}
 */
export async function verifyPackageFull(varPath) {
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(varPath, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err) reject(err)
      else resolve(zf)
    })
  })

  try {
    await new Promise((resolve, reject) => {
      zipfile.readEntry()
      zipfile.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry()
          return
        }
        zipfile.openReadStream(entry, (err, stream) => {
          if (err) return reject(new Error(`Failed to read ${entry.fileName}: ${err.message}`))
          const chunks = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('error', (err) => reject(new Error(`Decompress error in ${entry.fileName}: ${err.message}`)))
          stream.on('end', () => {
            const buf = Buffer.concat(chunks)
            const actual = crc32(buf)
            if (actual !== entry.crc32) {
              return reject(
                new Error(`CRC32 mismatch in ${entry.fileName}: expected ${entry.crc32 >>> 0}, got ${actual >>> 0}`),
              )
            }
            zipfile.readEntry()
          })
        })
      })
      zipfile.on('end', () => resolve())
      zipfile.on('error', (err) => reject(err))
    })
  } finally {
    zipfile.close()
  }

  return { ok: true }
}

/**
 * Verify every indexed package, in whatever library dir it currently lives.
 * Iterates the in-memory package index rather than re-walking the filesystem,
 * so the scanner's collision/state policy is the single source of truth for
 * "which physical file represents this canonical filename".
 *
 * @param {string} _vamDir unused (kept for backward-compatible IPC signature)
 * @param {(progress: { step: number, total: number, filename: string, status: string }) => void} onProgress
 * @returns {Promise<{ checked: number, corrupted: number, corruptedFiles: string[] }>}
 */
export async function runIntegrityCheck(_vamDir, onProgress = () => {}) {
  const targets = []
  for (const pkg of getPackageIndex().values()) {
    const fullPath = pkgVarPath(pkg)
    if (!fullPath) continue
    try {
      await stat(fullPath)
      targets.push({ filename: pkg.filename, fullPath })
    } catch {}
  }

  const corruptedFiles = []
  for (let i = 0; i < targets.length; i++) {
    const { filename, fullPath } = targets[i]
    onProgress({ step: i + 1, total: targets.length, filename, status: 'checking' })
    try {
      await verifyPackageFull(fullPath)
    } catch (err) {
      corruptedFiles.push(filename)
      console.warn(`Integrity check failed for ${filename}: ${err.message}`)
    }
  }

  onProgress({ step: targets.length, total: targets.length, filename: '', status: 'done' })
  return { checked: targets.length, corrupted: corruptedFiles.length, corruptedFiles }
}
