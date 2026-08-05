import { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react'
import {
  FolderOpen,
  RefreshCw,
  HardDrive,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Bug,
  Bookmark,
  Heart,
  Wrench,
  Trash2,
  ShieldCheck,
  Compass,
  FlaskConical,
  CurlyBraces,
  Network,
  Plug,
  PlugZap,
  Plus,
  MoreHorizontal,
  FolderInput,
  Boxes,
  X,
} from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'
import { SettingRow } from '@/components/SettingRow'
import {
  TITLE_PAGE,
  TITLE_SECTION,
  LABEL,
  BODY_DENSE,
  EMPHASIS,
  META_DENSE,
  CLARIFY,
  CLARIFY_DENSE,
} from '@/lib/typography'
import { parseDisableBehavior, disableBehaviorMoveTo, DISABLE_BEHAVIOR_SUFFIX } from '@shared/disable-behavior.js'
import { DEFAULT_REMOTE_PORT, normalizeConnectUrl } from '@shared/remote-config.js'
import { toast } from '@/components/Toast'
import { useStatusStore } from '@/stores/useStatusStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { useRemoteUiStore } from '@/stores/useRemoteUiStore'
import { useCatalogStore } from '@/stores/useCatalogStore'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { TruncateWithTooltip } from '@/components/TruncateWithTooltip'
import { AutoHideSwitch, AutoHideForeignSwitch } from '@/components/AutoHideSwitch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export default function SettingsView() {
  const [vamDir, setVamDir] = useState('')
  const blurThumbnails = useRemoteUiStore((s) => s.blurThumbnails)
  const setBlurThumbnails = useRemoteUiStore((s) => s.setBlurThumbnails)
  const [hubDebugRequests, setHubDebugRequests] = useState(false)
  const offlineCatalogEnabled = useCatalogStore((s) => s.enabled)
  const [isDev, setIsDev] = useState(false)
  const [developerUnlocked, setDeveloperUnlocked] = useState(false)
  const [deletedData, setDeletedData] = useState({ packages: 0, contentLabels: 0 })
  const devUnlockRef = useRef({ count: 0, resetTimer: null })
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState(null)
  const [hubScanning, setHubScanning] = useState(false)
  const [hubScanProgress, setHubScanProgress] = useState(null)
  const [baSyncing, setBaSyncing] = useState(false)
  const [baSyncResult, setBaSyncResult] = useState(null)
  const [wishlistImporting, setWishlistImporting] = useState(null)
  const [wishlistImportProgress, setWishlistImportProgress] = useState(null)
  const [wishlistImportResult, setWishlistImportResult] = useState(null)
  const [baDirPresent, setBaDirPresent] = useState(false)
  const [hubLoggedIn, setHubLoggedIn] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateChannel, setUpdateChannel] = useState('stable')
  const [libDirs, setLibDirs] = useState({ main: '', aux: [] })
  // What library-dir operation is in flight: `'add'`, an aux dir id, or null.
  // Scoped rather than a plain boolean so each control reflects only its *own*
  // operation — a shared flag greyed out the whole section (Add button included)
  // every time one row's mode switch was flipped.
  const [libDirsBusy, setLibDirsBusy] = useState(null)
  const [disableBehavior, setDisableBehavior] = useState('suffix')
  const [moveOnImport, setMoveOnImport] = useState(false)
  const [offloadSuggestions, setOffloadSuggestions] = useState([])
  const [dismissedOffload, setDismissedOffload] = useState(() => new Set())
  const stats = useStatusStore((s) => s.stats)
  const fetchStats = useStatusStore((s) => s.fetchStats)
  const dimInactive = useLibraryStore((s) => s.dimInactive)
  const setDimInactive = useLibraryStore((s) => s.setDimInactive)
  const suppressDisablePackageWarning = useLibraryStore((s) => s.suppressDisablePackageWarning)
  const setSuppressDisablePackageWarning = useLibraryStore((s) => s.setSuppressDisablePackageWarning)
  const remoteWarningDismissed = useRemoteUiStore((s) => s.warningDismissed)
  const dismissRemoteWarning = useRemoteUiStore((s) => s.dismissWarning)
  const isRemoteClient = !!window.api.remote?.isRemote
  const [remoteStatus, setRemoteStatus] = useState(null)
  const [localIps, setLocalIps] = useState({ primary: null, all: [] })
  // The machine-scoped remote prefs exactly as main reports them. Every write
  // returns the resulting config and replaces this wholesale, so the switches
  // below read persisted truth instead of a local copy that can drift from it.
  const [remoteConfig, setRemoteConfig] = useState(null)
  const remoteEnabled = !!remoteConfig?.remoteEnabled
  const serveOnLaunch = !!remoteConfig?.serveOnLaunch
  const autoConnectArmed = !!remoteConfig?.autoconnect
  // The two text fields are genuinely local drafts: they change per keystroke and
  // only reach the prefs when the user acts on them.
  const [portDraft, setPortDraft] = useState(String(DEFAULT_REMOTE_PORT))
  const [urlDraft, setUrlDraft] = useState('')

  // Mirrors `libDirsBusy` so the re-entrancy guard reads the live value from
  // inside an async handler (by then the state captured in the closure is stale)
  // and so the handlers no longer take it as a dependency.
  const libDirsBusyRef = useRef(null)

  /** Claim the library-dir lock. False (with a toast) when something else holds it. */
  const beginLibDirsOp = useCallback((token) => {
    if (libDirsBusyRef.current !== null) {
      toast('Another library folder operation is still running. Try again in a moment.', 'error')
      return false
    }
    libDirsBusyRef.current = token
    setLibDirsBusy(token)
    return true
  }, [])

  const endLibDirsOp = useCallback(() => {
    libDirsBusyRef.current = null
    setLibDirsBusy(null)
  }, [])

  // `suggestions: false` skips the disk-walking detection pass for operations that
  // cannot change the suggestion set (a role or BrowserAssist flip registers and
  // un-registers nothing), keeping those flips quick enough to feel instant.
  const refreshLibDirs = useCallback(async ({ suggestions = true } = {}) => {
    try {
      const r = await window.api.libraryDirs.list()
      setLibDirs(r)
    } catch (err) {
      console.warn('library-dirs:list failed:', err.message)
    }
    if (!suggestions) return
    try {
      setOffloadSuggestions(await window.api.libraryDirs.suggest())
    } catch (err) {
      console.warn('library-dirs:suggest failed:', err.message)
    }
  }, [])

  // Machine-scoped, so this reads the *local* prefs — `settings:*` would fetch the
  // host's values on a client head.
  const loadRemoteConfig = useCallback(async () => {
    const cfg = await window.api.remote.getConfig()
    setRemoteConfig(cfg)
    setPortDraft(String(cfg.servePort))
    setUrlDraft(cfg.connectUrl)
  }, [])

  /** The single write path for remote prefs; main echoes back the stored result. */
  const patchRemoteConfig = useCallback(async (patch) => {
    setRemoteConfig(await window.api.remote.setConfig(patch))
  }, [])

  useEffect(() => {
    window.api.settings.get('vam_dir').then((v) => setVamDir(v || ''))
    window.api.settings.get('hub_debug_requests').then((v) => setHubDebugRequests(v === '1'))
    useCatalogStore.getState().loadEnabled()
    window.api.dev.getUnlocked().then((v) => setDeveloperUnlocked(!!v))
    window.api.settings.get('disable_behavior').then((v) => setDisableBehavior(v || 'suffix'))
    window.api.settings.get('import_move_files').then((v) => setMoveOnImport(v === '1'))
    window.api.settings.get('offload_suggestions_dismissed').then((v) =>
      setDismissedOffload(
        new Set(
          (v || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ),
    )
    loadRemoteConfig().catch(() => {})
    window.api.dev.isDev().then(setIsDev)
    window.api.dev
      .countDeletedData()
      .then((r) =>
        setDeletedData(
          r?.ok ? { packages: r.packages, contentLabels: r.contentLabels } : { packages: 0, contentLabels: 0 },
        ),
      )
      .catch(() => {})
    window.api.app.getVersion().then(setAppVersion)
    window.api.updater.getChannel().then((c) => setUpdateChannel(c === 'dev' ? 'dev' : 'stable'))
    refreshLibDirs()
  }, [refreshLibDirs, loadRemoteConfig])

  // Folders are always registered as offload — the cheap, reversible role. The
  // user picks the real mode afterwards on the row itself, where the switch is
  // labelled with what each mode does.
  const handleAddAuxDir = useCallback(async () => {
    // The lock is claimed after the picker closes rather than before it opens:
    // the OS dialog is the slow part, so any row operation started moments earlier
    // has finished by the time a folder is chosen. Gating the button on it instead
    // would flash the section header on every unrelated flip.
    const browseResult = await window.api.libraryDirs.browse()
    if (browseResult?.cancelled) return
    if (!beginLibDirsOp('add')) return
    try {
      await window.api.libraryDirs.add(browseResult.path)
      await refreshLibDirs()
      fetchStats()
      toast('Offload folder added. Turn on Archive on its row for cold storage that reclaims disk.', 'success')
    } catch (err) {
      toast(`Failed to add directory: ${err.message}`, 'error')
    } finally {
      endLibDirsOp()
    }
  }, [beginLibDirsOp, endLibDirsOp, refreshLibDirs, fetchStats])

  const handleAddSuggestion = useCallback(
    async (suggestion) => {
      if (!beginLibDirsOp('add')) return
      try {
        const res = await window.api.libraryDirs.add(suggestion.path)
        await refreshLibDirs()
        fetchStats()
        toast(
          res?.browserAssist
            ? `${suggestion.label} offload directory added; BrowserAssist mode enabled`
            : `${suggestion.label} offload directory added`,
          'success',
        )
      } catch (err) {
        toast(`Failed to add directory: ${err.message}`, 'error')
      } finally {
        endLibDirsOp()
      }
    },
    [beginLibDirsOp, endLibDirsOp, refreshLibDirs, fetchStats],
  )

  const handleSetRole = useCallback(
    async (id, role) => {
      if (!beginLibDirsOp(id)) return
      try {
        const hadArchiveDir = libDirs.aux.some((d) => d.archive)
        const res = await window.api.libraryDirs.setRole(id, role)
        await refreshLibDirs({ suggestions: false })
        // Main reports the reset rather than us re-reading the setting — a role
        // flip is the one place that can change it, and it already tells us.
        if (res?.disableBehaviorReset) setDisableBehavior(DISABLE_BEHAVIOR_SUFFIX)
        fetchStats()
        const bits = []
        if (res?.packagesReclassified)
          bits.push(`${res.packagesReclassified} package${res.packagesReclassified === 1 ? '' : 's'} reclassified`)
        if (res?.disableBehaviorReset) bits.push('disable behavior reset to VaM native')
        // The first archive dir unlocks the tier across the app, which is worth
        // saying once — but in the toast, not a modal: flipping an empty folder
        // has to stay free in both directions or the switch stops being a switch.
        const unlocksArchive = role === 'archive' && !hadArchiveDir
        toast(
          `Archive turned ${role === 'archive' ? 'on' : 'off'} for this folder${bits.length ? `: ${bits.join(', ')}` : ''}${
            unlocksArchive ? '. The Library now has an Archived shelf and an Archive action on every package.' : ''
          }`,
          'success',
          unlocksArchive ? 8000 : undefined,
        )
      } catch (err) {
        toast(`Failed to change role: ${err.message}`, 'error')
      } finally {
        endLibDirsOp()
      }
    },
    [beginLibDirsOp, endLibDirsOp, refreshLibDirs, fetchStats, libDirs.aux],
  )

  const dismissOffloadSuggestion = useCallback((id) => {
    setDismissedOffload((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      void window.api.settings.set('offload_suggestions_dismissed', [...next].join(','))
      return next
    })
  }, [])

  const handleRemoveAuxDir = useCallback(
    async (id, opts) => {
      if (!beginLibDirsOp(id)) return
      const label = libDirs.aux.find((d) => d.id === id)?.archive ? 'Archive' : 'Offload'
      try {
        const res = await window.api.libraryDirs.remove(id, opts)
        if (res?.matchedToolId) dismissOffloadSuggestion(res.matchedToolId)
        await refreshLibDirs()
        const next = await window.api.settings.get('disable_behavior')
        setDisableBehavior(next || 'suffix')
        fetchStats()
        const forgotten = res?.forgotten || 0
        toast(
          forgotten > 0
            ? `${label} directory removed: ${forgotten} package${forgotten === 1 ? '' : 's'} hidden (files kept on disk; re-add to restore)`
            : `${label} directory removed`,
          'success',
        )
      } catch (err) {
        toast(`Failed to remove: ${err.message}`, 'error')
      } finally {
        endLibDirsOp()
      }
    },
    [beginLibDirsOp, endLibDirsOp, refreshLibDirs, fetchStats, dismissOffloadSuggestion, libDirs.aux],
  )

  const handleToggleBrowserAssist = useCallback(
    async (id, enabled) => {
      if (!beginLibDirsOp(id)) return
      try {
        await window.api.libraryDirs.setBrowserAssist(id, enabled)
        await refreshLibDirs({ suggestions: false })
      } catch (err) {
        toast(`Failed to update BrowserAssist mode: ${err.message}`, 'error')
      } finally {
        endLibDirsOp()
      }
    },
    [beginLibDirsOp, endLibDirsOp, refreshLibDirs],
  )

  const handleDisableBehaviorChange = useCallback(async (value) => {
    setDisableBehavior(value)
    await window.api.settings.set('disable_behavior', value)
  }, [])

  const handleToggleMoveOnImport = useCallback(async (checked) => {
    setMoveOnImport(checked)
    await window.api.settings.set('import_move_files', checked ? '1' : '0')
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!vamDir) {
      setBaDirPresent(false)
    } else {
      window.api.browserAssist
        .dirExists()
        .then((r) => {
          if (!cancelled) setBaDirPresent(!!r?.exists)
        })
        .catch(() => {
          if (!cancelled) setBaDirPresent(false)
        })
    }
    return () => {
      cancelled = true
    }
  }, [vamDir])

  useEffect(() => {
    let cancelled = false
    window.api.hub.isLoggedIn().then((v) => {
      if (!cancelled) setHubLoggedIn(!!v)
    })
    const off = window.api.onHubAuthChanged((data) => setHubLoggedIn(!!data?.loggedIn))
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  const handleBrowseDir = useCallback(async () => {
    const result = await window.api.wizard.browseVamDir(vamDir || undefined)
    if (result.cancelled) return
    if (!result.valid) {
      setScanResult({ error: 'Selected directory does not contain an AddonPackages folder.' })
      return
    }
    await window.api.settings.set('vam_dir', result.path)
    setVamDir(result.path)
    setScanResult({ info: `VaM directory updated. Found ${result.varCount} .var files. Consider rescanning.` })
  }, [vamDir])

  const handleRescan = useCallback(async () => {
    if (scanning || hubScanning) return
    setScanning(true)
    setScanResult(null)
    try {
      const result = await window.api.scan.start()
      fetchStats()
      if (result?.unreadable?.length > 0) {
        setScanResult({
          error: `Scan complete. ${result.unreadable.length} file${result.unreadable.length !== 1 ? 's' : ''} could not be read (corrupted or invalid).`,
          corruptedFiles: result.unreadable,
        })
      } else {
        setScanResult({ success: 'Library scan complete.' })
      }
    } catch (err) {
      setScanResult({ error: `Scan failed: ${err.message}` })
    } finally {
      setScanning(false)
    }
  }, [scanning, hubScanning, fetchStats])

  const handleHubScan = useCallback(async () => {
    if (hubScanning) return
    setHubScanning(true)
    setHubScanProgress(null)
    setScanResult(null)
    const cleanup = window.api.onHubScanProgress((data) => setHubScanProgress(data))
    try {
      const result = await window.api.hub.scanPackages()
      fetchStats()
      setScanResult({
        success: `Hub scan complete. Enriched ${result.enriched} of ${result.total} package${result.total !== 1 ? 's' : ''} (${result.found} on Hub index, ${result.skipped} not listed).`,
      })
    } catch (err) {
      setScanResult({ error: `Hub scan failed: ${err.message}` })
    } finally {
      cleanup()
      setHubScanning(false)
      setHubScanProgress(null)
    }
  }, [hubScanning, fetchStats])

  const handleVerifyIntegrity = useCallback(async () => {
    if (verifying || hubScanning) return
    setVerifying(true)
    setVerifyProgress(null)
    setScanResult(null)
    const cleanup = window.api.onIntegrityProgress((data) => {
      setVerifyProgress(data)
    })
    try {
      const result = await window.api.integrity.check()
      fetchStats()
      if (result.corrupted > 0) {
        setScanResult({
          error: `${result.corrupted} of ${result.checked} packages corrupted.`,
          corruptedFiles: result.corruptedFiles,
        })
      } else {
        setScanResult({ success: `All ${result.checked} packages verified OK.` })
      }
    } catch (err) {
      setScanResult({ error: `Integrity check failed: ${err.message}` })
    } finally {
      cleanup()
      setVerifying(false)
      setVerifyProgress(null)
    }
  }, [verifying, hubScanning, fetchStats])

  const handleToggleHubDebug = useCallback(async (checked) => {
    setHubDebugRequests(checked)
    await window.api.settings.set('hub_debug_requests', checked ? '1' : '0')
  }, [])

  const handleToggleOfflineCatalog = useCallback(async (checked) => {
    await useCatalogStore.getState().setEnabled(checked)
  }, [])

  const handleChannelChange = useCallback(
    async (value) => {
      if (value !== 'stable' && value !== 'dev') return
      if (value === updateChannel) return
      const prev = updateChannel
      setUpdateChannel(value)
      try {
        const r = await window.api.updater.setChannel(value)
        if (!r?.ok) {
          toast(r?.error || 'Could not save update channel', 'error', 4500)
          setUpdateChannel(prev)
          return
        }
        const label = value === 'dev' ? 'Dev' : 'Stable'
        toast(`Update channel: ${label}. Checking for updates…`, 'info', 3500)
      } catch (err) {
        toast(`Channel switch failed: ${err.message}`, 'error', 4500)
        setUpdateChannel(prev)
      }
    },
    [updateChannel],
  )

  const handleNukeDatabase = useCallback(async () => {
    const res = await window.api.dev.nukeDatabase()
    if (!res?.ok && res?.error) toast(`Nuke database failed: ${res.error}`)
  }, [])

  const handleForgetDeleted = useCallback(async () => {
    const res = await window.api.dev.forgetDeletedData()
    if (!res?.ok) {
      toast(`Forget deleted data failed: ${res?.error || 'unknown error'}`)
      return
    }
    setDeletedData({ packages: 0, contentLabels: 0 })
    const parts = []
    if (res.packages > 0) parts.push(`${res.packages} deleted package${res.packages === 1 ? '' : 's'}`)
    if (res.contentLabels > 0)
      parts.push(`${res.contentLabels} orphaned content label${res.contentLabels === 1 ? '' : 's'}`)
    toast(parts.length ? `Forgot ${parts.join(' and ')}.` : 'Nothing to forget.')
  }, [])

  const handleSyncBrowserAssist = useCallback(async () => {
    if (baSyncing || !baDirPresent) return
    setBaSyncing(true)
    setBaSyncResult(null)
    try {
      const res = await window.api.browserAssist.sync()
      if (!res?.ok) {
        setBaSyncResult({ error: res?.error || 'Sync failed' })
        return
      }
      const msg = `BrowserAssist: updated ${res.tagsUpdated} resource(s); wrote ${res.shardsWritten} of ${res.shardsRead} shard(s). ${res.resourcesScanned} row(s) processed; ${res.skippedNoMatch} skipped (no local DB match).`
      if (res.errors?.length) {
        setBaSyncResult({ success: msg, warnings: res.errors })
      } else {
        setBaSyncResult({ success: msg })
      }
    } catch (err) {
      setBaSyncResult({ error: err.message })
    } finally {
      setBaSyncing(false)
    }
  }, [baSyncing, baDirPresent])

  useEffect(() => {
    if (!wishlistImporting) return
    return window.api.onWishlistImportProgress((data) => setWishlistImportProgress(data))
  }, [wishlistImporting])

  const formatWishlistImportProgress = useCallback((data) => {
    if (!data) return null
    if (data.phase === 'collect') {
      if (data.source === 'bookmarks') {
        return `Scanning Hub bookmarks (page ${data.page}/${data.pageCount}) — ${data.found} found`
      }
      if (data.source === 'favorites') {
        return `Scanning Hub favorites (collection ${data.collectionId}, page ${data.page}/${data.pageCount}) — ${data.found} found`
      }
      return null
    }
    if (data.phase === 'import') {
      return `Fetching resource details (${data.current}/${data.total}) — ${data.added} added, ${data.skipped} already wishlisted`
    }
    return null
  }, [])

  const handleImportHubListToWishlist = useCallback(
    async (source) => {
      if (wishlistImporting) return
      setWishlistImporting(source)
      setWishlistImportProgress(null)
      setWishlistImportResult(null)
      try {
        // Collect on this machine (Hub webview cookies); persist on the host DB.
        const collected = await window.api.wishlist.importCollect(source)
        if (!collected?.ok) {
          setWishlistImportResult({ error: collected?.error || 'Collect failed' })
          return
        }
        const res = await window.api.wishlist.importPersist({
          source,
          resourceIds: collected.resourceIds,
        })
        if (!res?.ok) {
          setWishlistImportResult({ error: res?.error || 'Import failed' })
          return
        }
        const msg = `Wishlist import (${source}): ${res.found} on Hub — ${res.added} added, ${res.skipped} already wishlisted${res.failed ? `, ${res.failed} failed` : ''}.`
        if (res.failed)
          setWishlistImportResult({ success: msg, warnings: [`${res.failed} resource(s) could not be fetched`] })
        else setWishlistImportResult({ success: msg })
      } catch (err) {
        setWishlistImportResult({ error: err.message })
      } finally {
        setWishlistImporting(null)
        setWishlistImportProgress(null)
      }
    },
    [wishlistImporting],
  )

  const handleOpenApplicationFolder = useCallback(async () => {
    const dbPath = await window.api.settings.getDatabasePath()
    if (dbPath) window.api.shell.showItemInFolder(dbPath)
  }, [])

  const showDevSection = isDev || developerUnlocked
  // The section can't be hidden while a client/host connection is live — the
  // toggle then reflects that forced-on state and can't be switched off.
  const remoteSectionForced = isRemoteClient || !!remoteStatus?.running

  const handleAboutVersionTap = useCallback(() => {
    if (isDev || developerUnlocked) return
    const r = devUnlockRef.current
    if (r.resetTimer != null) clearTimeout(r.resetTimer)
    r.count += 1
    r.resetTimer = setTimeout(() => {
      r.count = 0
      r.resetTimer = null
    }, 2000)
    if (r.count < 7) return
    r.count = 0
    if (r.resetTimer != null) clearTimeout(r.resetTimer)
    r.resetTimer = null
    window.api.dev.setUnlocked(true).then(() => {
      setDeveloperUnlocked(true)
      toast('Developer options enabled', 'success', 3000)
    })
  }, [isDev, developerUnlocked])

  const handleDisableDeveloperOptions = useCallback(async () => {
    await window.api.dev.setUnlocked(false)
    setDeveloperUnlocked(false)
    toast('Developer options disabled', 'success', 2500)
  }, [])

  useEffect(() => {
    if (isRemoteClient) return
    window.api.remote
      .status()
      .then((s) => {
        setRemoteStatus(s)
        // A server already running wins over the stored pref — the field should
        // show the port that's actually in use.
        if (s?.port) setPortDraft(String(s.port))
      })
      .catch(() => {})
    window.api.remote
      .localIps()
      .then(setLocalIps)
      .catch(() => {})
    // Live updates when clients connect/disconnect (pushed from the server).
    return window.api.on('remote:server-status', (s) => setRemoteStatus(s))
  }, [isRemoteClient])

  const refreshRemoteStatus = useCallback(async () => {
    try {
      setRemoteStatus(await window.api.remote.status())
    } catch {
      // ignore
    }
  }, [])

  const handleStartServer = useCallback(async () => {
    const port = parseInt(portDraft, 10) || DEFAULT_REMOTE_PORT
    setPortDraft(String(port))
    await patchRemoteConfig({ servePort: port })
    const r = await window.api.remote.startServer(port)
    if (!r?.ok) {
      toast(`Could not start server: ${r?.error || 'unknown error'}`, 'error', 4500)
      return
    }
    await refreshRemoteStatus()
    toast(`Serving on port ${r.port}`, 'success')
  }, [portDraft, patchRemoteConfig, refreshRemoteStatus])

  const handleStopServer = useCallback(async () => {
    await window.api.remote.stopServer()
    await refreshRemoteStatus()
    toast('Server stopped', 'success')
  }, [refreshRemoteStatus])

  const handleToggleServeOnLaunch = useCallback(
    async (checked) => {
      await patchRemoteConfig({ serveOnLaunch: checked })
    },
    [patchRemoteConfig],
  )

  const handleToggleRemoteEnabled = useCallback(
    async (checked) => {
      // Hiding the section must not leave the feature silently active behind it:
      // clear auto-start and stop any running server so there's nothing the user
      // can't see or reach.
      await patchRemoteConfig(checked ? { remoteEnabled: true } : { remoteEnabled: false, serveOnLaunch: false })
      if (!checked && remoteStatus?.running) {
        await window.api.remote.stopServer()
        await refreshRemoteStatus()
      }
    },
    [patchRemoteConfig, remoteStatus, refreshRemoteStatus],
  )

  const handleConnect = useCallback(async () => {
    const trimmed = urlDraft.trim()
    if (!trimmed) return
    setUrlDraft(trimmed)
    await patchRemoteConfig({ connectUrl: trimmed })
    const url = normalizeConnectUrl(trimmed)
    if (!url) return
    await window.api.remote.connect(url) // relaunches the app into client mode
  }, [urlDraft, patchRemoteConfig])

  const handleDisconnect = useCallback(async () => {
    await window.api.remote.disconnect() // relaunches back into local mode (also disarms auto-connect)
  }, [])

  const handleToggleAutoConnect = useCallback(
    async (checked) => {
      if (!checked) {
        // Disarming keeps the address, so the field still offers it next time.
        await patchRemoteConfig({ autoconnect: false })
        return
      }
      const trimmed = urlDraft.trim()
      if (!normalizeConnectUrl(trimmed)) {
        toast('Enter a server address first', 'error')
        return
      }
      setUrlDraft(trimmed)
      await patchRemoteConfig({ connectUrl: trimmed, autoconnect: true })
    },
    [urlDraft, patchRemoteConfig],
  )

  const handleToggleClientAutoConnect = useCallback(
    async (checked) => {
      await patchRemoteConfig({ connectUrl: window.api.remote.url, autoconnect: checked })
    },
    [patchRemoteConfig],
  )

  const auxDirs = libDirs.aux
  const offloadAuxDirs = useMemo(() => auxDirs.filter((d) => !d.archive), [auxDirs])

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[640px] mx-auto py-8 px-6 space-y-6">
        <h1 className={TITLE_PAGE}>Settings</h1>

        {/* Library */}
        <Section title="Library">
          <div>
            <div className={cn(LABEL, 'flex items-center gap-1.5 mb-2')}>
              <HardDrive size={14} className="text-text-tertiary" />
              VaM Directory
            </div>
            <div className="flex items-center gap-2">
              <TruncateWithTooltip
                text={vamDir || ''}
                className="flex-1 min-w-0 h-10 bg-elevated border border-border rounded-lg px-3 flex items-center text-xs text-text-secondary font-mono truncate select-text cursor-text"
              >
                {vamDir || <span className="italic text-text-placeholder font-sans">Not configured</span>}
              </TruncateWithTooltip>
              <Button variant="outline" size="lg" onClick={handleBrowseDir} className="shrink-0 h-10 px-3.5">
                <FolderOpen size={14} /> Browse
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {/* One feature, not two. Archive is an offload folder with the pruning
                upgrade switched on, so the section is framed as offloading and
                archive is introduced as something a folder can additionally do —
                a symmetric Offload-vs-Archive presentation made the shared 90%
                (move packages somewhere VaM won't load them) look like a fork. */}
            <SettingRow
              label="Offload folders"
              description="Folders outside AddonPackages that VaM never loads. Packages parked there stay in your library and come back in one click."
            />
            {/* Registered folders, detected candidates and the add action are one
                bordered object: they are the same list at three stages, and pulling
                Add out into the header made it compete with per-row state. */}
            <div className="rounded-lg border border-border bg-surface/50 divide-y divide-border overflow-hidden">
              {auxDirs.length === 0 && (
                // The one place archive has to be discovered, since the Archived
                // shelf is gated on a folder having it on. Offloading itself is
                // already defined in the header above, so this says the one thing
                // that header can't: any of these folders can go further.
                <div className="px-3 py-3 space-y-2">
                  {/* pb-0.5 on top of space-y-2: deliberate 2px nudge before the button. */}
                  <p className={cn(BODY_DENSE, 'pb-0.5')}>
                    No folders yet. Any folder you add can also be an <span className={EMPHASIS}>Archive</span>: cold
                    storage that lets you drop the dependencies the Hub can re-download and fetches them back when you
                    install the package again from the archive, so a hoard costs a fraction of the disk.
                  </p>
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => void handleAddAuxDir()}
                    disabled={libDirsBusy === 'add'}
                    className="text-xs"
                  >
                    {libDirsBusy === 'add' ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                    Add folder
                  </Button>
                </div>
              )}
              {auxDirs.map((d) => (
                <AuxDirRow
                  key={d.id}
                  d={d}
                  vamDir={vamDir}
                  disabled={libDirsBusy === d.id}
                  disableBehavior={disableBehavior}
                  showBrowserAssist={baDirPresent}
                  onRemove={handleRemoveAuxDir}
                  onToggleBrowserAssist={handleToggleBrowserAssist}
                  onSetRole={handleSetRole}
                />
              ))}
              {offloadSuggestions
                .filter((s) => !dismissedOffload.has(s.id))
                .map((s) => (
                  <SuggestionRow
                    key={s.id}
                    s={s}
                    vamDir={vamDir}
                    disabled={libDirsBusy === 'add'}
                    onAdd={handleAddSuggestion}
                    onDismiss={dismissOffloadSuggestion}
                  />
                ))}
              {/* Only once there is a list to append to. The empty state ends with
                  its own button, in the same shape the rest of Settings uses. */}
              {auxDirs.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleAddAuxDir()}
                  disabled={libDirsBusy === 'add'}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary cursor-pointer hover:bg-hover hover:text-text-primary disabled:cursor-progress disabled:opacity-60 disabled:hover:bg-transparent transition-colors"
                >
                  {/* No color of its own: the icon is part of the button's label, so it has to
                      track the hover brighten instead of staying pinned to a dim tone. */}
                  {libDirsBusy === 'add' ? (
                    <Loader2 size={14} className="shrink-0 animate-spin" />
                  ) : (
                    <Plus size={14} className="shrink-0" />
                  )}
                  Add folder…
                </button>
              )}
            </div>
          </div>

          {offloadAuxDirs.length > 0 && (
            <SettingRow
              as="div"
              label="When disabling a package"
              description="Either use VaM's native disable behavior, or move the package to an offload directory."
            >
              <Select value={disableBehavior} onValueChange={handleDisableBehaviorChange}>
                <SelectTrigger
                  className="shrink-0 min-w-[180px] max-w-[240px] h-9 text-xs"
                  title={getDisableBehaviorTooltip(disableBehavior, offloadAuxDirs)}
                >
                  <SelectValue>
                    <span className="block min-w-0 truncate">
                      {getDisableBehaviorLabel(disableBehavior, offloadAuxDirs)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-w-[420px]">
                  <SelectItem value="suffix">VaM native (.var.disabled marker)</SelectItem>
                  {offloadAuxDirs.map((d) => (
                    <SelectItem key={d.id} value={disableBehaviorMoveTo(d.id)} title={d.path}>
                      <span className="block min-w-0 truncate">Move to {shortenLibraryPath(d.path, vamDir)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          )}

          <div className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center gap-3 text-xs">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 flex-1">
                <StatRow label="Packages total" value={stats.totalCount ?? 0} />
                <StatRow label="Installed" value={stats.directCount ?? 0} />
                <StatRow label="Dependencies" value={stats.depCount ?? 0} />
                <StatRow label="Content items" value={stats.totalContent ?? 0} />
                <StatRow label="Total size" value={formatBytes(stats.totalSize ?? 0)} />
                {stats.brokenCount > 0 && <StatRow label="Broken" value={stats.brokenCount} warn />}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="gradient"
                      size="lg"
                      onClick={handleRescan}
                      disabled={scanning || verifying || hubScanning || !vamDir}
                      className="text-xs"
                    >
                      {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                      {scanning ? 'Scanning…' : 'Rescan Library'}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" prose>
                  {RESCAN_LIBRARY_HINT}
                </TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleVerifyIntegrity}
                      disabled={verifying || scanning || hubScanning || !vamDir}
                      className="text-xs"
                    >
                      {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                      {verifying ? 'Verifying…' : 'Verify Integrity'}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" prose>
                  {VERIFY_INTEGRITY_HINT}
                </TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleHubScan}
                      disabled={hubScanning || scanning || verifying || !vamDir}
                      className="text-xs"
                    >
                      {hubScanning ? <Loader2 size={14} className="animate-spin" /> : <Compass size={14} />}
                      {hubScanning ? 'Scanning Hub…' : 'Scan Hub Details'}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" prose>
                  {SCAN_HUB_DETAILS_HINT}
                </TooltipContent>
              </Tooltip>
              <Button variant="outline" size="lg" onClick={handleOpenApplicationFolder} className="text-xs">
                <FolderOpen size={14} /> Show in folder
              </Button>
            </div>
            {hubScanning && hubScanProgress && (
              <div className={META_DENSE}>
                Scanning {hubScanProgress.current} / {hubScanProgress.total}
                {hubScanProgress.found != null && (
                  <span className="ml-1.5 text-text-tertiary">
                    · {hubScanProgress.found} on Hub
                    {hubScanProgress.phase === 'fetching' && ' · fetching details'}
                  </span>
                )}
              </div>
            )}
            {verifying && verifyProgress && (
              <div className={META_DENSE}>
                Checking {verifyProgress.step} / {verifyProgress.total}
                {verifyProgress.filename && (
                  <span className="ml-1.5 text-text-tertiary select-text cursor-text">{verifyProgress.filename}</span>
                )}
              </div>
            )}
            <ResultBanner result={scanResult} details={scanResult?.corruptedFiles} mono />
          </div>
        </Section>

        <Section title="Behavior" description="How packages and content are managed.">
          <div className="space-y-5">
            <AutoHideSwitch
              settingKey="auto_hide_deps"
              label="Auto-hide dependency content"
              description="Keep content from dependency packages out of your VaM browser so only the packages you installed show. Turning this off offers to bring everything back."
              descriptionWhenOff="Keep content from dependency packages out of your VaM browser so only the packages you installed show. Turning this on offers to also hide the dependency content you already have."
              apply={() => window.api.scan.applyAutoHide('deps')}
              remove={() => window.api.scan.removeAutoHide('deps')}
              hideTitle="Hide dependency content?"
              unhideTitle="Unhide dependency content?"
              progressNoun="dependency content"
              hideBody={
                <>
                  <p>Dependency content from packages you add going forward will be kept out of VaM automatically.</p>
                  <p>
                    Want to tidy your existing library too? Choose{' '}
                    <strong className="text-text-primary">Turn on and hide all</strong> to also hide content from the
                    dependency packages you already have. Choose <strong className="text-text-primary">Turn on</strong>{' '}
                    to apply going forward only.
                  </p>
                  <p>Nothing is deleted — this only changes what VaM shows, and you can undo it here anytime.</p>
                </>
              }
              unhideBody={
                <>
                  <p>Turning off stops hiding dependency content from packages you add going forward.</p>
                  <p>
                    Choose <strong className="text-text-primary">Turn off and unhide all</strong> to also bring back
                    everything currently hidden by this rule. Choose{' '}
                    <strong className="text-text-primary">Turn off</strong> to keep existing items hidden.
                  </p>
                  <p>Items still claimed by another active auto-hide rule will stay hidden.</p>
                </>
              }
            />
            <AutoHideForeignSwitch
              ruleId="foreign_hair"
              category="Hairstyles"
              settingKey="auto_hide_foreign_hair"
              label="Auto-hide hairstyles from non-hairstyle packages"
              description="Hide hairstyle items bundled inside packages categorized as something else (e.g. a clothing or scene pack that ships an extra hair)."
              noun="hairstyles"
            />
            <AutoHideForeignSwitch
              ruleId="foreign_poses"
              category="Poses"
              settingKey="auto_hide_foreign_poses"
              label="Auto-hide poses from non-pose packages"
              description="Hide pose items bundled inside packages categorized as something else, so only purpose-built pose packs surface in the Poses view."
              noun="poses"
            />
            <AutoHideForeignSwitch
              ruleId="foreign_clothing"
              category="Clothing"
              settingKey="auto_hide_foreign_clothing"
              label="Auto-hide clothing from non-clothing packages"
              description="Hide clothing items bundled inside packages categorized as something else, so only dedicated clothing packs surface in the Clothing view."
              noun="clothing items"
            />
            {!isRemoteClient && (
              <SettingRow
                as="label"
                label="Move files when dragging them in"
                description="Drag-and-drop moves packages into your library instead of copying them, so the originals are removed."
              >
                <Switch checked={moveOnImport} onCheckedChange={handleToggleMoveOnImport} />
              </SettingRow>
            )}
            <SettingRow
              as="label"
              title={remoteSectionForced ? "Can't be hidden while a client/host connection is active." : undefined}
              label="Client-server mode"
              description="Show the network options for using one library from several devices. Leave off if you only run this app on a single PC."
            >
              <Switch
                checked={remoteEnabled || remoteSectionForced}
                disabled={remoteSectionForced}
                onCheckedChange={handleToggleRemoteEnabled}
              />
            </SettingRow>
          </div>
        </Section>

        {(remoteEnabled || remoteSectionForced) && (
          <Section
            title="Client-server mode"
            icon={Network}
            description="Use one library from several devices. Run this app on the PC that stores your library (the host), then point another device on the same network at it to browse and manage that library remotely."
          >
            {isRemoteClient ? (
              <div className="space-y-5">
                <SettingRow
                  icon={<PlugZap size={14} className="text-accent-blue shrink-0" />}
                  label="Running as remote client"
                  description={window.api.remote.url}
                  descriptionClassName="select-text cursor-text font-mono break-all"
                >
                  <Button variant="outline" size="lg" onClick={handleDisconnect} className="shrink-0 text-xs">
                    <Plug size={14} /> Disconnect
                  </Button>
                </SettingRow>
                <SettingRow
                  as="label"
                  className="border-t border-border pt-4"
                  label="Reconnect on launch"
                  description="Connect to this host automatically each time the app starts. Disconnecting turns this off."
                >
                  <Switch checked={autoConnectArmed} onCheckedChange={handleToggleClientAutoConnect} />
                </SettingRow>
              </div>
            ) : (
              <div className="space-y-4">
                {!remoteWarningDismissed && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg text-[11px] bg-warning/10 border border-warning/20 text-warning">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span className="flex-1 min-w-0">
                      No login, encryption, or access control — anyone who can reach the host can view and change its
                      library. Only use this on a network you trust.
                    </span>
                    <button
                      type="button"
                      onClick={dismissRemoteWarning}
                      title="Dismiss"
                      className="shrink-0 -mt-0.5 -mr-0.5 text-warning hover:text-warning cursor-pointer"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <div className="flex-1 min-w-0" title={HOST_SERVE_TOOLTIP}>
                    <div className={cn(LABEL, 'flex items-center gap-1.5')}>
                      <Network size={14} className="text-text-tertiary shrink-0" />
                      Host this library
                    </div>
                    <div className={cn(CLARIFY_DENSE, 'mt-0.5')}>
                      {remoteStatus?.running ? (
                        <>
                          Reachable at{' '}
                          <span
                            className="select-text cursor-text"
                            title={getLocalReachabilityTooltip(localIps, remoteStatus.port)}
                          >
                            <span className="font-mono text-text-secondary">
                              {localIps.primary || 'this-pc'}
                              {remoteStatus.port === DEFAULT_REMOTE_PORT ? '' : `:${remoteStatus.port}`}
                            </span>
                            {localIps.all.length > 1 && ` (+${localIps.all.length - 1} more)`}
                          </span>{' '}
                          · {remoteStatus.clients} client{remoteStatus.clients === 1 ? '' : 's'} connected
                        </>
                      ) : (
                        'Run this on the PC that holds your library so other devices can connect to it.'
                      )}
                    </div>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={portDraft}
                    onChange={(e) => setPortDraft(e.target.value.replace(/[^\d]/g, ''))}
                    disabled={remoteStatus?.running}
                    placeholder={String(DEFAULT_REMOTE_PORT)}
                    title={`Network port other devices connect to (default ${DEFAULT_REMOTE_PORT}).`}
                    className="w-20 h-9 bg-elevated border border-border rounded-lg px-2.5 text-xs text-text-secondary font-mono disabled:opacity-50"
                  />
                  {remoteStatus?.running ? (
                    <Button variant="outline" size="lg" onClick={handleStopServer} className="shrink-0 text-xs">
                      Stop
                    </Button>
                  ) : (
                    <Button variant="outline" size="lg" onClick={handleStartServer} className="shrink-0 text-xs">
                      Start
                    </Button>
                  )}
                </div>

                <SettingRow
                  as="label"
                  title={HOST_SERVE_TOOLTIP}
                  label="Start server on launch"
                  description="Automatically start hosting on the port above each time you open VaM Backstage."
                >
                  <Switch checked={serveOnLaunch} onCheckedChange={handleToggleServeOnLaunch} />
                </SettingRow>

                <div className="flex items-end gap-2 border-t border-border pt-4">
                  <div
                    className="flex-1 min-w-0"
                    title="To launch straight into client mode, start with --connect=<host> (or set VAM_CONNECT)."
                  >
                    <div className={cn(LABEL, 'flex items-center gap-1.5')}>
                      <PlugZap size={14} className="text-text-tertiary shrink-0" />
                      Connect to a host
                    </div>
                    <div className={cn(CLARIFY_DENSE, 'mt-0.5')}>
                      From another device, enter the host&apos;s address (e.g. its IP, like 192.168.1.5) to use its
                      library here. The app relaunches as a client.
                    </div>
                  </div>
                  <input
                    type="text"
                    value={urlDraft}
                    onChange={(e) => setUrlDraft(e.target.value)}
                    placeholder="192.168.1.5"
                    className="w-44 h-9 bg-elevated border border-border rounded-lg px-2.5 text-xs text-text-secondary font-mono"
                  />
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={handleConnect}
                    disabled={!urlDraft.trim()}
                    className="shrink-0 text-xs"
                  >
                    <Plug size={14} /> Connect
                  </Button>
                </div>

                <SettingRow
                  as="label"
                  label="Connect on launch"
                  description="Start as a client pointed at the address above every time the app opens. Disconnecting from the connection screen turns this off."
                >
                  <Switch checked={autoConnectArmed} onCheckedChange={handleToggleAutoConnect} />
                </SettingRow>
              </div>
            )}
          </Section>
        )}

        <Section title="Display" description="Control how library content appears.">
          <div className="space-y-5">
            <SettingRow
              as="label"
              label="Blur thumbnails"
              description="Apply a blur to all package and content thumbnails and author avatars to keep it SFW."
            >
              <Switch checked={blurThumbnails} onCheckedChange={setBlurThumbnails} />
            </SettingRow>
            <SettingRow
              as="label"
              label="Dim inactive packages"
              description="When ON, disabled and offloaded packages are greyed out with a small corner icon. When OFF, they render at full color with an informational chip (handy if a large part of your library is archived)."
            >
              <Switch checked={dimInactive} onCheckedChange={setDimInactive} />
            </SettingRow>
            <SettingRow
              as="label"
              label="Skip confirmation when disabling packages"
              description="When ON, disabling a package that has dependents or cascade-disabled deps runs immediately with no confirmation dialog."
            >
              <Switch checked={suppressDisablePackageWarning} onCheckedChange={setSuppressDisablePackageWarning} />
            </SettingRow>
          </div>
        </Section>

        {(hubLoggedIn || baDirPresent) && (
          <Section
            title="Experimental"
            icon={FlaskConical}
            description="Early features that may change or be removed. Feedback welcome."
          >
            <div className="space-y-4">
              {hubLoggedIn && (
                <div className="space-y-3">
                  <SettingRow
                    label="Import Hub lists to wishlist"
                    description="Reads your Hub favorites or bookmarks and adds them to the local wishlist. Already-wishlisted items are skipped."
                  />
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => void handleImportHubListToWishlist('favorites')}
                        disabled={!!wishlistImporting}
                        className="shrink-0 gap-2 text-xs"
                      >
                        {wishlistImporting === 'favorites' ? (
                          <Loader2 size={14} className="animate-spin shrink-0" />
                        ) : (
                          <Heart size={14} className="shrink-0" />
                        )}
                        {wishlistImporting === 'favorites' ? 'Importing favorites…' : 'Import favorites to wishlist'}
                      </Button>
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => void handleImportHubListToWishlist('bookmarks')}
                        disabled={!!wishlistImporting}
                        className="shrink-0 gap-2 text-xs"
                      >
                        {wishlistImporting === 'bookmarks' ? (
                          <Loader2 size={14} className="animate-spin shrink-0" />
                        ) : (
                          <Bookmark size={14} className="shrink-0" />
                        )}
                        {wishlistImporting === 'bookmarks' ? 'Importing bookmarks…' : 'Import bookmarks to wishlist'}
                      </Button>
                    </div>
                    {wishlistImportProgress && wishlistImporting && (
                      <div className={cn(META_DENSE, 'select-text cursor-text')}>
                        {formatWishlistImportProgress(wishlistImportProgress)}
                      </div>
                    )}
                    <ResultBanner result={wishlistImportResult} />
                  </div>
                </div>
              )}

              {baDirPresent && (
                <div className={`space-y-3 ${hubLoggedIn ? 'border-t border-border pt-4' : ''}`}>
                  <SettingRow
                    label="Sync with BrowserAssist"
                    description="Write User tags (scene-real / scene-look / scene-other) plus user-defined Labels into JayJayWon BrowserAssist settings — package Labels onto package rows, and content Labels (own + inherited from package) onto matching resources in this app's library."
                  />
                  <div className="space-y-3">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleSyncBrowserAssist}
                      disabled={baSyncing}
                      className="shrink-0 gap-2 text-xs"
                    >
                      {baSyncing ? (
                        <Loader2 size={14} className="animate-spin shrink-0" />
                      ) : (
                        <RefreshCw size={14} className="shrink-0" />
                      )}
                      {baSyncing ? 'Syncing…' : 'Sync with BrowserAssist'}
                    </Button>
                    <ResultBanner result={baSyncResult} />
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {showDevSection && (
          <Section
            title="Developer"
            icon={Wrench}
            danger
            description="Debug logging and database tools. In release builds, tap the app version below seven times to show this section."
          >
            <div className="space-y-5">
              {developerUnlocked && !isDev && (
                <SettingRow
                  as="label"
                  icon={<CurlyBraces size={14} className="text-text-tertiary shrink-0" />}
                  label="Developer options unlocked"
                  description="Turn off to hide this section again (tap the version seven times to re-enable)."
                >
                  <Switch
                    checked
                    onCheckedChange={(on) => {
                      if (!on) void handleDisableDeveloperOptions()
                    }}
                  />
                </SettingRow>
              )}
              <SettingRow
                as="div"
                icon={<FlaskConical size={14} className="text-text-tertiary shrink-0" />}
                label="Update channel"
                description={
                  updateChannel === 'dev'
                    ? 'Pulls ephemeral builds from the latest master commit. Unstable; may contain bugs or in-progress features. Downgrades are not supported — stable updates resume only once a stable release is newer than your current dev build.'
                    : 'Stable releases only. Switch to Dev to receive ephemeral builds from master (unstable, no downgrade path).'
                }
              >
                <Select value={updateChannel} onValueChange={handleChannelChange}>
                  <SelectTrigger className="shrink-0 min-w-[110px]" aria-label="Update channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stable">Stable</SelectItem>
                    <SelectItem value="dev">Dev (unstable)</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                as="label"
                icon={<Bug size={14} className="text-text-tertiary shrink-0" />}
                label="Debug log Hub requests"
                description="Print Hub API request and response bodies to the main process console."
              >
                <Switch checked={hubDebugRequests} onCheckedChange={handleToggleHubDebug} />
              </SettingRow>

              <SettingRow
                as="label"
                icon={<Compass size={14} className="text-text-tertiary shrink-0" />}
                label="Offline Hub catalog"
                description="Adds an Offline tab in Hub that can download the full package list for local filtering. For development only."
              >
                <Switch checked={offlineCatalogEnabled} onCheckedChange={handleToggleOfflineCatalog} />
              </SettingRow>

              <div className="border-t border-border pt-4 flex flex-wrap items-center gap-3">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="lg"
                      disabled={deletedData.packages === 0 && deletedData.contentLabels === 0}
                      className="shrink-0 gap-2 text-xs"
                    >
                      <Trash2 size={14} className="shrink-0" />
                      Forget deleted data{deletedData.packages > 0 ? ` (${deletedData.packages})` : ''}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="select-text cursor-text">Forget deleted data?</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-2">
                          <p>
                            The app keeps the identity and settings (hub link, labels, type override, content
                            visibility) of {deletedData.packages} package{deletedData.packages === 1 ? '' : 's'} whose
                            file{deletedData.packages === 1 ? ' is' : 's are'} no longer on disk, so they are restored
                            if the file reappears (moved back, restored from a backup, or a remounted drive)
                            {deletedData.contentLabels > 0
                              ? `, plus ${deletedData.contentLabels} label${deletedData.contentLabels === 1 ? '' : 's'} on content that a package update has since removed`
                              : ''}
                            .
                          </p>
                          <p>
                            This permanently discards that remembered data to reclaim database space. Packages and
                            content still on disk are not affected.
                          </p>
                          <p className="font-medium text-warning">This cannot be undone.</p>
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={handleForgetDeleted}>
                        Forget
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="lg"
                      className="shrink-0 gap-2 text-xs text-error border-error/30 hover:bg-error/10"
                    >
                      <Trash2 size={14} className="shrink-0" />
                      Nuke database and exit
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="select-text cursor-text">Nuke local database?</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-2">
                          <p>
                            This deletes the app&apos;s SQLite database (packages, contents, downloads metadata, and
                            settings) and quits. Your AddonPackages folder is not touched.
                          </p>
                          <p className="font-medium text-warning">This cannot be undone.</p>
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={handleNukeDatabase}>
                        Nuke and exit
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </Section>
        )}

        {/* About */}
        <div className="pt-4 border-t border-border">
          <div className={cn(META_DENSE, 'space-y-1')}>
            {/* A version string presented as selectable text; the button is only a hidden tap
                target, so this is metadata rather than a control's resting state. */}
            <button
              type="button"
              onClick={handleAboutVersionTap}
              className="select-text cursor-text text-left w-full p-0 m-0 border-0 bg-transparent font-inherit text-text-tertiary"
            >
              VaM Backstage v{appVersion ? `${appVersion} Beta` : '—'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, description, danger, icon: Icon, children }) {
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      {danger && (
        <div
          aria-hidden
          className="h-2"
          style={{
            backgroundImage:
              'repeating-linear-gradient(-45deg, color-mix(in oklab, var(--color-warning) 55%, transparent) 0 10px, transparent 10px 20px)',
          }}
        />
      )}
      <div className="p-4 space-y-4">
        <div>
          <h2 className={cn(TITLE_SECTION, 'flex items-center gap-2')}>
            {Icon && <Icon size={16} className="text-text-tertiary shrink-0" />}
            {title}
          </h2>
          {description && <p className={cn(BODY_DENSE, 'mt-1')}>{description}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Result callout with error / warning / success / info tones plus an optional detail list.
 *
 * The detail list is the clarification tier of the banner's own body: one size step down,
 * same tone color. It used to be dimmed with `opacity-80` / `opacity-90` — two values for
 * one role — which fakes a tier the palette does not have.
 *
 * `mono` is for lists of file paths, where alignment and truncation matter more than rhythm.
 */
function ResultBanner({ result, details, mono }) {
  if (!result) return null
  const list = details ?? result.warnings
  const hasList = list?.length > 0
  const tone = result.error
    ? 'bg-error/10 border border-error/20 text-error'
    : hasList
      ? 'bg-warning/10 border border-warning/20 text-warning'
      : result.success
        ? 'bg-success/10 border border-success/20 text-success'
        : 'bg-accent-blue/10 border border-accent-blue/20 text-accent-blue'
  const Icon = result.error || hasList ? AlertTriangle : result.success ? CheckCircle : HardDrive
  return (
    <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${tone}`}>
      <Icon size={14} className="shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="select-text cursor-text">{result.error || result.success || result.info}</span>
        {hasList && (
          <ul className={cn('mt-1 space-y-0.5 text-[11px]', mono && 'font-mono')}>
            {list.map((d, i) => (
              <li key={`${i}:${d}`} className={cn('select-text cursor-text', mono && 'truncate')}>
                · {d}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * A registered aux directory row (offload or archive). The mode toggle applies
 * instantly on an empty folder — nothing to reclassify, so nothing to warn about
 * — and confirms first once the folder holds packages. Empty dirs remove
 * immediately; dirs with packages warn about what un-registering forgets.
 *
 * Two lines: identity plus the one primary control, then a single dim run of
 * everything secondary. Anything rarer than the mode (BrowserAssist, removal)
 * lives in the overflow menu, which also spares archive rows an inert toggle.
 */
function AuxDirRow({
  d,
  vamDir,
  disabled,
  disableBehavior,
  showBrowserAssist,
  onRemove,
  onToggleBrowserAssist,
  onSetRole,
}) {
  const hasPackages = d.packageCount > 0
  // Only surface the BrowserAssist toggle to users who actually run BrowserAssist
  // (its data dir was detected). Still show it when the dir already has the mode on,
  // so a stray enabled flag can always be turned back off even if detection fails.
  const canBrowserAssist = showBrowserAssist || !!d.browserAssist
  const role = d.archive ? 'archive' : 'offload'
  const RoleIcon = d.archive ? Boxes : FolderInput
  const [pendingRole, setPendingRole] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const targetRole = pendingRole
  const parsedDisable = parseDisableBehavior(disableBehavior)
  const disablePointsHere = parsedDisable.kind === 'move-to' && parsedDisable.auxDirId === d.id

  const requestRole = (next) => {
    if (disabled || next === role) return
    if (hasPackages) setPendingRole(next)
    else onSetRole(d.id, next)
  }

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2.5">
        <RoleIcon size={14} className="shrink-0 text-text-tertiary" />
        <TruncateWithTooltip
          text={d.path}
          className="flex-1 min-w-0 text-xs font-mono truncate select-text cursor-text text-text-secondary"
        >
          {shortenLibraryPath(d.path, vamDir)}
        </TruncateWithTooltip>
        <ArchiveSwitch
          archived={d.archive}
          disabled={disabled}
          onRequest={(next) => requestRole(next ? 'archive' : 'offload')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              title="Folder options"
              className="shrink-0 text-text-aside hover:text-text-primary"
            >
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {canBrowserAssist && (
              <>
                {/* Label short enough to belong in a menu; the explanation is a
                    tooltip, because a menu item that needs a paragraph under it
                    has stopped being a menu item. */}
                <Tooltip delayDuration={300} disableHoverableContent>
                  <TooltipTrigger asChild>
                    <DropdownMenuCheckboxItem
                      checked={!!d.browserAssist}
                      disabled={d.archive}
                      onCheckedChange={(v) => onToggleBrowserAssist(d.id, v)}
                    >
                      Share with BrowserAssist
                    </DropdownMenuCheckboxItem>
                  </TooltipTrigger>
                  <TooltipContent side="left" prose>
                    {d.archive
                      ? 'Offload folders only. BrowserAssist never handles archived packages. Turn Archive off for this folder to change the setting.'
                      : BROWSER_ASSIST_HINT}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => (hasPackages ? setConfirmRemove(true) : onRemove(d.id))}
            >
              <Trash2 size={12} />
              Remove folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Facts about this folder, nothing else. The mode used to append its own
          one-liner here, which read as a fourth statistic — the eye can't tell
          "48.2 GB" and "nothing pruned" apart when they share a separator. */}
      <div className={cn(META_DENSE, 'pl-6 mt-0.5 truncate')}>
        <span className="tabular-nums">
          {d.packageCount.toLocaleString()} package{d.packageCount === 1 ? '' : 's'} · {formatBytes(d.sizeBytes)}
        </span>
        {d.browserAssist && (
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <span className="cursor-help"> · shared with BrowserAssist</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" prose>
              {BROWSER_ASSIST_HINT}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="select-text cursor-text">
              Stop tracking this {d.archive ? 'archive' : 'offload'} directory?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="leading-relaxed space-y-2.5">
                <p>
                  <span className="font-mono text-text-emphasis select-text cursor-text">
                    {shortenLibraryPath(d.path, vamDir)}
                  </span>{' '}
                  currently holds{' '}
                  <span className={EMPHASIS}>
                    {d.packageCount.toLocaleString()} package{d.packageCount === 1 ? '' : 's'}
                  </span>
                  . Removing it un-registers the folder and hides those packages from Backstage.
                </p>
                <p>
                  <span className="font-medium text-success">No files are deleted</span>: every{' '}
                  <span className="font-mono">.var</span> stays where it is on disk, and VaM&apos;s own state for those
                  packages (including the <span className="font-medium">favorite</span> and{' '}
                  <span className="font-medium">hidden</span> status of their content) is untouched.
                </p>
                <p>
                  <span className="font-medium text-success">Your Backstage data is kept</span>: the labels and category
                  overrides you set are remembered, and re-adding the folder later restores them along with the
                  packages.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onRemove(d.id, { force: true })}>
              Remove folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingRole} onOpenChange={(open) => !open && setPendingRole(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="select-text cursor-text">
              Turn Archive {targetRole === 'archive' ? 'on' : 'off'} for this folder?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="leading-relaxed space-y-2.5">
                <p>
                  <span className="font-mono text-text-emphasis select-text cursor-text">
                    {shortenLibraryPath(d.path, vamDir)}
                  </span>{' '}
                  holds{' '}
                  <span className={EMPHASIS}>
                    {d.packageCount.toLocaleString()} package{d.packageCount === 1 ? '' : 's'}
                  </span>
                  , and all of them change state with the folder.
                </p>
                {targetRole === 'offload' ? (
                  <p>
                    They become <span className={EMPHASIS}>offloaded</span>: they reappear in your default library views
                    and start reporting their missing dependencies again, so expect the Missing list to grow.
                  </p>
                ) : (
                  <p>
                    They become <span className={EMPHASIS}>archived</span>: they drop out of your default library views
                    and the Missing tab, and the app stops prompting to download their dependencies.
                  </p>
                )}
                <p>
                  <span className="font-medium text-success">No files are moved or deleted.</span>
                  {targetRole === 'archive' &&
                    ' No dependencies are removed either; that only happens when you archive an individual package.'}
                </p>
                {targetRole === 'archive' && disablePointsHere && (
                  <p className={CLARIFY}>
                    &ldquo;Disable → move here&rdquo; currently points at this folder and will revert to VaM native.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (targetRole) onSetRole(d.id, targetRole)
                setPendingRole(null)
              }}
            >
              Turn Archive {targetRole === 'archive' ? 'on' : 'off'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * A detected-but-unregistered offload candidate, shaped like the rows it would
 * join. Both text lines clip: `truncate` needs a block box, and the path span is
 * inline here (unlike in `AuxDirRow`, where being a flex child blocks it), so
 * without it long paths ran on underneath the buttons.
 */
function SuggestionRow({ s, vamDir, disabled, onAdd, onDismiss }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-accent-blue/6">
      <Compass size={14} className="shrink-0 text-accent-blue" />
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <div className="min-w-0 flex-1">
            <TruncateWithTooltip
              text={s.path}
              className="block min-w-0 text-xs font-mono truncate select-text cursor-text text-text-secondary"
            >
              {shortenLibraryPath(s.path, vamDir)}
            </TruncateWithTooltip>
            <div className={cn(CLARIFY_DENSE, 'truncate')}>
              {s.label}&apos;s offload folder · {s.varCount.toLocaleString()} var{s.varCount === 1 ? '' : 's'} found
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" prose>
          Backstage found the default offload folder of a tool you have installed, and it already holds packages. Adding
          it registers the folder as Offload: no files move and nothing is deleted.
        </TooltipContent>
      </Tooltip>
      <Button variant="outline" size="sm" onClick={() => onAdd(s)} disabled={disabled} className="shrink-0">
        Add
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => onDismiss(s.id)}
        title="Dismiss suggestion"
        className="shrink-0 text-text-aside hover:text-text-primary"
      >
        <X size={14} />
      </Button>
    </div>
  )
}

/**
 * Archive as a switch on an offload folder, not as the far half of a two-sided
 * mode picker: it is the same folder either way, with pruning and cold-storage
 * semantics turned on. A real `<label>` so clicking the word still toggles,
 * without the pointer cursor and hover tint that made plain text read as a
 * second, differently-behaved control next to the switch.
 */
function ArchiveSwitch({ archived, disabled, onRequest }) {
  const id = useId()
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <span className="shrink-0 flex items-center gap-1.5">
          <label
            htmlFor={id}
            className={`text-[11px] select-none ${disabled ? 'opacity-50' : ''} ${
              archived ? 'text-text-primary font-medium' : 'text-text-aside'
            }`}
          >
            Archive
          </label>
          <Switch
            id={id}
            size="sm"
            checked={archived}
            onCheckedChange={onRequest}
            disabled={disabled}
            aria-label="Archive folder"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="w-72 flex-col items-start gap-0 py-2 text-left">
        <ArchiveSummary />
      </TooltipContent>
    </Tooltip>
  )
}

const ARCHIVE_FACTS = [
  'Archiving a package offers to drop the dependencies nothing else needs',
  'Only ones the Hub can re-download; the rest are stored, never deleted',
  'Installing from the archive fetches back whatever you dropped',
  'Contents sit out of your library views and never prompt for missing deps',
]

/**
 * What turning Archive on buys, on the switch's own hover rather than in the
 * rows: whether a folder archives is a property of it, not news about it, so
 * restating it on every row taxes the readers who already know while still
 * being too terse to teach the ones who don't.
 *
 * What the copy has to land is what happens to *dependencies*: offload keeps
 * every byte, archive can trade the Hub-restorable ones for disk and buys them
 * back on install. Archive going quiet about missing deps follows from that
 * bargain — leading with it makes archive sound like a louder offload.
 *
 * Every line is phrased as a thing the folder lets you do, never as a thing it
 * does to you: the deletion is a per-package choice at archive time, and copy
 * that reads as "turning this on starts deleting my dependencies" makes the
 * switch look like a trap when it is the whole point of the feature.
 */
function ArchiveSummary() {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
        <Boxes size={13} className="shrink-0 text-text-tertiary" />
        Archive
      </div>
      <div className={cn(BODY_DENSE, 'mt-0.5')}>
        An offload folder that can also reclaim the disk unneeded dependencies take up.
      </div>
      <ul className={cn(CLARIFY_DENSE, 'mt-1.5 space-y-1')}>
        {ARCHIVE_FACTS.map((fact) => (
          <li key={fact} className="flex gap-1.5">
            <span aria-hidden>·</span>
            <span className="min-w-0">{fact}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Shared by the menu item that sets this and the row marker that reports it.
 *
 * Two things it has to get right. It must not imply Backstage needs the file to
 * find its way home — it never did, and a setting that sounds like "remember where
 * packages came from" is one nobody dares leave off. And it must not open with
 * "sidecar" or ".var.json", which mean nothing to someone who merely *runs*
 * BrowserAssist; the file name comes last, for whoever wants to know what will
 * show up in the folder.
 */
const BROWSER_ASSIST_HINT =
  'Shares this folder with BrowserAssist, so either tool can restore a package the other moved out. Each ' +
  'package offloaded here also gets the small .var.json file BrowserAssist reads. Backstage does not need ' +
  'that file; it tracks its own moves either way.'

const RESCAN_LIBRARY_HINT =
  'Walk every library folder and refresh the package index from what is on disk. Unchanged files are skipped.'

const VERIFY_INTEGRITY_HINT =
  'Open every .var and check its contents against the archive checksums. Flags corrupted packages; does not modify files.'

const SCAN_HUB_DETAILS_HINT =
  'Match your packages to the Hub catalog and pull titles, descriptions, tags, and download metadata into the local library.'

/**
 * Show an offload path that lives inside the VaM dir as `<VaM base dir name>/<relative>`
 * for brevity while keeping context (e.g. `VaM/AllPackages`). Paths outside the VaM
 * dir are returned unchanged.
 */
function shortenLibraryPath(path, vamDir) {
  if (!path || !vamDir) return path
  const strip = (p) => p.replace(/[\\/]+$/, '')
  const v = strip(vamDir)
  const p = strip(path)
  if (p === v) return path
  if (p.startsWith(v + '/') || p.startsWith(v + '\\')) {
    const rel = p.slice(v.length + 1).replace(/\\/g, '/')
    const base = v.split(/[\\/]/).pop() || v
    return base + '/' + rel
  }
  return path
}

function getDisableBehaviorLabel(value, auxDirs) {
  const parsed = parseDisableBehavior(value)
  if (parsed.kind === 'suffix') return 'VaM native'
  const dir = auxDirs.find((d) => d.id === parsed.auxDirId)
  if (!dir) return 'Move to …'
  const parts = dir.path.split(/[\\/]/).filter(Boolean)
  const basename = parts[parts.length - 1] || dir.path
  return `Move to ${basename}`
}

const HOST_SERVE_TOOLTIP =
  'Runs the normal app and hosts at the same time. For a headless server with no window, launch with --serve (or set VAM_SERVE).'

function getLocalReachabilityTooltip(localIps, port) {
  if (localIps.all.length <= 1) return undefined
  return `Enter one of these on the other device:\n${localIps.all.map((a) => `${a.address}:${port} (${a.name})`).join('\n')}`
}

function getDisableBehaviorTooltip(value, auxDirs) {
  const parsed = parseDisableBehavior(value)
  if (parsed.kind === 'suffix') return 'VaM native disable (empty .var.disabled marker beside the package)'
  const dir = auxDirs.find((d) => d.id === parsed.auxDirId)
  return dir ? `Move to ${dir.path}` : undefined
}

function StatRow({ label, value, warn }) {
  return (
    <>
      {/* Secondary, not tertiary: the value beside it is primary, and an aside-toned label
          against a primary value reads as a mismatched pair rather than a hierarchy. */}
      <span className="text-text-secondary">{label}</span>
      <span className={`font-medium ${warn ? 'text-warning' : 'text-text-primary'}`}>{value}</span>
    </>
  )
}
