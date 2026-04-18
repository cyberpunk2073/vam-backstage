import { useEffect, useRef, useState } from 'react'
import { Package, GitFork, Layers, HardDrive, Download, RefreshCw, Loader2 } from 'lucide-react'
import { useStatusStore } from '../stores/useStatusStore'
import { useDownloadStore } from '../stores/useDownloadStore'
import { CONTENT_TYPES, formatBytes, middleTruncate } from '../lib/utils'
import { toast } from './Toast'
import { Progress } from './ui/progress'
import { Button } from './ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'

function StatTooltip({ children, lines }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="whitespace-pre text-left">
        {lines}
      </TooltipContent>
    </Tooltip>
  )
}

function VersionLabelButton({ busy, onClick, children, className = '' }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      aria-busy={busy}
      className={`flex items-center gap-1.5 min-w-0 max-w-full m-0 border-0 bg-transparent p-0 font-inherit text-inherit text-left cursor-pointer hover:opacity-90 disabled:cursor-pointer disabled:opacity-60 ${className}`}
    >
      {busy ? <Loader2 size={11} className="shrink-0 animate-spin opacity-80" aria-hidden /> : null}
      <span className="min-w-0 truncate select-text">{children}</span>
    </button>
  )
}

export default function StatusBar() {
  const { stats, scan } = useStatusStore()
  const dlItems = useDownloadStore((s) => s.items)
  const liveProgress = useDownloadStore((s) => s.liveProgress)
  const scanStart = useRef(null)
  const [showScan, setShowScan] = useState(false)
  const showScanRef = useRef(showScan)
  showScanRef.current = showScan
  const [isDev, setIsDev] = useState(true)
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState(null)
  const [versionCheckBusy, setVersionCheckBusy] = useState(false)

  useEffect(() => {
    window.api.dev.isDev().then(setIsDev)
    window.api.app.getVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    if (isDev) return undefined
    const cleanup1 = window.api.onUpdateAvailable((data) => {
      setUpdateState({ phase: 'downloading', version: data.version })
    })
    const cleanup2 = window.api.onUpdateDownloaded((data) => {
      setUpdateState({ phase: 'ready', version: data.version })
      toast(`Update v${data.version} downloaded — restart to finish`, 'success', 4000)
    })
    return () => {
      cleanup1()
      cleanup2()
    }
  }, [isDev])

  const handleVersionClick = async () => {
    if (versionCheckBusy) return
    setVersionCheckBusy(true)
    try {
      const r = await window.api.updater.check()
      if (!r?.ok) {
        toast(r?.error || 'Could not check for updates', 'error', 4500)
        return
      }
      if (r.disabled) {
        toast('Update checks run in the installed app.', 'info', 3500)
        return
      }
      if (!r.isUpdateAvailable) {
        toast(`You're on the latest version (${appVersion ? `${appVersion} Beta` : 'current'}).`, 'info', 3200)
      }
    } finally {
      setVersionCheckBusy(false)
    }
  }

  useEffect(() => {
    const fetch = () => useStatusStore.getState().fetchStats()
    fetch()
    const cleanup1 = window.api.onPackagesUpdated(fetch)
    const cleanup2 = window.api.onContentsUpdated(fetch)
    const cleanupScan = window.api.onScanProgress((data) => {
      const { setScan } = useStatusStore.getState()
      if (data.phase === 'finalizing' && data.step === data.total) {
        setScan(null)
        setShowScan(false)
        scanStart.current = null
        fetch()
        return
      }
      if (!scanStart.current) scanStart.current = Date.now()
      setScan(data)
      if (!showScanRef.current && Date.now() - scanStart.current > 1000) setShowScan(true)
    })
    return () => {
      cleanup1()
      cleanup2()
      cleanupScan()
    }
  }, [])

  const by = stats.contentByType || {}
  const contentTooltip = [
    ...CONTENT_TYPES.map((t) => `${t}: ${by[t] ?? 0}`),
    ...Object.keys(by)
      .filter((t) => !CONTENT_TYPES.includes(t))
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map((t) => `${t}: ${by[t]}`),
  ].join('\n')

  const active = dlItems.filter((d) => d.status === 'active')
  const queued = dlItems.filter((d) => d.status === 'queued')
  const completed = dlItems.filter((d) => d.status === 'completed')
  const hasDownloads = active.length > 0 || queued.length > 0

  const prevHadDownloads = useRef(false)
  const excludedIds = useRef(new Set())
  if (prevHadDownloads.current && !hasDownloads) {
    for (const d of completed) excludedIds.current.add(d.id)
  }
  prevHadDownloads.current = hasDownloads

  const sessionCompleted = completed.filter((d) => !excludedIds.current.has(d.id))
  const sessionItems = [...active, ...queued, ...sessionCompleted]

  let progressPct = 0
  if (hasDownloads && sessionItems.length > 0) {
    let totalBytes = 0,
      loadedBytes = 0
    for (const d of sessionItems) {
      const size = d.file_size || liveProgress[d.id]?.fileSize || 0
      const loaded = d.status === 'completed' ? size : liveProgress[d.id]?.bytesLoaded || 0
      totalBytes += size
      loadedBytes += loaded
    }
    progressPct = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0
  }

  return (
    <div className="h-7 bg-surface border-t border-border flex items-center px-4 text-[11px] text-text-secondary/60 gap-4 shrink-0">
      <StatTooltip
        lines={`${stats.directCount} installed\n${stats.depCount} dependencies\n${stats.totalCount} total installed`}
      >
        <span className="flex items-center gap-1">
          <Package size={11} />
          {stats.directCount} packages
        </span>
      </StatTooltip>
      <span className="opacity-30">&middot;</span>
      <StatTooltip
        lines={`${stats.depCount} dependency packages${stats.missingDepCount > 0 ? `\n${stats.missingDepCount} missing deps` : ''}`}
      >
        <span className="flex items-center gap-1">
          <GitFork size={11} />
          {stats.depCount} deps
        </span>
      </StatTooltip>
      <span className="opacity-30">&middot;</span>
      <StatTooltip lines={contentTooltip || 'No content indexed'}>
        <span className="flex items-center gap-1">
          <Layers size={11} />
          {stats.totalContent} items
        </span>
      </StatTooltip>
      <span className="opacity-30">&middot;</span>
      <StatTooltip
        lines={`${formatBytes(stats.totalSize)} total\n${formatBytes(stats.directSize)} direct\n${formatBytes(stats.depSize)} deps`}
      >
        <span className="flex items-center gap-1">
          <HardDrive size={11} />
          {formatBytes(stats.totalSize)}
        </span>
      </StatTooltip>
      <div className="flex-1" />
      {showScan && scan && (
        <div className="flex items-center gap-2 text-text-secondary/80">
          <RefreshCw size={11} className="animate-spin" />
          <Progress
            value={scan.total > 0 ? Math.round((scan.step / scan.total) * 100) : 0}
            className="w-24 h-1.5 bg-elevated"
            indicatorClassName="bg-text-secondary/40"
          />
          <span className="text-[10px] w-[160px] overflow-hidden whitespace-nowrap">
            {middleTruncate(scan.message, 28)}
          </span>
        </div>
      )}
      {hasDownloads && (
        <div className="flex items-center gap-2 text-accent-blue">
          <Download size={11} />
          <Progress value={progressPct} className="w-24 h-1.5 bg-elevated" indicatorClassName="progress-bar" />
          <span className="text-[10px] font-mono">
            {sessionCompleted.length}/{sessionItems.length}
          </span>
        </div>
      )}
      <StatTooltip
        lines={isDev ? 'VaM Backstage\nAutomatic updates run in the release build.' : 'Click to check for updates.'}
      >
        <div
          className={`text-[10px] ml-2 flex items-center gap-2 shrink-0 min-w-0 cursor-pointer ${
            !isDev && updateState ? 'text-accent-blue' : 'text-text-secondary/75'
          }`}
        >
          {isDev || !updateState ? (
            <VersionLabelButton busy={versionCheckBusy} onClick={handleVersionClick}>
              VaM Backstage v{appVersion ? `${appVersion} Beta` : '—'}
            </VersionLabelButton>
          ) : updateState.phase === 'downloading' ? (
            <VersionLabelButton busy={versionCheckBusy} onClick={handleVersionClick}>
              Update v{updateState.version} downloading…
            </VersionLabelButton>
          ) : (
            <>
              <VersionLabelButton busy={versionCheckBusy} onClick={handleVersionClick} className="flex-1">
                v{appVersion ? `${appVersion} Beta` : '—'} → v{updateState.version} — restart to update
              </VersionLabelButton>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-accent-blue hover:text-accent-blue hover:bg-accent-blue/15 shrink-0 h-6 px-2"
                onClick={() => window.api.updater.install()}
              >
                Restart
              </Button>
            </>
          )}
        </div>
      </StatTooltip>
    </div>
  )
}
