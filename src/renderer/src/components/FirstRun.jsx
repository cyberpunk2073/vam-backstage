import { useState, useEffect, useCallback } from 'react'
import {
  Zap,
  Folder,
  CheckCircle2,
  Package,
  Eye,
  EyeOff,
  ArrowRight,
  Loader2,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Dialog as DialogPrimitive } from 'radix-ui'

/** Relative time/effort per phase (any positive scale; normalized by sum). Easier to extend than % that must total 100. */
const SCAN_STEPS = [
  { phase: 'indexing', label: 'Indexing .var files', weight: 2 },
  { phase: 'reading', label: 'Reading package manifests', weight: 32 },
  { phase: 'graph', label: 'Building dependency graph', weight: 2 },
  { phase: 'finalizing', label: 'Finalizing database', weight: 3 },
  { phase: 'hub', label: 'Fetching Hub package details', weight: 58 },
  { phase: 'hub-finalize', label: 'Indexing hub metadata', weight: 2 },
]

const SCAN_WEIGHT_SUM = SCAN_STEPS.reduce((acc, s) => acc + s.weight, 0)

function scanProgressPercent(phaseIndex, withinStepFrac) {
  if (phaseIndex < 0 || phaseIndex >= SCAN_STEPS.length) return 0
  const frac = Math.min(Math.max(withinStepFrac, 0), 1)
  let prefix = 0
  for (let i = 0; i < phaseIndex; i++) prefix += SCAN_STEPS[i].weight
  const p = ((prefix + SCAN_STEPS[phaseIndex].weight * frac) / SCAN_WEIGHT_SUM) * 100
  return Math.min(Math.round(p), 99)
}

