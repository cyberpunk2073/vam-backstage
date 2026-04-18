import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { crc32 } from 'zlib'
import yauzl from 'yauzl'
import { ADDON_PACKAGES } from '../../shared/paths.js'
import { isVarFilename, canonicalVarFilename } from './var-reader.js'

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
 * Walk AddonPackages for all .var files and verify each one.
 * @param {string} vamDir
 * @param {(progress: { step: number, total: number, filename: string, status: string }) => void} onProgress
 * @returns {Promise<{ checked: number, corrupted: number, corruptedFiles: string[] }>}
 */
export async function runIntegrityCheck(vamDir, onProgress = () => {}) {
  const addonDir = join(vamDir, ADDON_PACKAGES)
  const varFiles = await walkForVars(addonDir)
  const corruptedFiles = []

  for (let i = 0; i < varFiles.length; i++) {
    const { filename, fullPath } = varFiles[i]
    onProgress({ step: i + 1, total: varFiles.length, filename, status: 'checking' })
    try {
      await verifyPackageFull(fullPath)
    } catch (err) {
      corruptedFiles.push(filename)
      console.warn(`Integrity check failed for ${filename}: ${err.message}`)
    }
  }

  onProgress({
    step: varFiles.length,
    total: varFiles.length,
    filename: '',
    status: 'done',
  })

  return { checked: varFiles.length, corrupted: corruptedFiles.length, corruptedFiles }
}

async function walkForVars(dir) {
  const results = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const localFiles = new Map()
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...(await walkForVars(fullPath)))
      } else if (entry.isFile() && isVarFilename(entry.name)) {
        const isDisabled = /\.disabled$/i.test(entry.name)
        const canonical = isDisabled ? canonicalVarFilename(entry.name) : entry.name
        const existing = localFiles.get(canonical)
        if (existing && !existing.isDisabled) continue
        localFiles.set(canonical, { fullPath, isDisabled })
      }
    }
    for (const [canonical, { fullPath }] of localFiles) {
      try {
        await stat(fullPath)
        results.push({ filename: canonical, fullPath })
      } catch {}
    }
  } catch {}
  return results
}
