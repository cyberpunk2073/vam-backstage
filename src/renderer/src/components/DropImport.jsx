import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PackagePlus, Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/Toast'
import { formatBytes } from '@/lib/utils'
import { CLARIFY } from '@/lib/typography'

// A package filename ends in `.var`. `.var.disabled` is deliberately excluded —
// that's a VaM/library on-disk state, not something a user should import. A
// stray trailing `.zip` is handled separately in `targetVarName`.
const VAR_NAME_RE = /\.var$/i

function isVarName(name) {
  return VAR_NAME_RE.test(name)
}

/**
 * Resolve a dropped file's name to the `.var` filename it should be imported as,
 * or null if it isn't a package. Accepts a plain `.var`, and also a `.var.zip`:
 * a `.var` IS a zip, and download/extract tools routinely append `.zip`, so we
 * strip that back off (VaM can't load a `.var.zip` as-is). The main-process
 * import re-verifies the zip and reads meta.json, so a non-package that happens
 * to be named this way still fails safely.
 */
function targetVarName(rawName) {
  if (isVarName(rawName)) return rawName
  const stripped = rawName.replace(/\.zip$/i, '')
  if (stripped !== rawName && isVarName(stripped)) return stripped
  return null
}

/**
 * Mirror of the main process's `parseVarFilename`: a real package filename is
 * `Creator.Package.Version.var` with a purely numeric version segment. Reject
 * anything else client-side so the user gets an explanation up front rather than
 * a post-import failure toast.
 */
function hasValidVarName(name) {
  const stem = name.replace(VAR_NAME_RE, '')
  const parts = stem.split('.')
  if (parts.length < 3) return false
  return /^\d+$/.test(parts[parts.length - 1])
}

// Chunk size for streaming a .var to the (possibly remote) main process.
// Smaller than the old 32 MiB stop-and-wait size: base64 inflates ~33% on the
// wire, and large frames stall the host main process on JSON.parse. Pipelining
// (MAX_INFLIGHT_CHUNKS) keeps the network saturated without huge allocations.
const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_INFLIGHT_CHUNKS = 4

/**
 * Stream many files as one flat windowed chunk loop. Never stops at file
 * boundaries — only the unacked-chunk window blocks. Each frame is still a
 * single file's bytes (`first`/`last` mark boundaries). Errors are captured
 * so `Promise.race` on the inflight set never rejects mid-wait.
 */
async function streamImportBatch(items, onProgress) {
  const inflight = new Set()
  let firstError = null
  let acked = 0

  async function push(frame) {
    while (inflight.size >= MAX_INFLIGHT_CHUNKS) await Promise.race(inflight)
    if (firstError) throw firstError
    // The promise resolves either way — a rejecting member would make
    // Promise.race throw and would surface as an unhandled rejection.
    const p = window.api.packages
      .importLocalChunk(frame)
      .then(
        () => {
          acked += frame.bytes.byteLength
          onProgress?.(acked)
        },
        (err) => {
          firstError ??= err
        },
      )
      .finally(() => inflight.delete(p))
    inflight.add(p)
  }

  for (const { uploadId, name, file } of items) {
    // Zero-byte files need one first+last frame; a `< size` loop would skip them
    // entirely and they'd vanish from the batch with no error.
    if (file.size === 0) {
      await push({ uploadId, filename: name, bytes: new Uint8Array(0), first: true, last: true })
      continue
    }
    for (let off = 0; off < file.size; off += IMPORT_CHUNK_BYTES) {
      const end = Math.min(off + IMPORT_CHUNK_BYTES, file.size)
      const bytes = new Uint8Array(await file.slice(off, end).arrayBuffer())
      await push({
        uploadId,
        filename: name,
        bytes,
        first: off === 0,
        last: end >= file.size,
      })
    }
  }
  await Promise.all(inflight)
  if (firstError) throw firstError
}

/** True when a drag payload carries OS files (not an internal element drag). */
function dragHasFiles(e) {
  const types = e.dataTransfer?.types
  if (!types) return false
  return Array.from(types).includes('Files')
}

function fileFromEntry(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)))
}

/** readEntries returns at most ~100 entries per call, so drain it in a loop. */
async function readAllDirEntries(reader) {
  const out = []
  while (true) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
    if (!batch.length) break
    out.push(...batch)
  }
  return out
}

