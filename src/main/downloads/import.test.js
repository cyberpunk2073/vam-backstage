import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile, access, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkTempVamDir, buildVar, placeVar, openTestDatabase } from '../../../test/fixtures/index.js'
import { closeDatabase, getAllPackages, setSetting } from '../db.js'
import { runScan } from '../scanner/index.js'
import { buildFromDb, findLocalByFilename } from '../store.js'
import {
  importPrecheck,
  importChunk,
  importCommit,
  importAbort,
  cleanupOwner,
  importLocalFromPath,
  __resetImportStateForTests,
} from './import.js'

let tmp
const OWNER = 'test-owner'

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
  setSetting('vam_dir', tmp.vamDir)
  buildFromDb()
  await __resetImportStateForTests()
})

afterEach(async () => {
  await __resetImportStateForTests()
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

async function uploadBuffer(filename, buf, owner = OWNER, { chunkSize = 64 } = {}) {
  const uploadId = randomUUID()
  const promises = []
  for (let off = 0; off < buf.length; off += chunkSize) {
    const end = Math.min(off + chunkSize, buf.length)
    const bytes = buf.subarray(off, end)
    promises.push(
      importChunk(
        {
          uploadId,
          filename,
          bytes,
          first: off === 0,
          last: end >= buf.length,
        },
        owner,
      ),
    )
  }
  await Promise.all(promises)
  return importCommit(owner)
}

describe('importPrecheck', () => {
  it('reports an already-installed package', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Pre.Check', creator: 'Pre' },
      files: { 'Saves/scene/X.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Pre.Check.1.var', buf)
    await runScan(tmp.vamDir)
    buildFromDb()

    const res = importPrecheck({ filenames: ['Pre.Check.1.var', 'New.Pkg.1.var', 'bad'] })
    expect(res.existing).toContain('Pre.Check.1.var')
    expect(res.existing).not.toContain('New.Pkg.1.var')
    expect(res.invalid.map((f) => f.filename)).toContain('bad')
    expect(res.invalid[0].error).toBeTruthy()
  })
})

describe('importChunk + importCommit', () => {
  it('lands a chunked upload in the library with identical bytes', async () => {
    const filename = 'Chunk.Up.1.var'
    const buf = await buildVar({
      meta: { packageName: 'Chunk.Up', creator: 'Chunk' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })

    const result = await uploadBuffer(filename, buf, OWNER, { chunkSize: 100 })
    expect(result.added).toContain(filename)
    expect(result.failed).toHaveLength(0)

    const onDisk = await readFile(join(tmp.addonPackages, filename))
    expect(Buffer.compare(onDisk, buf)).toBe(0)
    expect(findLocalByFilename(filename)).toBeTruthy()
    expect(getAllPackages().some((r) => r.filename === filename)).toBe(true)
  })

  it('preserves byte order when chunk handlers run without awaiting (pipelined)', async () => {
    const filename = 'Pipe.Line.1.var'
    // Build a buffer large enough to span several small chunks with distinct bytes.
    const meta = { packageName: 'Pipe.Line', creator: 'Pipe' }
    const payload = Buffer.alloc(4096)
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
    const buf = await buildVar({
      meta,
      files: { 'Custom/Atoms/Pipe/data.bin': payload },
    })

    const uploadId = randomUUID()
    const chunkSize = 257
    const pending = []
    // Invoke in send order without awaiting — mirrors concurrent ws message handlers.
    for (let off = 0; off < buf.length; off += chunkSize) {
      const end = Math.min(off + chunkSize, buf.length)
      pending.push(
        importChunk(
          {
            uploadId,
            filename,
            bytes: buf.subarray(off, end),
            first: off === 0,
            last: end >= buf.length,
          },
          OWNER,
        ),
      )
    }
    await Promise.all(pending)
    const result = await importCommit(OWNER)
    expect(result.failed).toHaveLength(0)
    expect(result.added).toContain(filename)

    const onDisk = await readFile(join(tmp.addonPackages, filename))
    expect(Buffer.compare(onDisk, buf)).toBe(0)
  })

  it('commit aggregate includes a failed entry for a corrupt payload', async () => {
    const filename = 'Bad.Zip.1.var'
    const uploadId = randomUUID()
    const garbage = Buffer.alloc(2048, 0xff)
    await importChunk({ uploadId, filename, bytes: garbage, first: true, last: true }, OWNER)
    const result = await importCommit(OWNER)
    expect(result.added).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].filename).toBe(filename)
    expect(result.failed[0].error).toMatch(/not a valid \.var/i)

    await expect(access(join(tmp.addonPackages, filename))).rejects.toBeDefined()
    await expect(access(join(tmp.addonPackages, filename + '.import.tmp'))).rejects.toBeDefined()
  })
})