export default function FirstRun({ onDone }) {
  const [step, setStep] = useState('beta')
  const [vamDir, setVamDir] = useState(null)
  const [varCount, setVarCount] = useState(0)
  const [detected, setDetected] = useState(false)
  const [browseError, setBrowseError] = useState(null)
  const [activePhaseIdx, setActivePhaseIdx] = useState(-1)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanError, setScanError] = useState(null)
  const [stats, setStats] = useState(null)
  const [scanSkippedFiles, setScanSkippedFiles] = useState([])
  const [hideDepContent, setHideDepContent] = useState(true)
  const [applying, setApplying] = useState(false)
  const [hideProgress, setHideProgress] = useState(null)
  const [detectSource, setDetectSource] = useState(null)

  useEffect(() => {
    window.api.wizard.detectVamDir().then(({ path, varCount: count, source }) => {
      if (path) {
        setVamDir(path)
        setVarCount(count)
        setDetected(true)
        setDetectSource(source)
      }
    })
  }, [])

  const handleBrowse = useCallback(async () => {
    setBrowseError(null)
    const result = await window.api.wizard.browseVamDir(vamDir || undefined)
    if (result.cancelled) return
    if (result.valid === false) {
      setBrowseError('No AddonPackages folder found in that directory')
      return
    }
    if (result.path) {
      setVamDir(result.path)
      setVarCount(result.varCount || 0)
      setDetected(false)
    }
  }, [vamDir])

  const handleScan = useCallback(async () => {
    if (!vamDir) return
    setStep('scanning')
    setActivePhaseIdx(0)
    setScanError(null)
    setScanSkippedFiles([])

    const cleanup = window.api.onScanProgress((progress) => {
      const idx = SCAN_STEPS.findIndex((s) => s.phase === progress.phase)
      if (idx < 0) return
      setActivePhaseIdx(idx)
      const frac = progress.total > 0 ? progress.step / progress.total : 0
      setScanProgress(scanProgressPercent(idx, frac))
    })

    try {
      await window.api.settings.set('vam_dir', vamDir)
      const scanResult = await window.api.scan.start()
      cleanup()

      const skipped = Array.isArray(scanResult?.unreadable) ? scanResult.unreadable : []
      setScanSkippedFiles(skipped)

      const pkgStats = await window.api.packages.stats()
      setStats(pkgStats)

      // Hub enrichment phase
      if (pkgStats.totalCount > 0) {
        const hubIdx = SCAN_STEPS.findIndex((s) => s.phase === 'hub')
        setActivePhaseIdx(hubIdx)
        setScanProgress(scanProgressPercent(hubIdx, 0))

        const finalizeIdx = SCAN_STEPS.findIndex((s) => s.phase === 'hub-finalize')
        const hubCleanup = window.api.onHubScanProgress((data) => {
          if (data.phase === 'fetching' && data.total > 0) {
            const frac = data.current / data.total
            setScanProgress(scanProgressPercent(hubIdx, frac))
          } else if (data.phase === 'hub-finalize') {
            setActivePhaseIdx(finalizeIdx)
            const frac = data.total > 0 ? data.current / data.total : 0
            setScanProgress(scanProgressPercent(finalizeIdx, frac))
          }
        })
        try {
          await window.api.wizard.enrichHub()
        } catch (e) {
          console.warn('Hub enrichment failed:', e.message)
        }
        hubCleanup()
      }

      setActivePhaseIdx(SCAN_STEPS.length)
      setScanProgress(100)

      if (pkgStats.totalCount === 0) {
        await window.api.settings.set('auto_hide_deps', '1')
      }
      setTimeout(() => {
        const hasSkips = skipped.length > 0
        if (hasSkips) {
          setStep('unhandled')
        } else if (pkgStats.totalCount === 0) {
          setStep('done')
        } else {
          setStep('setup')
        }
      }, 400)
    } catch (err) {
      cleanup()
      setScanError(err.message || 'Scan failed')
      setStep('welcome')
    }
  }, [vamDir])

  const handleApply = useCallback(async () => {
    setApplying(true)
    setHideProgress(null)
    let hideCleanup = null
    try {
      if (hideDepContent) {
        hideCleanup = window.api.onApplyAutoHideProgress((data) => {
          setHideProgress(data)
        })
        await window.api.scan.applyAutoHide()
        await window.api.settings.set('auto_hide_deps', '1')
        const pkgStats = await window.api.packages.stats()
        setStats(pkgStats)
      }
    } finally {
      hideCleanup?.()
      setApplying(false)
      setHideProgress(null)
    }
    setStep('done')
  }, [hideDepContent])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && step === 'done') onDone()
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-[rgba(5,6,10,0.92)] backdrop-blur-md" />
        <DialogPrimitive.Content
          className="fade-in fixed top-1/2 left-1/2 z-50 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-[#13141e] border border-white/10 overflow-hidden shadow-[0_32px_80px_rgba(0,0,0,0.7),0_0_0_1px_rgba(58,124,244,0.1)] outline-none"
          onPointerDownOutside={(e) => {
            if (step !== 'done') e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (step !== 'done') e.preventDefault()
          }}
          onEscapeKeyDown={(e) => {
            if (step !== 'done') e.preventDefault()
          }}
        >
          <div className="h-[3px] bg-linear-to-r from-accent-blue to-[#c040ee]" />
          <div className="p-8">
            {step === 'beta' && <BetaWarningStep onContinue={() => setStep('welcome')} />}
            {step === 'welcome' && (
              <WelcomeStep
                vamDir={vamDir}
                varCount={varCount}
                detected={detected}
                detectSource={detectSource}
                browseError={browseError}
                scanError={scanError}
                onBrowse={handleBrowse}
                onScan={handleScan}
              />
            )}
            {step === 'scanning' && <ScanningStep progress={scanProgress} activePhaseIdx={activePhaseIdx} />}
            {step === 'unhandled' && stats && (
              <UnhandledVarFilesStep
                stats={stats}
                scanSkippedFiles={scanSkippedFiles}
                onContinue={() => setStep(stats.totalCount > 0 ? 'setup' : 'done')}
              />
            )}
            {step === 'setup' && (
              <SetupStep
                stats={stats}
                hideDepContent={hideDepContent}
                setHideDepContent={setHideDepContent}
                applying={applying}
                hideProgress={hideProgress}
                onApply={handleApply}
              />
            )}
            {step === 'done' && (
              <DoneStep
                stats={stats}
                hideEnabled={hideDepContent}
                scanHadSkips={scanSkippedFiles.length > 0}
                onDone={onDone}
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

function BetaWarningStep({ onContinue }) {
  return (
    <div className="text-center py-2">
      <div className="w-14 h-14 rounded-2xl mx-auto mb-5 flex items-center justify-center bg-warning/10 border border-warning/25">
        <ShieldAlert size={28} className="text-warning" />
      </div>

      <p className="m-0 mb-4 text-[13px] text-white/50 leading-[1.7] text-left">
        This is untested beta software. Before using, copy your <strong className="text-white/55">AddonPackages</strong>{' '}
        and <strong className="text-white/55">AddonPackagesFilePrefs</strong> folders somewhere safe.
      </p>

      <p className="m-0 mb-7 text-[13px] text-white/45 leading-[1.7] text-left">
        Like, seriously, you may lose all your shit. You&apos;ve been warned.
      </p>

      <Button variant="gradient" size="lg" onClick={onContinue} className="w-full rounded-[10px] text-[13px]">
        I understand, continue <ArrowRight size={15} />
      </Button>
    </div>
  )
}

const DETECT_SOURCE_HINT = {
  cwd: 'Auto-detected from working directory',
  exe: 'Auto-detected from executable location',
  app: 'Auto-detected from app location',
}

function WelcomeStep({ vamDir, varCount, detected, detectSource, browseError, scanError, onBrowse, onScan }) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center bg-linear-to-br from-accent-blue to-accent-pink">
          <Zap size={22} className="text-white" strokeWidth={2} />
        </div>
        <div>
          <h2 className="m-0 text-xl font-semibold text-text-primary tracking-tight">
            Welcome to <span className="gradient-text">VaM Backstage</span>
          </h2>
        </div>
      </div>

      <p className="text-[13px] leading-[1.7] text-white/55 mb-5">
        VaM Backstage will scan your Virt-a-Mate library and map all package dependencies.
      </p>

      <div className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-white/30 mb-2.5">VaM directory</p>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
          <Folder size={14} className="text-accent-blue shrink-0" />
          <span className="flex-1 text-xs text-white/70 font-mono truncate select-text cursor-text">
            {vamDir || 'Not detected'}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={onBrowse}
            className="border-white/15 bg-white/5 text-white/50 hover:text-white/75 hover:bg-white/10"
          >
            {vamDir ? 'Change' : 'Select'}
          </Button>
        </div>
        {detected && detectSource && (
          <p className="text-[11px] text-white/25 mt-1.5">{DETECT_SOURCE_HINT[detectSource]}</p>
        )}
        {browseError && (
          <p className="text-[11px] text-error mt-1.5 flex items-center gap-1 select-text cursor-text">
            <AlertTriangle size={11} /> {browseError}
          </p>
        )}
      </div>

      {vamDir && varCount > 0 && (
        <div className="flex gap-2.5 flex-wrap p-3.5 rounded-[10px] bg-[rgba(74,145,241,0.08)] border border-[rgba(74,145,241,0.2)] mb-7">
          <div className="flex items-center gap-1.5 text-xs text-white/60">
            <Package size={13} className="text-accent-blue" />
            {varCount.toLocaleString()} var files found
          </div>
        </div>
      )}

      {scanError && (
        <div className="flex gap-2 p-3 rounded-lg bg-error/10 border border-error/25 mb-5 text-xs text-error">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium mb-0.5">Scan failed</p>
            <p className="text-error/70 select-text cursor-text">{scanError}</p>
          </div>
        </div>
      )}

      <Button
        variant="gradient"
        size="lg"
        onClick={onScan}
        disabled={!vamDir}
        className="w-full rounded-[10px] text-[13px]"
      >
        Scan library <ArrowRight size={15} />
      </Button>
    </div>
  )
}

