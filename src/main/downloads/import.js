/**
 * Drag-and-drop .var import: local path copy/move and streamed chunk upload.
 *
 * Batch protocol (used by both local and remote drops):
 *   precheck → chunk* (windowed) / importLocalFromPath* → commit (or abort)
 *
 * Chunks for a single file never interleave with another file's bytes on the
 * wire from one client, but several chunks may be in flight. The handler writes
 * to the session stream synchronously before any await so send-order is
 * preserved. On `last`, the file is closed and enqueued onto a serial
 * integration chain (verify → rename → scan). Commit drains that chain and
 * runs one whole-library graph rebuild + notify for the batch.
 */

import { createWriteStream, constants as fsConstants, mkdirSync } from 'fs'
import { rename, unlink, mkdir, copyFile } from 'fs/promises'
import { join, dirname } from 'path'
import { verifyZipFile } from '../var-stability.js'
import { parseVarFilename, canonicalVarFilename } from '../scanner/var-reader.js'
import { getSetting } from '../db.js'
import { findLocalByFilename } from '../store.js'
import { recordOwnedPath, withBulkWindow } from '../watcher.js'
import { getMainLibraryDirPath } from '../library-dirs.js'
import { integrateScannedPackage, integrateGraphPhase } from './manager.js'

const BATCH_IDLE_MS = 30_000

/** @type {Map<any, Batch>} owner ('local' | ws) → batch */
const batches = new Map()

/** Serialize graph-phase commits across owners so two batches don't rebuild concurrently. */
let commitChain = Promise.resolve()

/**
 * @typedef {{
 *   owner: any,
 *   entries: object[],
 *   results: { added: string[], already: string[], failed: { filename: string, error: string }[] },
 *   chain: Promise<void>,
 *   sessions: Map<string, Session>,
 *   timer: ReturnType<typeof setTimeout> | null,
 * }} Batch
 *
 * @typedef {{
 *   uploadId: string,
 *   canonical: string,
 *   tempPath: string,
 *   finalPath: string,
 *   stream: import('fs').WriteStream,
 *   bytesWritten: number,
 *   error: Error | null,
 * }} Session
 */

/** Resolve + validate the import target, returning the addon dir and canonical .var name. */
function resolveImportTarget(filename) {
  if (!getSetting('vam_dir')) throw new Error('VaM directory not configured')
  const addonDir = getMainLibraryDirPath()
  if (!addonDir) throw new Error('Main library directory not configured')

  const canonical = canonicalVarFilename(String(filename || '').trim())
  if (!/\.var$/i.test(canonical) || !parseVarFilename(canonical)) {
    throw new Error(`Not a valid .var filename: ${filename}`)
  }
  return { addonDir, canonical }
}

/** Coerce a Buffer/Uint8Array/array-like into a Buffer over its own byte window. */
function toBuffer(bytes) {
  return Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Buffer.from(bytes)
}

/**
 * Await WriteStream backpressure without leaking the unused drain/error listener.
 * `once('drain')` + `once('error')` leaves the other hanging when one fires.
 */
function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off('error', onError)
      resolve()
    }
    const onError = (err) => {
      stream.off('drain', onDrain)
      reject(err)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    stream.on('error', onError)
    stream.end(() => {
      stream.off('error', onError)
      resolve()
    })
  })
}

/** Best-effort unlink for temp/staging paths that may already be gone. */
async function rmQuiet(path) {
  try {
    await unlink(path)
  } catch {}
}

/** Atomically move a verified .var into place, recording it as app-owned so the watcher stays quiet. */
async function installStagedVar(stagedPath, finalPath) {
  await withBulkWindow(async () => {
    recordOwnedPath(finalPath)
    await rename(stagedPath, finalPath)
  })
}

function emptyResults() {
  return { added: [], already: [], failed: [] }
}

function snapshotResults(batch) {
  return {
    added: batch.results.added.slice(),
    already: batch.results.already.slice(),
    failed: batch.results.failed.slice(),
  }
}

/** Record a per-file scan outcome on the batch (graph phase still waits for commit). */
async function scanIntoBatch(batch, canonical, finalPath) {
  const entry = await integrateScannedPackage({
    filename: canonical,
    fullPath: finalPath,
    isDirect: true,
    hubResourceId: null,
  })
  if (!entry) {
    batch.results.failed.push({ filename: canonical, error: 'Scan failed' })
    return false
  }
  batch.entries.push(entry)
  batch.results.added.push(canonical)
  // A long copy can outlive its batch (idle auto-commit, client disconnect).
  // Nothing will pick the entry up at commit, so rebuild for it now — the
  // package is already on disk and in the DB, and a stale graph is worse than
  // a missing "Added" toast.
  if (batches.get(batch.owner) !== batch) await enqueueGraphPhase([entry])
  return true
}

function ensureBatch(owner) {
  let batch = batches.get(owner)
  if (!batch) {
    batch = {
      owner,
      entries: [],
      results: emptyResults(),
      chain: Promise.resolve(),
      sessions: new Map(),
      timer: null,
    }
    batches.set(owner, batch)
  }
  touchBatchTimer(owner, batch)
  return batch
}

