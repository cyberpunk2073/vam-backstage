import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, formatBytes } from '@/lib/utils'
import { EMPHASIS, ASIDE, META, SECTION_LABEL, CLARIFY } from '@/lib/typography'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function pathBasename(p) {
  const parts = String(p || '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts[parts.length - 1] || p
}

function RadioRow({ checked, onSelect, title, children }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded border p-2 flex gap-2 items-start transition-colors cursor-pointer ${
        checked ? 'border-accent-blue bg-accent-blue/10' : 'border-border hover:bg-elevated'
      }`}
    >
      <span
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
          checked ? 'border-accent-blue bg-accent-blue' : 'border-text-tertiary'
        }`}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className={cn('block text-sm', EMPHASIS)}>{title}</span>
        <span className={cn('block', CLARIFY)}>{children}</span>
      </span>
    </button>
  )
}

/**
 * Stable array identity from a filename list: callers pass inline literals
 * (`[pkg.filename]`), so keying effects on the array itself would refetch on
 * every unrelated re-render. The joined string compares by value.
 */
function useFilenameList(filenames) {
  const key = filenames.join('\0')
  return useMemo(() => (key ? key.split('\0') : []), [key])
}

/**
 * Archive confirm dialog. Shows the prune/store dependency split for the selected
 * batch (fetched via `packages:archive-preview`) and lets the user pick a target
 * archive dir. The destructive-prune explanation lives here (it deletes files).
 *
 * Preview draws from the local replaceability cache immediately; a best-effort Hub
 * refresh then updates that cache and re-previews. Confirm is never blocked —
 * Archive uses whatever the cache holds at click time (no second Hub pass).
 *
 * The body lives in a child component *inside* `AlertDialogContent` on purpose:
 * an `<AlertDialog>` renders its children whether or not it is open, and only
 * the portal underneath `AlertDialogContent` is presence-gated. Hooks placed
 * out here would fire their IPC (including a Hub round-trip) as soon as a
 * package is selected, without the dialog ever being opened.
 */
export function ArchiveDialogContent({ filenames, archiveDirs, onConfirm }) {
  return (
    <AlertDialogContent>
      <ArchiveDialogBody filenames={filenames} archiveDirs={archiveDirs} onConfirm={onConfirm} />
    </AlertDialogContent>
  )
}