function ScanningStep({ progress, activePhaseIdx }) {
  return (
    <div>
      <div className="flex items-center gap-2.5 mb-7">
        <Loader2 size={18} className="text-accent-blue spin-slow" />
        <h2 className="m-0 text-[17px] font-semibold text-text-primary">Scanning library</h2>
      </div>

      <div className="mb-6">
        <div className="flex justify-between mb-2 text-xs text-white/40">
          <span>Progress</span>
          <span className="text-white/65">{progress}%</span>
        </div>
        <Progress
          value={progress}
          className="h-[5px] bg-white/8"
          indicatorClassName="bg-linear-to-r from-accent-blue to-[#c040ee]"
        />
      </div>

      <div className="flex flex-col gap-1.5 mb-2">
        {SCAN_STEPS.map((s, i) => {
          const done = i < activePhaseIdx
          const active = i === activePhaseIdx
          return (
            <div key={s.phase} className={`flex items-center gap-2 ${done || active ? 'opacity-100' : 'opacity-30'}`}>
              {done ? (
                <CheckCircle2 size={13} className="text-success shrink-0" />
              ) : active ? (
                <Loader2 size={13} className="text-accent-blue shrink-0 spin-slow" />
              ) : (
                <div className="w-[13px] h-[13px] rounded-full border border-white/15 shrink-0" />
              )}
              <span className={`text-xs ${active ? 'text-white/75' : done ? 'text-white/45' : 'text-white/25'}`}>
                {s.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SkippedVarFilesCallout({ filenames }) {
  if (!filenames?.length) return null
  const n = filenames.length
  const showScrollHint = n > 8
  const listLabel = `${n.toLocaleString()} skipped files — scroll to see all names`
  return (
    <div className="flex gap-2.5 p-3.5 rounded-[10px] bg-warning/10 border border-warning/20 mb-5 text-left">
      <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[13px] font-medium text-warning/90 mb-1">{n.toLocaleString()} files could not be read</p>
        <p className="m-0 text-[11px] text-white/45 leading-snug mb-2.5">
          These .var files were skipped. They may be corrupted, incomplete, or not valid packages. The rest of your
          library was indexed. Fix or remove them in AddonPackages, then rescan from Settings.
        </p>
        {showScrollHint && (
          <p className="m-0 text-[10px] text-white/35 mb-1.5">
            {n.toLocaleString()} file names below — scroll the list to review or copy.
          </p>
        )}
        <ul
          className="m-0 max-h-[min(12rem,38vh)] overflow-y-auto overscroll-y-contain space-y-0.5 list-none rounded-md border border-white/10 bg-black/30 py-1.5 px-2.5"
          aria-label={listLabel}
        >
          {filenames.map((f, i) => (
            <li
              key={`${i}:${f}`}
              title={f}
              className="text-[11px] font-mono text-white/55 truncate select-text cursor-text"
            >
              · {f}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function UnhandledVarFilesStep({ stats, scanSkippedFiles, onContinue }) {
  const hasPackages = stats.totalCount > 0
  return (
    <div>
      <div className="flex items-center gap-2.5 mb-2">
        <AlertTriangle size={20} className="text-warning" />
        <h2 className="m-0 text-[17px] font-semibold text-text-primary">Unreadable .var files</h2>
      </div>
      {hasPackages ? (
        <p className="text-xs text-white/40 mb-5">
          Scan finished: <strong className="text-white/70">{stats.totalCount.toLocaleString()} packages</strong> indexed
          {' \u2014 '}
          <strong className="text-white/70">{stats.directCount.toLocaleString()}</strong> direct,{' '}
          <strong className="text-white/70">{stats.depCount.toLocaleString()}</strong> dependencies. The files below
          were skipped.
        </p>
      ) : (
        <p className="text-xs text-white/40 mb-5">
          No packages could be indexed. Review the skipped files below, fix or remove them in AddonPackages, then rescan
          from Settings.
        </p>
      )}
      <SkippedVarFilesCallout filenames={scanSkippedFiles} />
      <Button variant="gradient" size="lg" onClick={onContinue} className="w-full rounded-[10px] text-[13px]">
        Continue <ArrowRight size={15} />
      </Button>
    </div>
  )
}

function SetupStep({ stats, hideDepContent, setHideDepContent, applying, hideProgress, onApply }) {
  const showProgress = applying && hideDepContent && hideProgress && hideProgress.total > 0
  const pct = showProgress ? Math.min(Math.round((hideProgress.current / hideProgress.total) * 100), 100) : 0
  return (
    <div>
      <div className="flex items-center gap-2.5 mb-2">
        <CheckCircle2 size={20} className="text-success" />
        <h2 className="m-0 text-[17px] font-semibold text-text-primary">Scan complete</h2>
      </div>
      <p className="text-xs text-white/40 mb-6">
        Found <strong className="text-white/70">{stats.totalCount.toLocaleString()} packages</strong>
        {' \u2014 '}
        <strong className="text-white/70">{stats.directCount.toLocaleString()}</strong> direct installs,{' '}
        <strong className="text-white/70">{stats.depCount.toLocaleString()}</strong> dependencies
      </p>

      <p className="text-xs leading-[1.7] text-white/50 mb-5">
        We detected that{' '}
        <strong className="text-white/75">{(stats.depContentCount || 0).toLocaleString()} content items</strong> belong
        to dependency packages. Would you like to automatically hide them in VaM so your library only shows content from
        directly installed packages?
      </p>

      <div className={`flex flex-col gap-2 ${showProgress ? 'mb-4' : 'mb-7'}`}>
        {[
          {
            id: true,
            icon: EyeOff,
            label: 'Hide dependency content',
            desc: `Recommended. Your VaM library will only show content from your ${stats.directCount.toLocaleString()} direct packages. Dependencies remain hidden unless you promote them.`,
          },
          {
            id: false,
            icon: Eye,
            label: 'Keep everything visible',
            desc: `All ${stats.totalContent.toLocaleString()} items stay visible in VaM. You can manage visibility manually later.`,
          },
        ].map(({ id, icon: Icon, label, desc }) => (
          <button
            key={String(id)}
            type="button"
            onClick={() => setHideDepContent(id)}
            className={`flex gap-3 p-3.5 rounded-[10px] cursor-pointer text-left transition-all duration-150 ${
              hideDepContent === id
                ? 'bg-[rgba(74,145,241,0.1)] border border-[rgba(74,145,241,0.4)]'
                : 'bg-white/4 border border-white/8'
            }`}
          >
            <Icon
              size={16}
              className={`shrink-0 mt-0.5 ${hideDepContent === id ? 'text-accent-blue' : 'text-white/35'}`}
            />
            <div>
              <p
                className={`m-0 text-[13px] font-medium mb-0.5 ${hideDepContent === id ? 'text-[#d0d1de]' : 'text-white/55'}`}
              >
                {label}
              </p>
              <p className="m-0 text-[11px] text-white/35 leading-snug">{desc}</p>
            </div>
          </button>
        ))}
      </div>

      {showProgress && (
        <div className="mb-5">
          <div className="flex justify-between mb-2 text-xs text-white/40">
            <span className="truncate pr-2">
              Hiding dependency content — {hideProgress.current.toLocaleString()} of{' '}
              {hideProgress.total.toLocaleString()} packages
            </span>
            <span className="text-white/65 shrink-0">{pct}%</span>
          </div>
          <Progress
            value={pct}
            className="h-[5px] bg-white/8"
            indicatorClassName="bg-linear-to-r from-accent-blue to-[#c040ee]"
          />
        </div>
      )}

      <Button
        variant="gradient"
        size="lg"
        onClick={onApply}
        disabled={applying}
        className="w-full rounded-[10px] text-[13px]"
      >
        {applying ? (
          <>
            <Loader2 size={14} className="spin-slow" /> {hideDepContent ? 'Hiding dependency content…' : 'Applying…'}
          </>
        ) : (
          <>
            Apply & continue <ArrowRight size={15} />
          </>
        )}
      </Button>
    </div>
  )
}

function DoneStep({ stats, hideEnabled, scanHadSkips, onDone }) {
  const depContent = stats?.depContentCount || 0
  const hasIndexed = stats && stats.totalCount > 0
  return (
    <div className="text-center py-3">
      <div className="w-14 h-14 rounded-2xl mx-auto mb-5 flex items-center justify-center bg-success/12 border border-success/25">
        <CheckCircle2 size={28} className="text-success" />
      </div>

      <h2 className="m-0 mb-2 text-xl font-semibold text-text-primary">You&apos;re all set!</h2>
      <p className="m-0 mb-6 text-[13px] text-white/45 leading-[1.7]">
        {hasIndexed
          ? hideEnabled
            ? `${depContent.toLocaleString()} dependency items have been hidden in VaM. Browse your library \u2014 only your direct packages are visible.`
            : 'Library scanned and indexed. You can manage content visibility anytime from the Content browser.'
          : scanHadSkips
            ? 'No packages could be indexed. Fix or remove the unreadable .var files you reviewed, then rescan from Settings.'
            : 'No packages found. Add .var files to your AddonPackages folder and rescan from Settings.'}
      </p>

      {stats && stats.totalCount > 0 && (
        <div className="flex justify-center gap-4 mb-7 flex-wrap">
          {[
            { value: stats.totalCount.toLocaleString(), label: 'Packages indexed' },
            { value: stats.directCount.toLocaleString(), label: 'Direct installs' },
            { value: stats.totalContent.toLocaleString(), label: 'Content items' },
          ].map(({ value, label }) => (
            <div key={label} className="text-center">
              <p className="m-0 text-[22px] font-bold tracking-tight gradient-text">{value}</p>
              <p className="m-0 text-[11px] text-white/35">{label}</p>
            </div>
          ))}
        </div>
      )}

      <Button variant="gradient" size="lg" onClick={onDone} className="w-full rounded-[10px] text-[13px]">
        Open VaM Backstage
      </Button>
    </div>
  )
}