function touchBatchTimer(owner, batch) {
  clearBatchTimer(batch)
  batch.timer = setTimeout(() => {
    batch.timer = null
    void importCommit(owner).catch((err) => {
      console.warn('[import] idle auto-commit failed:', err?.message || err)
    })
  }, BATCH_IDLE_MS)
  // Allow the process to exit if only the idle timer remains (tests / shutdown).
  if (typeof batch.timer.unref === 'function') batch.timer.unref()
}

function clearBatchTimer(batch) {
  if (batch.timer) {
    clearTimeout(batch.timer)
    batch.timer = null
  }
}

/** True if any open session (any owner) is staging this canonical name. */
function hasOpenSessionForCanonical(canonical) {
  for (const batch of batches.values()) {
    for (const session of batch.sessions.values()) {
      if (session.canonical === canonical) return true
    }
  }
  return false
}

async function destroySession(session) {
  try {
    session.stream.destroy()
  } catch {}
  await rmQuiet(session.tempPath)
}

/**
 * Queue graph work on the cross-owner chain. The trailing catch keeps
 * `commitChain` settled — a rejection left on it would strand every later
 * commit — so `integrateGraphPhase` throwing only costs one batch its rebuild.
 */
function enqueueGraphPhase(entries) {
  if (!entries.length) return
  commitChain = commitChain
    .then(() => integrateGraphPhase(entries, { autoQueueDeps: false }))
    .catch((err) => {
      console.warn('[import] graph phase failed:', err?.message || err)
    })
  return commitChain
}

/**
 * Verify + rename + scan one completed upload. Records into batch.results.
 * Does not run the graph phase — that waits for commit.
 */
async function integrateOne(batch, session) {
  const { canonical, tempPath, finalPath, bytesWritten } = session
  try {
    if (bytesWritten === 0) throw new Error('Empty file')
    try {
      await verifyZipFile(tempPath)
    } catch (err) {
      throw new Error(`Not a valid .var package: ${err.message}`)
    }
    await installStagedVar(tempPath, finalPath)
    await scanIntoBatch(batch, canonical, finalPath)
  } catch (err) {
    batch.results.failed.push({ filename: canonical, error: err?.message || String(err) })
    // The rename consumes the temp on success, so this only bites on failure —
    // never leave a `.import.tmp` sitting in the library dir.
    await rmQuiet(tempPath)
  }
}

/**
 * Open a write session synchronously so a pipelined follow-up chunk can find it
 * and write without awaiting — the ordering invariant depends on `stream.write`
 * being the first thing that touches the stream, before any await in the handler.
 */
function openSession(batch, uploadId, filename) {
  if (!uploadId) throw new Error('uploadId required')
  if (batch.sessions.has(uploadId)) throw new Error('Duplicate uploadId')
  const { addonDir, canonical } = resolveImportTarget(filename)
  if (findLocalByFilename(canonical)) {
    // Precheck should have filtered these; throw without recording so a mid-batch
    // collision fails the upload rather than silently counting as "already".
    throw new Error(`Already installed: ${canonical}`)
  }
  if (hasOpenSessionForCanonical(canonical)) {
    throw new Error(`Import already in progress for ${canonical}`)
  }

  const finalPath = join(addonDir, canonical)
  const tempPath = finalPath + '.import.tmp'
  mkdirSync(dirname(finalPath), { recursive: true })

  const stream = createWriteStream(tempPath)
  const session = {
    uploadId,
    canonical,
    tempPath,
    finalPath,
    stream,
    bytesWritten: 0,
    error: null,
  }
  stream.on('error', (err) => (session.error = err))
  batch.sessions.set(uploadId, session)
  return session
}

/**
 * One-shot filename check before streaming. Replaces the per-file `already`
 * short-circuit that `begin` used to provide. `invalid` carries the reason so
 * the client can report it without sending any bytes — an unconfigured VaM
 * directory rejects every name, not just malformed ones.
 */
export function importPrecheck({ filenames }) {
  const existing = []
  const invalid = []
  for (const filename of filenames || []) {
    try {
      const { canonical } = resolveImportTarget(filename)
      if (findLocalByFilename(canonical)) existing.push(canonical)
    } catch (err) {
      invalid.push({ filename: String(filename || ''), error: err.message })
    }
  }
  return { existing, invalid }
}

/**
 * Stream one chunk of a .var upload. `first` opens the session; `last` closes
 * the stream and enqueues integration. Ack returns after drain so the client
 * window is real disk backpressure.
 */
export async function importChunk({ uploadId, filename, bytes, first, last }, owner) {
  const batch = ensureBatch(owner)
  const session = first ? openSession(batch, uploadId, filename) : batch.sessions.get(uploadId)
  if (!session) throw new Error('Unknown or expired import session')
  if (session.error) throw session.error

  // MUST be the first statement touching the stream, before any await: frames
  // arrive in send order on a single socket, so a synchronous write here is
  // what keeps the pieces in order while several chunks are in flight.
  const buf = toBuffer(bytes)
  const needsDrain = !session.stream.write(buf)
  session.bytesWritten += buf.byteLength

  if (needsDrain) await onceDrain(session.stream)
  if (session.error) throw session.error

  if (last) {
    await endStream(session.stream)
    if (session.error) throw session.error
    batch.sessions.delete(uploadId)
    batch.chain = batch.chain.then(() => integrateOne(batch, session))
  }
  return { ok: true, bytesWritten: session.bytesWritten }
}