/** Recursively collect File objects from a dropped file/directory entry. */
async function walkEntry(entry, out) {
  if (!entry) return
  if (entry.isFile) {
    const f = await fileFromEntry(entry)
    if (f) out.push(f)
  } else if (entry.isDirectory) {
    const children = await readAllDirEntries(entry.createReader())
    for (const child of children) await walkEntry(child, out)
  }
}

/**
 * Window-wide drag-and-drop target: dropping `.var` files (or folders that
 * contain them) anywhere on the app chrome offers to add them to the library.
 *
 * Protocol: precheck → stream/copy all files into one server-side batch →
 * commit (one graph rebuild + notify). Remote clients window up to four 4 MiB
 * chunks in flight so the wire stays saturated across file boundaries; local
 * drops with a resolvable path use `importLocalCopy` (can move) and still join
 * the same batch. Drops onto the Hub <webview> guest go to the page, not here.
 */
export default function DropImport() {
  const [dragging, setDragging] = useState(false)
  const [scanning, setScanning] = useState(false) // enumerating dropped folders
  const [pending, setPending] = useState(null) // { items, skipped, invalid, totalBytes, willMove }
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(null) // { acked, totalBytes, phase: 'transfer' | 'install' }
  // dragenter/dragleave fire per element as the cursor crosses children; a depth
  // counter keeps the overlay stable until the drag truly leaves the window.
  const depth = useRef(0)
  // The window listeners are registered once; a ref lets them see current busy
  // state without re-subscribing, so drops are ignored (and the overlay stays
  // hidden) while scanning, importing, or a confirm dialog is already open.
  const busyRef = useRef(false)
  busyRef.current = scanning || importing || !!pending

  const collect = useCallback(async (dirEntries, looseFiles) => {
    setScanning(true)
    try {
      const all = [...looseFiles]
      for (const entry of dirEntries) await walkEntry(entry, all)

      // Map each file to the .var name it would import as (null = not a package).
      const varItems = all.map((file) => ({ file, name: targetVarName(file.name) })).filter((m) => m.name)
      const skipped = all.length - varItems.length // non-.var files
      const valid = varItems.filter((m) => hasValidVarName(m.name))
      const invalid = varItems.filter((m) => !hasValidVarName(m.name)).map((m) => m.name)

      // Dedupe by canonical name — required now that the in-batch `already`
      // check is gone, and stops the confirm dialog listing the same package twice.
      const seen = new Set()
      const items = []
      for (const m of valid) {
        const key = m.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        items.push(m)
      }

      if (items.length === 0) {
        if (invalid.length > 0) {
          toast(`Not a valid package filename (expected Creator.Name.Version.var): ${invalid[0]}`, 'error')
        } else {
          toast(
            skipped > 0 ? 'No .var files in that drop — other files were ignored.' : 'No .var files in that drop.',
            'error',
          )
        }
        return
      }

      const totalBytes = items.reduce((sum, m) => sum + (m.file.size || 0), 0)
      // Move applies to the local fast path only — a remote client head has no
      // source file to remove and always streams a copy to the server.
      const willMove = !window.api.remote.isRemote && (await window.api.settings.get('import_move_files')) === '1'
      setPending({ items, skipped, invalid, totalBytes, willMove })
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    const onDragEnter = (e) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      if (!busyRef.current) setDragging(true)
    }
    const onDragOver = (e) => {
      if (!dragHasFiles(e)) return
      // Both preventDefault calls are required: without them Electron navigates
      // the window to the dropped file:// URL instead of firing our drop handler.
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e) => {
      if (!dragHasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDrop = (e) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      if (busyRef.current) return

      // Extract files/entries synchronously — the DataTransfer is only valid for
      // the duration of the event. Plain files are grabbed directly via
      // getAsFile() (reliable, gives the right name/size); only directories use
      // the async entry reader, whose recursion happens after the event.
      const dt = e.dataTransfer
      const items = dt.items ? Array.from(dt.items) : []
      const dirEntries = []
      const looseFiles = []
      if (items.length && typeof items[0]?.webkitGetAsEntry === 'function') {
        for (const it of items) {
          if (it.kind !== 'file') continue
          const entry = it.webkitGetAsEntry()
          if (entry?.isDirectory) {
            dirEntries.push(entry)
          } else {
            const f = it.getAsFile()
            if (f) looseFiles.push(f)
          }
        }
      } else {
        for (const f of Array.from(dt.files || [])) looseFiles.push(f)
      }

      void collect(dirEntries, looseFiles)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [collect])

  const runImport = useCallback(async () => {
    if (!pending) return
    const items = pending.items
    const move = pending.willMove
    setImporting(true)

    let added = 0
    const alreadySet = new Set()
    const failed = []
    let finished = false

    const mergeServerResults = (result) => {
      if (!result) return
      added += result.added?.length || 0
      for (const name of result.already || []) alreadySet.add(String(name).toLowerCase())
      for (const f of result.failed || []) {
        failed.push(`${f.filename}: ${f.error || 'failed'}`)
      }
    }

    try {
      const names = items.map((m) => m.name)
      const pre = await window.api.packages.importLocalPrecheck(names)
      for (const name of pre?.existing || []) alreadySet.add(String(name).toLowerCase())
      // Names the server rejects outright (unconfigured VaM dir, a validity rule
      // the client mirror missed). Report them now rather than sending the bytes
      // and failing on the first chunk.
      const rejected = new Set()
      for (const f of pre?.invalid || []) {
        rejected.add(String(f.filename).toLowerCase())
        failed.push(`${f.filename}: ${f.error || 'invalid filename'}`)
      }

      const toImport = items.filter((m) => !alreadySet.has(m.name.toLowerCase()) && !rejected.has(m.name.toLowerCase()))
      const localCopies = []
      const streamItems = []

      for (const m of toImport) {
        if (!window.api.remote.isRemote) {
          const sourcePath = window.api.packages.getPathForFile?.(m.file) || ''
          if (sourcePath) {
            localCopies.push({ ...m, sourcePath })
            continue
          }
        }
        streamItems.push({
          uploadId: crypto.randomUUID(),
          name: m.name,
          file: m.file,
        })
      }

      const streamTotal = streamItems.reduce((s, m) => s + (m.file.size || 0), 0)
      const localTotal = localCopies.reduce((s, m) => s + (m.file.size || 0), 0)
      const transferTotal = localTotal + streamTotal
      setProgress({ acked: 0, totalBytes: transferTotal, phase: 'transfer' })

      // Local-path files join the batch via copy/move (no byte streaming).
      let localAcked = 0
      let localOk = 0

      for (const m of localCopies) {
        try {
          const res = await window.api.packages.importLocalCopy(m.name, m.sourcePath, move)
          if (res?.already) alreadySet.add(m.name.toLowerCase())
          // A scan failure is recorded on the server batch; commit reports it.
          else if (res?.ok) localOk += 1
        } catch (err) {
          failed.push(`${m.name}: ${err?.message || 'failed'}`)
        } finally {
          // Count the file either way so the bar tracks progress, not successes.
          localAcked += m.file.size || 0
          setProgress({ acked: localAcked, totalBytes: transferTotal, phase: 'transfer' })
        }
      }

      if (streamItems.length > 0) {
        await streamImportBatch(streamItems, (streamAcked) => {
          setProgress({
            acked: localAcked + streamAcked,
            totalBytes: transferTotal,
            phase: 'transfer',
          })
        })
      }

      const installCount = localOk + streamItems.length
      if (installCount > 0) {
        setProgress({ acked: transferTotal, totalBytes: transferTotal, phase: 'install', installCount })
      }

      mergeServerResults(await window.api.packages.importLocalCommit())
      finished = true
    } catch (err) {
      // Finalize whatever already scanned (local copies / completed uploads) so
      // the library isn't left stale, and surface those successes in the toast.
      if (!finished) {
        try {
          mergeServerResults(await window.api.packages.importLocalAbort())
          finished = true
        } catch {}
      }
      failed.push(err?.message || 'Import failed')
    }

    const already = alreadySet.size
    setProgress(null)
    setImporting(false)
    setPending(null)

    if (added > 0) {
      toast(
        move
          ? `Moved ${added} package${added === 1 ? '' : 's'} into your library.`
          : `Added ${added} package${added === 1 ? '' : 's'} to your library.`,
        'success',
      )
    }
    if (already > 0) toast(`${already} package${already === 1 ? '' : 's'} already in your library.`, 'info')
    if (failed.length > 0) {
      toast(`${failed.length} file${failed.length === 1 ? '' : 's'} failed: ${failed[0]}`, 'error')
      for (const msg of failed.slice(1)) toast(msg, 'error')
    }
  }, [pending])

  const cancel = useCallback(() => {
    if (importing) return
    setPending(null)
  }, [importing])

  const count = pending?.items.length ?? 0
  const open = scanning || !!pending
  const willMove = !!pending?.willMove
  const isInstallPhase = progress?.phase === 'install'
  // The install phase renders an indeterminate full-width bar, so pct only ever
  // has to describe the transfer.
  const pct = progress?.totalBytes > 0 ? Math.min(100, Math.round((progress.acked / progress.totalBytes) * 100)) : 0

  return (
    <>
      {dragging &&
        createPortal(
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-base/70 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent-blue/60 bg-surface/80 px-10 py-8 text-center shadow-2xl">
              <PackagePlus size={40} className="text-accent-blue" />
              <div className="text-sm font-medium text-text-primary">Drop to add to your library</div>
              <div className={CLARIFY}>Release .var files or folders to import them</div>
            </div>
          </div>,
          document.body,
        )}

      <AlertDialog open={open} onOpenChange={(o) => !o && cancel()}>
        <AlertDialogContent
          className="data-[size=default]:max-w-[min(28rem,calc(100%-2rem))]"
          onEscapeKeyDown={(e) => (importing || scanning) && e.preventDefault()}
        >
          {scanning && !pending ? (
            <AlertDialogHeader>
              <AlertDialogMedia>
                <Loader2 className="animate-spin text-accent-blue" />
              </AlertDialogMedia>
              <AlertDialogTitle>Reading dropped files…</AlertDialogTitle>
              <AlertDialogDescription>Scanning folders for .var packages.</AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <PackagePlus className="text-accent-blue" />
                </AlertDialogMedia>
                <AlertDialogTitle>
                  {willMove ? 'Move' : 'Add'} {count} package{count === 1 ? '' : 's'} to your library?
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="min-w-0">
                    <p>
                      {willMove
                        ? `${formatBytes(pending?.totalBytes ?? 0)} moved into your VaM library and scanned as direct installs. The original files are removed.`
                        : `${formatBytes(pending?.totalBytes ?? 0)} copied into your VaM library and scanned as direct installs.`}
                    </p>
                    <ul className="mt-2 max-h-40 min-w-0 overflow-y-auto space-y-0.5">
                      {pending?.items.map((m, i) => (
                        <li
                          key={`${m.name}-${i}`}
                          className={`truncate ${CLARIFY} select-text cursor-text`}
                          title={m.file.name === m.name ? m.name : `${m.file.name} → ${m.name}`}
                        >
                          {m.name}
                        </li>
                      ))}
                    </ul>
                    {pending?.skipped > 0 && (
                      <p className={`mt-2 ${CLARIFY}`}>
                        {pending.skipped} other file{pending.skipped === 1 ? '' : 's'} ignored (not .var).
                      </p>
                    )}
                    {pending?.invalid?.length > 0 && (
                      <p className="mt-1 text-xs text-warning">
                        {pending.invalid.length} .var file{pending.invalid.length === 1 ? '' : 's'} skipped — invalid
                        name (expected Creator.Name.Version.var).
                      </p>
                    )}
                    {importing && (
                      <div className="mt-3">
                        <div className={`flex justify-between ${CLARIFY}`}>
                          <span>
                            {isInstallPhase
                              ? `Installing ${progress?.installCount ?? count} package${(progress?.installCount ?? count) === 1 ? '' : 's'}…`
                              : `${willMove ? 'Moving' : 'Copying'} ${formatBytes(progress?.acked ?? 0)} / ${formatBytes(progress?.totalBytes ?? 0)}…`}
                          </span>
                          <span>{isInstallPhase ? '' : `${pct}%`}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                          <div
                            className={`h-full rounded-full bg-accent-blue transition-[width] duration-150 ${isInstallPhase ? 'animate-pulse w-full' : ''}`}
                            style={isInstallPhase ? undefined : { width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                {!importing && (
                  <AlertDialogCancel
                    onClick={(e) => {
                      e.preventDefault()
                      cancel()
                    }}
                  >
                    Cancel
                  </AlertDialogCancel>
                )}
                <AlertDialogAction
                  disabled={importing}
                  onClick={(e) => {
                    e.preventDefault()
                    void runImport()
                  }}
                >
                  {importing ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />{' '}
                      {isInstallPhase ? 'Installing…' : willMove ? 'Moving…' : 'Copying…'}
                    </>
                  ) : willMove ? (
                    'Move to Library'
                  ) : (
                    'Add to Library'
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