function ArchiveDialogBody({ filenames, archiveDirs, onConfirm }) {
  const [depMode, setDepMode] = useState('prune')
  const [archiveDirId, setArchiveDirId] = useState(() => archiveDirs[0]?.id ?? null)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [hubRefreshing, setHubRefreshing] = useState(false)
  const [hubRefreshGen, setHubRefreshGen] = useState(0)
  const list = useFilenameList(filenames)
  const count = list.length

  // Best-effort Hub cache refresh once per batch; bumps gen so preview re-runs.
  useEffect(() => {
    let cancelled = false
    setHubRefreshing(true)
    window.api.packages
      .refreshArchiveReplaceability(list)
      .catch(() => {})
      .finally(() => {
        if (cancelled) return
        setHubRefreshing(false)
        setHubRefreshGen((g) => g + 1)
      })
    return () => {
      cancelled = true
    }
  }, [list])

  // Both dep-modes come back in one preview (picking the radio is a comparison,
  // so both rows must show their own numbers) — the mode is not a fetch input.
  useEffect(() => {
    let cancelled = false
    // Keep prior bill visible while Hub re-preview runs (no "Calculating…" flash).
    if (hubRefreshGen === 0) setLoading(true)
    window.api.packages
      .archivePreview(list, archiveDirId)
      .then((res) => {
        if (!cancelled) setPreview(res)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [list, archiveDirId, hubRefreshGen])

  // Both rows always describe their own mode, so the radio is a real comparison.
  const { prune, store } = preview ?? { prune: {}, store: {} }
  const deleteCount = prune.deleteCount ?? 0
  const storeCount = store.storeCount ?? 0
  // Prune vs store only matters when something is Hub-replaceable and deletable.
  // Dialog stays open either way — Hub refresh can still promote a 0 → N prune bill
  // and re-introduce the choice. A zero-prune bill is an info note, not a fake choice.
  const canPrune = deleteCount > 0 && !preview?.catalogUnavailable
  const pruneText = preview?.catalogUnavailable
    ? 'Hub catalog unavailable. Dependencies will be stored in the archive instead of deleted.'
    : `Deletes ${plural(deleteCount, 'dependency', 'dependencies')} nothing else needs (${formatBytes(prune.deleteBytes ?? 0)}); they can be re-downloaded if you install later.` +
      (prune.storeBytes
        ? ` Local-only dependencies (${formatBytes(prune.storeBytes)}) are stored in the archive, never deleted.`
        : '')
  const storeText = `Moves ${plural(storeCount, 'unneeded dependency', 'unneeded dependencies')} (${formatBytes(store.storeBytes ?? 0)}) into the archive with the package, so a later install needs no downloads.`
  const noPruneNote =
    storeCount > 0
      ? `No Hub-replaceable dependencies to drop. ${plural(storeCount, 'unneeded dependency', 'unneeded dependencies')} (${formatBytes(store.storeBytes ?? 0)}) will be stored in the archive with the package.`
      : `No unneeded dependencies to drop or move. Only the selected ${count === 1 ? 'package' : 'packages'} will be archived.`

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          Archive {count === 1 ? '1 package' : `${count} packages`}?
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-3 select-text cursor-text">
            <p>
              Moved to cold storage: kept on disk and browsable in the Archived section, but dormant. VaM won&apos;t
              load it and the app won&apos;t prompt for its missing dependencies.
            </p>
            {archiveDirs.length > 1 && (
              <div className="space-y-1">
                <span className={SECTION_LABEL}>Archive directory</span>
                <Select value={String(archiveDirId)} onValueChange={(v) => setArchiveDirId(Number(v))}>
                  <SelectTrigger className="h-8 bg-elevated text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {archiveDirs.map((d) => (
                      <SelectItem key={d.id} value={String(d.id)} title={d.path}>
                        {pathBasename(d.path)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {loading && !preview ? (
              <p className={cn('rounded border border-border bg-elevated/40 px-2.5 py-2 leading-relaxed', META)}>
                Calculating dependency options…
              </p>
            ) : canPrune ? (
              <div className="space-y-1.5">
                <RadioRow
                  checked={depMode === 'prune'}
                  onSelect={() => setDepMode('prune')}
                  title="Drop unneeded dependencies (frees disk space)"
                >
                  {pruneText}
                </RadioRow>
                <RadioRow
                  checked={depMode === 'store'}
                  onSelect={() => setDepMode('store')}
                  title="Store dependencies (self-contained)"
                >
                  {storeText}
                </RadioRow>
                {/* Bears on the choice being made in the radio above it, so it is a clarification
                    rather than an aside — skipping it can lead to picking the wrong mode. */}
                <p className={cn(CLARIFY, 'px-0.5')}>
                  Packages currently on the Hub are occasionally delisted later, so only drop what you&apos;re
                  comfortable re-acquiring if that happens.
                </p>
              </div>
            ) : (
              <p className={cn('rounded border border-border bg-elevated/40 px-2.5 py-2 leading-relaxed', CLARIFY)}>
                {noPruneNote}
              </p>
            )}
            <p className={ASIDE}>Dependencies still needed by other non-archived packages are never touched.</p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter className="relative">
        {/* Out of flow so showing/hiding never reflows the dialog or leaves a gap. */}
        <span
          className={cn(
            'absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none transition-opacity duration-200',
            META,
            hubRefreshing ? 'opacity-100' : 'opacity-0',
          )}
          aria-live="polite"
          aria-hidden={!hubRefreshing}
        >
          <Loader2 size={12} className="animate-spin shrink-0" />
          Checking Hub…
        </span>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => onConfirm(archiveDirId, canPrune ? depMode : 'store')}>
          Archive
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}

/**
 * Install-from-archive confirm dialog. Opens immediately with the missing-dep
 * count; Hub availability / approx size fill in asynchronously so network never
 * blocks the dialog. Unavailable (paid / removed / no URL) is the important signal.
 *
 * Body split out for the same reason as `ArchiveDialogContent` — see there.
 */
export function InstallFromArchiveDialogContent({ pkgs, onConfirm }) {
  return (
    <AlertDialogContent>
      <InstallFromArchiveDialogBody pkgs={pkgs} onConfirm={onConfirm} />
    </AlertDialogContent>
  )
}

function InstallFromArchiveDialogBody({ pkgs, onConfirm }) {
  const list = useMemo(() => (Array.isArray(pkgs) ? pkgs : [pkgs]), [pkgs])
  const count = list.length
  const filenames = useFilenameList(list.map((p) => p.filename).filter(Boolean))
  const missingHint = useMemo(() => list.reduce((sum, p) => sum + (p.missingDeps || 0), 0), [list])
  const name = count === 1 ? list[0]?.title || list[0]?.packageName || list[0]?.filename : `${count} packages`

  // null = still checking Hub; object = settled (including checkFailed).
  const [hubBill, setHubBill] = useState(null)

  useEffect(() => {
    let cancelled = false
    setHubBill(null)
    ;(async () => {
      try {
        const { refs } = await window.api.packages.installFromArchivePreview(filenames)
        if (cancelled) return
        if (!refs?.length) {
          setHubBill({ downloadable: 0, unavailable: 0, bytes: 0 })
          return
        }
        const details = await window.api.packages.enrichFromHub(refs)
        if (cancelled) return
        let downloadable = 0
        let unavailable = 0
        let bytes = 0
        for (const ref of refs) {
          const d = details?.[ref]
          if (d?.installedLocally) continue // Hub pointed at something already on disk
          if (d?.downloadUrl) {
            downloadable++
            if (d.fileSize) bytes += d.fileSize
          } else {
            unavailable++
          }
        }
        setHubBill({ downloadable, unavailable, bytes })
      } catch {
        if (!cancelled) setHubBill({ checkFailed: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filenames])

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">Install {name} from archive?</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 select-text cursor-text">
            {/* Worked example of the six-role model: body → emphasis → semantic → aside. */}
            <p>{count === 1 ? 'The package' : 'The packages'} will be activated and moved into your main library.</p>
            {!hubBill ? (
              <>
                {missingHint > 0 ? (
                  <p className={EMPHASIS}>
                    {missingHint} missing dependenc{missingHint === 1 ? 'y' : 'ies'}. Checking Hub availability…
                  </p>
                ) : (
                  <p>Checking dependencies…</p>
                )}
              </>
            ) : hubBill.checkFailed ? (
              <p className="text-warning">
                Couldn&apos;t reach the Hub to check availability
                {missingHint > 0 ? ` (${missingHint} missing dependenc${missingHint === 1 ? 'y' : 'ies'})` : ''}.
                Install may still queue what it can.
              </p>
            ) : !hubBill.downloadable && !hubBill.unavailable ? (
              <p>All required dependencies are already available; nothing needs downloading.</p>
            ) : (
              <>
                {hubBill.downloadable > 0 && (
                  <p className={EMPHASIS}>
                    {hubBill.downloadable} dependenc{hubBill.downloadable === 1 ? 'y' : 'ies'} will be downloaded from
                    the Hub
                    {hubBill.bytes > 0 ? ` (~${formatBytes(hubBill.bytes)})` : ''}.
                  </p>
                )}
                {hubBill.unavailable > 0 && (
                  <p className="text-warning font-medium">
                    {hubBill.unavailable} dependenc{hubBill.unavailable === 1 ? 'y is' : 'ies are'} not available on the
                    Hub (paid, removed, or unknown), and not in the archive either. Install will leave{' '}
                    {hubBill.unavailable === 1 ? 'it' : 'them'} missing.
                  </p>
                )}
              </>
            )}
            <p className={ASIDE}>
              Dependencies already stored in the archive are activated from disk, not re-downloaded. Download size is
              approximate (Hub may substitute a nearby version; further deps can appear after install).
            </p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm}>Install</AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