async function waitForPath(path, ms = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  await access(path)
}

describe('importAbort and cleanupOwner', () => {
  it('abort removes the temp file', async () => {
    const filename = 'Abort.Me.1.var'
    const uploadId = randomUUID()
    const buf = await buildVar({
      meta: { packageName: 'Abort.Me', creator: 'Abort' },
      files: { 'Saves/scene/X.json': '{}' },
    })
    await importChunk({ uploadId, filename, bytes: buf.subarray(0, 100), first: true, last: false }, OWNER)
    const tempPath = join(tmp.addonPackages, filename + '.import.tmp')
    await waitForPath(tempPath)

    await importAbort({}, OWNER)
    await expect(access(tempPath)).rejects.toBeDefined()
  })

  it('socket-close cleanup removes the temp file', async () => {
    const filename = 'Close.Me.1.var'
    const uploadId = randomUUID()
    const buf = await buildVar({
      meta: { packageName: 'Close.Me', creator: 'Close' },
      files: { 'Saves/scene/X.json': '{}' },
    })
    await importChunk({ uploadId, filename, bytes: buf.subarray(0, 100), first: true, last: false }, OWNER)
    const tempPath = join(tmp.addonPackages, filename + '.import.tmp')
    await waitForPath(tempPath)

    await cleanupOwner(OWNER)
    await expect(access(tempPath)).rejects.toBeDefined()
  })
})

describe('importLocalFromPath', () => {
  it('copies a local file into the batch and commit installs it', async () => {
    const filename = 'Local.Copy.1.var'
    const buf = await buildVar({
      meta: { packageName: 'Local.Copy', creator: 'Local' },
      files: { 'Saves/scene/X.json': '{"atoms":[]}' },
    })
    const srcDir = join(tmp.vamDir, 'drop-src')
    await mkdir(srcDir, { recursive: true })
    const sourcePath = join(srcDir, filename)
    await writeFile(sourcePath, buf)

    const res = await importLocalFromPath({ filename, sourcePath, move: false }, OWNER)
    expect(res.ok).toBe(true)

    const result = await importCommit(OWNER)
    expect(result.added).toContain(filename)
    const onDisk = await readFile(join(tmp.addonPackages, filename))
    expect(Buffer.compare(onDisk, buf)).toBe(0)
  })

  it('still rebuilds the library when the batch is finalized mid-copy', async () => {
    const filename = 'Late.Copy.1.var'
    const buf = await buildVar({
      meta: { packageName: 'Late.Copy', creator: 'Late' },
      files: { 'Saves/scene/X.json': '{"atoms":[]}' },
    })
    const srcDir = join(tmp.vamDir, 'drop-src')
    await mkdir(srcDir, { recursive: true })
    const sourcePath = join(srcDir, filename)
    await writeFile(sourcePath, buf)

    // Idle auto-commit / client disconnect can finalize the batch while a slow
    // copy is still running; the late entry must trigger its own graph phase.
    const copying = importLocalFromPath({ filename, sourcePath, move: false }, OWNER)
    const result = await importCommit(OWNER)
    expect(result.added).toHaveLength(0)

    expect((await copying).ok).toBe(true)
    expect(findLocalByFilename(filename)).toBeTruthy()
  })
})
