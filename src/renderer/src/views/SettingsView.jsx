import { useState, useEffect, useCallback, useRef } from 'react'
import {
  FolderOpen,
  RefreshCw,
  HardDrive,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Bug,
  Trash2,
  ShieldCheck,
  Compass,
  FlaskConical,
  CurlyBraces,
} from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { parseDisableBehavior, disableBehaviorMoveTo } from '@shared/disable-behavior.js'
import { toast } from '@/components/Toast'
import { useStatusStore } from '@/stores/useStatusStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TruncateWithTooltip } from '@/components/TruncateWithTooltip'
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
  const [autoHideDeps, setAutoHideDeps] = useState(false)
  const [blurThumbnails, setBlurThumbnails] = useState(false)
  const [hubDebugRequests, setHubDebugRequests] = useState(false)
  const [isDev, setIsDev] = useState(false)
  const [developerUnlocked, setDeveloperUnlocked] = useState(false)
  const devUnlockRef = useRef({ count: 0, resetTimer: null })
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState(null)
  const [hubScanning, setHubScanning] = useState(false)
  const [hubScanProgress, setHubScanProgress] = useState(null)
  const [baSyncing, setBaSyncing] = useState(false)
  const [baSyncResult, setBaSyncResult] = useState(null)
  const [baDirPresent, setBaDirPresent] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateChannel, setUpdateChannel] = useState('stable')
  const [unhideDialogOpen, setUnhideDialogOpen] = useState(false)
  const [unhiding, setUnhiding] = useState(false)
  const [unhideProgress, setUnhideProgress] = useState(null)
  const [hideDialogOpen, setHideDialogOpen] = useState(false)
  const [hiding, setHiding] = useState(false)
  const [hideProgress, setHideProgress] = useState(null)
  const [libDirs, setLibDirs] = useState({ main: '', aux: [] })
  const [libDirsLoading, setLibDirsLoading] = useState(false)
  const [disableBehavior, setDisableBehavior] = useState('suffix')
  const stats = useStatusStore((s) => s.stats)
  const fetchStats = useStatusStore((s) => s.fetchStats)
  const dimInactive = useLibraryStore((s) => s.dimInactive)
  const setDimInactive = useLibraryStore((s) => s.setDimInactive)

  const refreshLibDirs = useCallback(async () => {
    try {
      const r = await window.api.libraryDirs.list()
      setLibDirs(r)
    } catch (err) {
      console.warn('library-dirs:list failed:', err.message)
    }
  }, [])

  useEffect(() => {
    window.api.settings.get('vam_dir').then((v) => setVamDir(v || ''))
    window.api.settings.get('auto_hide_deps').then((v) => setAutoHideDeps(v === '1'))
    window.api.settings.get('blur_thumbnails').then((v) => setBlurThumbnails(v === '1'))
    window.api.settings.get('hub_debug_requests').then((v) => setHubDebugRequests(v === '1'))
    window.api.settings.get('developer_options_unlocked').then((v) => setDeveloperUnlocked(v === '1'))
    window.api.settings.get('disable_behavior').then((v) => setDisableBehavior(v || 'suffix'))
    window.api.dev.isDev().then(setIsDev)
    window.api.app.getVersion().then(setAppVersion)
    window.api.updater.getChannel().then((c) => setUpdateChannel(c === 'dev' ? 'dev' : 'stable'))
    refreshLibDirs()
  }, [refreshLibDirs])

  const handleAddAuxDir = useCallback(async () => {
    if (libDirsLoading) return
    try {
      const browseResult = await window.api.libraryDirs.browse()
      if (browseResult?.cancelled) return
      setLibDirsLoading(true)
      await window.api.libraryDirs.add(browseResult.path)
      await refreshLibDirs()
      fetchStats()
      toast(`Offload directory added: ${browseResult.path}`, 'success')
    } catch (err) {
      toast(`Failed to add directory: ${err.message}`, 'error')
    } finally {
      setLibDirsLoading(false)
    }
  }, [libDirsLoading, refreshLibDirs, fetchStats])

  const handleRemoveAuxDir = useCallback(
    async (id) => {
      if (libDirsLoading) return
      setLibDirsLoading(true)
      try {
        await window.api.libraryDirs.remove(id)
        await refreshLibDirs()
        const next = await window.api.settings.get('disable_behavior')
        setDisableBehavior(next || 'suffix')
        fetchStats()
        toast('Library directory removed', 'success')
      } catch (err) {
        toast(`Failed to remove: ${err.message}`, 'error')
      } finally {
        setLibDirsLoading(false)
      }
    },
    [libDirsLoading, refreshLibDirs, fetchStats],
  )

  const handleDisableBehaviorChange = useCallback(async (value) => {
    setDisableBehavior(value)
    await window.api.settings.set('disable_behavior', value)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!vamDir) {
      setBaDirPresent(false)
    } else {
      window.api.dev.browserAssistDirExists().then((r) => {
        if (!cancelled) setBaDirPresent(!!r?.exists)
      })
    }
    return () => {
      cancelled = true
    }
  }, [vamDir])

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

  const handleTurnOffAutoHideOnly = useCallback(async (e) => {
    e?.preventDefault()
    try {
      await window.api.settings.set('auto_hide_deps', '0')
      setAutoHideDeps(false)
      setUnhideDialogOpen(false)
    } catch (err) {
      toast(`Failed to update setting: ${err.message}`)
    }
  }, [])

  const handleTurnOffAutoHideAndUnhide = useCallback(
    async (e) => {
      e?.preventDefault()
      try {
        await window.api.settings.set('auto_hide_deps', '0')
        setAutoHideDeps(false)
      } catch (err) {
        toast(`Failed to update setting: ${err.message}`)
        return
      }
      setUnhiding(true)
      setUnhideProgress(null)
      let progressCleanup = null
      try {
        progressCleanup = window.api.onApplyAutoHideProgress((data) => {
          setUnhideProgress(data)
        })
        await window.api.scan.removeAutoHide()
        fetchStats()
      } catch (err) {
        toast(`Unhide failed: ${err.message}`, 'error', 5000)
      } finally {
        progressCleanup?.()
        setUnhiding(false)
        setUnhideProgress(null)
        setUnhideDialogOpen(false)
      }
    },
    [fetchStats],
  )

  const handleTurnOnAutoHideOnly = useCallback(async (e) => {
    e?.preventDefault()
    try {
      await window.api.settings.set('auto_hide_deps', '1')
      setAutoHideDeps(true)
      setHideDialogOpen(false)
    } catch (err) {
      toast(`Failed to update setting: ${err.message}`)
    }
  }, [])

  const handleTurnOnAndHide = useCallback(
    async (e) => {
      e?.preventDefault()
      try {
        await window.api.settings.set('auto_hide_deps', '1')
        setAutoHideDeps(true)
      } catch (err) {
        toast(`Failed to update setting: ${err.message}`)
        return
      }
      setHiding(true)
      setHideProgress(null)
      let progressCleanup = null
      try {
        progressCleanup = window.api.onApplyAutoHideProgress((data) => {
          setHideProgress(data)
        })
        await window.api.scan.applyAutoHide()
        fetchStats()
      } catch (err) {
        toast(`Auto-hide failed: ${err.message}`)
      } finally {
        progressCleanup?.()
        setHiding(false)
        setHideProgress(null)
        setHideDialogOpen(false)
      }
    },
    [fetchStats],
  )

  const handleToggleAutoHide = useCallback(async (checked) => {
    if (!checked) {
      setUnhideDialogOpen(true)
      return
    }
    setHideDialogOpen(true)
  }, [])

  const onUnhideDialogOpenChange = useCallback(
    (open) => {
      if (!open && unhiding) return
      setUnhideDialogOpen(open)
    },
    [unhiding],
  )

  const onHideDialogOpenChange = useCallback(
    (open) => {
      if (!open && hiding) return
      setHideDialogOpen(open)
    },
    [hiding],
  )

  const handleToggleBlurThumbnails = useCallback(async (checked) => {
    setBlurThumbnails(checked)
    document.documentElement.toggleAttribute('data-blur-thumbs', checked)
    await window.api.settings.set('blur_thumbnails', checked ? '1' : '0')
  }, [])

  const handleToggleHubDebug = useCallback(async (checked) => {
    setHubDebugRequests(checked)
    await window.api.settings.set('hub_debug_requests', checked ? '1' : '0')
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

  const handleSyncBrowserAssist = useCallback(async () => {
    if (baSyncing || !baDirPresent) return
    setBaSyncing(true)
    setBaSyncResult(null)
    try {
      const res = await window.api.dev.syncBrowserAssist()
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

  const handleOpenApplicationFolder = useCallback(async () => {
    const dbPath = await window.api.settings.getDatabasePath()
    if (dbPath) window.api.shell.showItemInFolder(dbPath)
  }, [])

  const showDevSection = isDev || developerUnlocked

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
    window.api.settings.set('developer_options_unlocked', '1').then(() => {
      setDeveloperUnlocked(true)
      toast('Developer options enabled', 'success', 3000)
    })
  }, [isDev, developerUnlocked])

  const handleDisableDeveloperOptions = useCallback(async () => {
    await window.api.settings.set('developer_options_unlocked', '0')
    setDeveloperUnlocked(false)
    toast('Developer options disabled', 'success', 2500)
  }, [])

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[640px] mx-auto py-8 px-6 space-y-6">
        <h1 className="text-lg font-semibold text-text-primary">Settings</h1>

        {/* Library */}
        <Section title="Library">
          <div>
            <div className="text-sm text-text-primary font-medium flex items-center gap-1.5 mb-2">
              <HardDrive size={14} className="text-text-tertiary" />
              VaM Directory
            </div>
            <div className="flex items-center gap-2">
              <TruncateWithTooltip
                text={vamDir || ''}
                className="flex-1 min-w-0 h-10 bg-elevated border border-border rounded-lg px-3 flex items-center text-xs text-text-secondary font-mono truncate select-text cursor-text"
              >
                {vamDir || <span className="italic text-text-tertiary font-sans">Not configured</span>}
              </TruncateWithTooltip>
              <Button variant="outline" size="lg" onClick={handleBrowseDir} className="shrink-0 h-10 px-3.5">
                <FolderOpen size={14} /> Browse
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary font-medium">Offload directories</div>
                <div className="text-[11px] text-text-tertiary mt-0.5">
                  Folders for packages you want to keep around but not load in VaM.
                </div>
              </div>
              <Button
                variant="outline"
                size="lg"
                onClick={handleAddAuxDir}
                disabled={libDirsLoading}
                className="shrink-0"
              >
                {libDirsLoading ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                Add Folder
              </Button>
            </div>
            {libDirs.aux.length > 0 && (
              <ul className="rounded-lg border border-border divide-y divide-border bg-surface/50">
                {libDirs.aux.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                    <TruncateWithTooltip
                      text={d.path}
                      className="flex-1 min-w-0 text-xs font-mono truncate select-text cursor-text text-text-secondary"
                    />
                    <div className="text-[11px] text-text-tertiary tabular-nums whitespace-nowrap shrink-0">
                      {d.packageCount} pkg · {formatBytes(d.sizeBytes)}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleRemoveAuxDir(d.id)}
                      disabled={libDirsLoading || d.packageCount > 0}
                      title={d.packageCount > 0 ? 'Move all packages out before removing' : 'Remove'}
                      className="shrink-0 text-text-tertiary hover:text-error"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {libDirs.aux.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary font-medium">When disabling a package</div>
                <div className="text-[11px] text-text-tertiary mt-0.5">
                  Either use VaM&apos;s native disable behavior, or move the package to an offload directory.
                </div>
              </div>
              <Select value={disableBehavior} onValueChange={handleDisableBehaviorChange}>
                <SelectTrigger
                  className="shrink-0 min-w-[180px] max-w-[240px] h-9 text-xs"
                  title={getDisableBehaviorTooltip(disableBehavior, libDirs.aux)}
                >
                  <SelectValue>
                    <span className="block min-w-0 truncate">
                      {getDisableBehaviorLabel(disableBehavior, libDirs.aux)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-w-[420px]">
                  <SelectItem value="suffix">VaM native (rename to .var.disabled)</SelectItem>
                  {libDirs.aux.map((d) => (
                    <SelectItem key={d.id} value={disableBehaviorMoveTo(d.id)} title={d.path}>
                      <span className="block min-w-0 truncate">Move to {d.path}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              <Button variant="outline" size="lg" onClick={handleOpenApplicationFolder} className="text-xs">
                <FolderOpen size={14} /> Show in folder
              </Button>
            </div>
            {hubScanning && hubScanProgress && (
              <div className="text-[11px] text-text-tertiary">
                Scanning {hubScanProgress.current} / {hubScanProgress.total}
                {hubScanProgress.found != null && (
                  <span className="ml-1.5 text-text-tertiary/80">
                    · {hubScanProgress.found} on Hub
                    {hubScanProgress.phase === 'fetching' && ' · fetching details'}
                  </span>
                )}
              </div>
            )}
            {verifying && verifyProgress && (
              <div className="text-[11px] text-text-tertiary">
                Checking {verifyProgress.step} / {verifyProgress.total}
                {verifyProgress.filename && (
                  <span className="ml-1.5 text-text-tertiary/70 select-text cursor-text">
                    {verifyProgress.filename}
                  </span>
                )}
              </div>
            )}
            {scanResult && (
              <div
                className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
                  scanResult.error
                    ? 'bg-error/10 border border-error/20 text-error'
                    : scanResult.success
                      ? 'bg-success/10 border border-success/20 text-success'
                      : 'bg-accent-blue/10 border border-accent-blue/20 text-accent-blue'
                }`}
              >
                {scanResult.error ? (
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                ) : scanResult.success ? (
                  <CheckCircle size={14} className="shrink-0 mt-0.5" />
                ) : (
                  <HardDrive size={14} className="shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <span className="select-text cursor-text">
                    {scanResult.error || scanResult.success || scanResult.info}
                  </span>
                  {scanResult.corruptedFiles?.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-[11px] opacity-80">
                      {scanResult.corruptedFiles.map((f) => (
                        <li key={f} className="select-text cursor-text truncate font-mono">
                          · {f}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* Display */}
        <Section title="Display" description="Control how library content appears.">
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary font-medium">Auto-hide dependency content</div>
                <div className="text-[11px] text-text-tertiary mt-0.5">
                  Automatically hide content items from dependency packages so only directly installed content is
                  visible.
                </div>
              </div>
              <Switch checked={autoHideDeps} onCheckedChange={handleToggleAutoHide} disabled={unhiding || hiding} />
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary font-medium">Blur thumbnails</div>
                <div className="text-[11px] text-text-tertiary mt-0.5">
                  Apply a blur to all package and content thumbnail images to keep it SFW.
                </div>
              </div>
              <Switch checked={blurThumbnails} onCheckedChange={handleToggleBlurThumbnails} />
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary font-medium">Dim inactive packages</div>
                <div className="text-[11px] text-text-tertiary mt-0.5">
                  When ON, disabled and offloaded packages are greyed out with a small corner icon. When OFF, they
                  render at full color with an informational chip — handy if a large part of your library is archived.
                </div>
              </div>
              <Switch checked={dimInactive} onCheckedChange={setDimInactive} />
            </label>
          </div>
        </Section>

        <AlertDialog open={hideDialogOpen} onOpenChange={onHideDialogOpenChange}>
          <AlertDialogContent className="max-w-md" size="default">
            <AlertDialogHeader>
              <AlertDialogTitle>Hide dependency content?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="text-[11px] text-text-tertiary space-y-2">
                  <p>Would you like to hide content from existing dependency packages now?</p>
                  <p>
                    You can enable auto-hide for new installs only — choose &quot;Turn on&quot; and hide existing items
                    later from the Content browser.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {hiding && hideProgress && hideProgress.total > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between text-[11px] text-text-tertiary">
                  <span className="truncate pr-2">
                    Hiding dependency content — {hideProgress.current.toLocaleString()} of{' '}
                    {hideProgress.total.toLocaleString()} packages
                  </span>
                  <span className="shrink-0 text-text-secondary/90">
                    {Math.min(100, Math.round((hideProgress.current / hideProgress.total) * 100))}%
                  </span>
                </div>
                <Progress
                  value={Math.min(100, Math.round((hideProgress.current / hideProgress.total) * 100))}
                  className="h-[5px] bg-white/8"
                  indicatorClassName="bg-linear-to-r from-accent-blue to-[#c040ee]"
                />
              </div>
            )}
            {hiding && (!hideProgress || hideProgress.total === 0) && (
              <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                <Loader2 size={14} className="animate-spin shrink-0" />
                Hiding dependency content…
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={hiding}>Cancel</AlertDialogCancel>
              <Button type="button" variant="outline" onClick={handleTurnOnAutoHideOnly} disabled={hiding}>
                Turn on
              </Button>
              <AlertDialogAction onClick={handleTurnOnAndHide} disabled={hiding} className="gap-1.5">
                {hiding ? <Loader2 size={14} className="animate-spin" /> : null}
                Turn on and hide all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={unhideDialogOpen} onOpenChange={onUnhideDialogOpenChange}>
          <AlertDialogContent className="max-w-md" size="default">
            <AlertDialogHeader>
              <AlertDialogTitle>Unhide dependency content?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="text-[11px] text-text-tertiary space-y-2">
                  <p>Would you like to also unhide all hidden content from dependency packages?</p>
                  <p>
                    You can keep them hidden and only turn off auto-hide for future installs — choose &quot;Turn
                    off&quot;.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {unhiding && unhideProgress && unhideProgress.total > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between text-[11px] text-text-tertiary">
                  <span className="truncate pr-2">
                    Unhiding dependency content — {unhideProgress.current.toLocaleString()} of{' '}
                    {unhideProgress.total.toLocaleString()} packages
                  </span>
                  <span className="shrink-0 text-text-secondary/90">
                    {Math.min(100, Math.round((unhideProgress.current / unhideProgress.total) * 100))}%
                  </span>
                </div>
                <Progress
                  value={Math.min(100, Math.round((unhideProgress.current / unhideProgress.total) * 100))}
                  className="h-[5px] bg-white/8"
                  indicatorClassName="bg-linear-to-r from-accent-blue to-[#c040ee]"
                />
              </div>
            )}
            {unhiding && (!unhideProgress || unhideProgress.total === 0) && (
              <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                <Loader2 size={14} className="animate-spin shrink-0" />
                Unhiding dependency content…
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={unhiding}>Cancel</AlertDialogCancel>
              <Button type="button" variant="outline" onClick={handleTurnOffAutoHideOnly} disabled={unhiding}>
                Turn off
              </Button>
              <AlertDialogAction onClick={handleTurnOffAutoHideAndUnhide} disabled={unhiding} className="gap-1.5">
                {unhiding ? <Loader2 size={14} className="animate-spin" /> : null}
                Turn off and unhide all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {showDevSection && (
          <Section
            title="Developer"
            danger
            description="Debug logging, BrowserAssist sync, and database tools. In release builds, tap the app version below seven times to show this section."
          >
            <div className="space-y-4">
              {developerUnlocked && !isDev && (
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-primary font-medium flex items-center gap-1.5">
                      <CurlyBraces size={14} className="text-text-tertiary shrink-0" />
                      Developer options unlocked
                    </div>
                    <div className="text-[11px] text-text-tertiary mt-0.5">
                      Turn off to hide this section again (tap the version seven times to re-enable).
                    </div>
                  </div>
                  <Switch
                    checked
                    onCheckedChange={(on) => {
                      if (!on) void handleDisableDeveloperOptions()
                    }}
                  />
                </label>
              )}
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary font-medium flex items-center gap-1.5">
                    <FlaskConical size={14} className="text-text-tertiary shrink-0" />
                    Update channel
                  </div>
                  <div className="text-[11px] text-text-tertiary mt-0.5">
                    {updateChannel === 'dev'
                      ? 'Pulls ephemeral builds from the latest master commit. Unstable; may contain bugs or in-progress features. Downgrades are not supported — stable updates resume only once a stable release is newer than your current dev build.'
                      : 'Stable releases only. Switch to Dev to receive ephemeral builds from master (unstable, no downgrade path).'}
                  </div>
                </div>
                <Select value={updateChannel} onValueChange={handleChannelChange}>
                  <SelectTrigger className="shrink-0 min-w-[110px]" aria-label="Update channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stable">Stable</SelectItem>
                    <SelectItem value="dev">Dev (unstable)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary font-medium flex items-center gap-1.5">
                    <Bug size={14} className="text-text-tertiary shrink-0" />
                    Debug log Hub requests
                  </div>
                  <div className="text-[11px] text-text-tertiary mt-0.5">
                    Print Hub API request and response bodies to the main process console.
                  </div>
                </div>
                <Switch checked={hubDebugRequests} onCheckedChange={handleToggleHubDebug} />
              </label>

              <div className="border-t border-border pt-4 space-y-3">
                <div>
                  <div className="text-xs text-text-primary font-medium">Sync with BrowserAssist</div>
                  <div className="text-[11px] text-text-tertiary mt-0.5">
                    Write User tags (scene-real / scene-look / scene-other) plus user-defined Labels (own + inherited
                    from package) into JayJayWon BrowserAssist settings for matching resources in this app&apos;s
                    library.
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={handleSyncBrowserAssist}
                  disabled={baSyncing || !baDirPresent}
                  className="shrink-0 gap-2 text-xs"
                >
                  {baSyncing ? (
                    <Loader2 size={14} className="animate-spin shrink-0" />
                  ) : (
                    <RefreshCw size={14} className="shrink-0" />
                  )}
                  {baSyncing ? 'Syncing…' : 'Sync with BrowserAssist'}
                </Button>
                {baSyncResult && (
                  <div
                    className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
                      baSyncResult.error
                        ? 'bg-error/10 border border-error/20 text-error'
                        : baSyncResult.warnings?.length
                          ? 'bg-warning/10 border border-warning/20 text-warning'
                          : 'bg-success/10 border border-success/20 text-success'
                    }`}
                  >
                    {baSyncResult.error ? (
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    ) : baSyncResult.warnings?.length ? (
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle size={14} className="shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 space-y-1.5">
                      <span className="select-text cursor-text">{baSyncResult.error || baSyncResult.success}</span>
                      {baSyncResult.warnings?.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[11px] opacity-90">
                          {baSyncResult.warnings.map((w, i) => (
                            <li key={`${i}:${w}`} className="select-text cursor-text">
                              · {w}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-4">
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
                        <div className="text-[11px] text-text-tertiary space-y-2">
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
          <div className="text-[11px] text-text-tertiary space-y-1">
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

function Section({ title, description, danger, children }) {
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
      <div className="p-4 space-y-3">
        <div>
          <h2 className="text-sm font-medium text-text-primary">{title}</h2>
          {description && <p className="text-[11px] mt-0.5 text-text-tertiary">{description}</p>}
        </div>
        {children}
      </div>
    </div>
  )
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

function getDisableBehaviorTooltip(value, auxDirs) {
  const parsed = parseDisableBehavior(value)
  if (parsed.kind === 'suffix') return 'VaM native disable (rename to .var.disabled)'
  const dir = auxDirs.find((d) => d.id === parsed.auxDirId)
  return dir ? `Move to ${dir.path}` : undefined
}

function StatRow({ label, value, warn }) {
  return (
    <>
      <span className="text-text-tertiary">{label}</span>
      <span className={`font-medium ${warn ? 'text-warning' : 'text-text-primary'}`}>{value}</span>
    </>
  )
}
