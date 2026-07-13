import { useCallback, useEffect, useRef, useState } from 'react'
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

// Upload chunk size for streaming a .var to the (possibly remote) main process.
// Usage is overwhelmingly local, where chunks cross as raw bytes (structured
// clone) and larger chunks just mean fewer round-trips. The ceiling is the
// remote case: the wire codec base64s each buffer into one JS string, so a
// chunk must stay under Node's max string length and the WS `maxPayload`
// (100 MiB). 32 MiB → ~42.7 MiB base64, leaving ample headroom.
const IMPORT_CHUNK_BYTES = 32 * 1024 * 1024

/**
 * Stream one dropped file to `packages:import-local-*` in bounded chunks so a
 * large .var never has to cross the IPC/remote boundary as a single buffer.
 * Reads each slice lazily via `Blob.slice` so peak memory stays ~one chunk.
 * `onProgress(fraction)` reports 0..1 completion for the current file.
 */
async function importFileChunked(name, file, onProgress) {
  const begin = await window.api.packages.importLocalBegin(name)
  if (begin?.already) return { already: true }

  const { uploadId } = begin
  try {
    for (let offset = 0; offset < file.size; offset += IMPORT_CHUNK_BYTES) {
      const end = Math.min(offset + IMPORT_CHUNK_BYTES, file.size)
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer())
      await window.api.packages.importLocalChunk(uploadId, chunk)
      onProgress?.(end / file.size)
    }
    return await window.api.packages.importLocalFinish(uploadId)
  } catch (err) {
    try {
      await window.api.packages.importLocalAbort(uploadId)
    } catch {}
    throw err
  }
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
 * Reads the dropped File bytes in the renderer and ships them to
 * `packages:import-local`, so the same flow works for a remote client head — the
 * server writes each buffer into its own library.
 *
 * Files are imported sequentially (one RPC at a time): the main-process add
 * pipeline mutates a shared in-memory graph, so overlapping imports could race.
 * Each step awaits, keeping the renderer event loop free so the UI stays
 * responsive and shows live progress even for a batch of large files.
 *
 * Drops onto the Hub <webview> guest go to the page, not here; that's expected.
 */
export default function DropImport() {
  const [dragging, setDragging] = useState(false)
  const [scanning, setScanning] = useState(false) // enumerating dropped folders
  const [pending, setPending] = useState(null) // { items:[{file,name}], skipped, invalid, totalBytes } awaiting confirm
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(null) // { current, total }
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
      const items = varItems.filter((m) => hasValidVarName(m.name))
      const invalid = varItems.filter((m) => !hasValidVarName(m.name)).map((m) => m.name)

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
      setPending({ items, skipped, invalid, totalBytes })
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
    setImporting(true)
    setProgress({ current: 0, total: items.length })
    let added = 0
    let already = 0
    const failed = []
    for (let i = 0; i < items.length; i++) {
      setProgress({ current: i, total: items.length })
      const { file, name } = items[i]
      try {
        const res = await importFileChunked(name, file, (frac) =>
          setProgress({ current: i + frac, total: items.length }),
        )
        if (res?.already) already += 1
        else added += 1
      } catch (err) {
        failed.push(`${name}: ${err?.message || 'failed'}`)
      }
    }
    setProgress(null)
    setImporting(false)
    setPending(null)

    if (added > 0) toast(`Added ${added} package${added === 1 ? '' : 's'} to your library.`, 'success')
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
  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <>
      {dragging && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-base/70 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent-blue/60 bg-surface/80 px-10 py-8 text-center shadow-2xl">
            <PackagePlus size={40} className="text-accent-blue" />
            <div className="text-sm font-medium text-text-primary">Drop to add to your library</div>
            <div className="text-xs text-text-secondary">Release .var files or folders to import them</div>
          </div>
        </div>
      )}

      <AlertDialog open={open} onOpenChange={(o) => !o && cancel()}>
        <AlertDialogContent onEscapeKeyDown={(e) => (importing || scanning) && e.preventDefault()}>
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
                  Add {count} package{count === 1 ? '' : 's'} to your library?
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div>
                    <p>
                      {formatBytes(pending?.totalBytes ?? 0)} copied into your VaM library and scanned as direct
                      installs.
                    </p>
                    <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
                      {pending?.items.map((m, i) => (
                        <li
                          key={`${m.name}-${i}`}
                          className="truncate text-xs text-text-secondary select-text cursor-text"
                          title={m.file.name === m.name ? m.name : `${m.file.name} → ${m.name}`}
                        >
                          {m.name}
                        </li>
                      ))}
                    </ul>
                    {pending?.skipped > 0 && (
                      <p className="mt-2 text-xs text-text-tertiary">
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
                        <div className="flex justify-between text-xs text-text-secondary">
                          <span>
                            Copying {Math.min(Math.floor(progress?.current ?? 0) + 1, count)} / {count}…
                          </span>
                          <span>{pct}%</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                          <div
                            className="h-full rounded-full bg-accent-blue transition-[width] duration-150"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  disabled={importing}
                  onClick={(e) => {
                    e.preventDefault()
                    cancel()
                  }}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={importing}
                  onClick={(e) => {
                    e.preventDefault()
                    void runImport()
                  }}
                >
                  {importing ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Copying…
                    </>
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