/**
 * Finish a batch: destroy leftover sessions, drain the integration chain, run
 * one graph rebuild, return the aggregate. Shared by commit, full abort, and
 * socket-close cleanup.
 */
async function finalizeBatch(owner, { failOpenSessions = true } = {}) {
  const batch = batches.get(owner)
  if (!batch) return emptyResults()

  clearBatchTimer(batch)

  for (const [id, session] of [...batch.sessions]) {
    batch.sessions.delete(id)
    await destroySession(session)
    if (failOpenSessions) {
      batch.results.failed.push({ filename: session.canonical, error: 'Incomplete upload' })
    }
  }

  // Wait for in-flight integrateOne calls so entries/results are complete.
  try {
    await batch.chain
  } catch {}

  const entries = batch.entries.slice()
  const results = snapshotResults(batch)
  batches.delete(owner)

  await enqueueGraphPhase(entries)
  return results
}

/**
 * Drain the integration queue and run one graph rebuild + notify for the batch.
 */
export async function importCommit(owner) {
  return finalizeBatch(owner)
}

/**
 * Abort one session (`uploadId`) or the whole batch (omitted).
 * Full-batch abort returns the same aggregate shape as commit (packages already
 * scanned still get a graph rebuild so the library isn't left stale).
 */
export async function importAbort({ uploadId } = {}, owner) {
  const batch = batches.get(owner)
  if (!batch) return uploadId ? { ok: true } : emptyResults()

  if (uploadId) {
    const session = batch.sessions.get(uploadId)
    if (session) {
      batch.sessions.delete(uploadId)
      await destroySession(session)
    }
    return { ok: true }
  }

  // Drop open streams without counting them as failed — the client already has
  // the transfer error. Keep scanned entries and finish their graph phase.
  return finalizeBatch(owner, { failOpenSessions: false })
}

/**
 * Socket-close / owner cleanup: destroy open streams + temps, then run the
 * graph phase for anything already integrated so the library isn't left stale.
 */
export async function cleanupOwner(owner) {
  await finalizeBatch(owner, { failOpenSessions: false })
}

/**
 * Import a dragged-in .var that the main process can read directly by path —
 * the local (non-remote) fast path (no renderer/IPC byte streaming). Joins the
 * owner's batch: scan runs now, graph rebuild waits for commit.
 *
 * `move` removes the source once the package is safely in the library, taking
 * an instant same-disk shortcut when it can. The source is only ever touched
 * after it's verified, and only deleted after the import fully succeeds.
 */
export async function importLocalFromPath({ filename, sourcePath, move = false }, owner = 'local') {
  const batch = ensureBatch(owner)
  const { addonDir, canonical } = resolveImportTarget(filename)
  if (findLocalByFilename(canonical)) {
    batch.results.already.push(canonical)
    return { already: true, filename: canonical }
  }
  if (hasOpenSessionForCanonical(canonical)) {
    throw new Error(`Import already in progress for ${canonical}`)
  }

  const finalPath = join(addonDir, canonical)
  await mkdir(dirname(finalPath), { recursive: true })

  // Same-filesystem move: verify in place, then rename the source straight to
  // its final home. EXDEV (cross-device) falls through to the copy path below.
  if (move) {
    try {
      await verifyZipFile(sourcePath)
    } catch (err) {
      throw new Error(`Not a valid .var package: ${err.message}`)
    }
    let renamed = false
    try {
      await installStagedVar(sourcePath, finalPath)
      renamed = true
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err
    }
    if (renamed) {
      const ok = await scanIntoBatch(batch, canonical, finalPath)
      return { ok, filename: canonical }
    }
  }

  const tempPath = finalPath + '.import.tmp'
  try {
    await copyFile(sourcePath, tempPath, fsConstants.COPYFILE_FICLONE)
    try {
      await verifyZipFile(tempPath)
    } catch (err) {
      throw new Error(`Not a valid .var package: ${err.message}`)
    }
    await installStagedVar(tempPath, finalPath)
  } catch (err) {
    await rmQuiet(tempPath)
    throw err
  }

  const ok = await scanIntoBatch(batch, canonical, finalPath)
  // Scan outcome is recorded on the batch; commit reports failures. Only delete
  // the source after a successful scan when moving.
  if (ok && move) {
    try {
      await unlink(sourcePath)
    } catch (err) {
      console.warn(`Import succeeded but could not remove source ${sourcePath}:`, err.message)
    }
  }
  return { ok, filename: canonical }
}

/** Test helper: drop all batch state between cases. */
export async function __resetImportStateForTests() {
  for (const [owner, batch] of batches) {
    clearBatchTimer(batch)
    for (const session of batch.sessions.values()) await destroySession(session)
    batches.delete(owner)
  }
  commitChain = Promise.resolve()
}
