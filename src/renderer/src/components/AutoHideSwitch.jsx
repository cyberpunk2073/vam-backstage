import { useState, useCallback, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from '@/components/Toast'
import { useStatusStore } from '@/stores/useStatusStore'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Generic Display-section row backing any auto-hide setting that has the
 * "Turn on" vs "Turn on and sweep existing" dialog pattern (`auto_hide_deps`,
 * `auto_hide_foreign_*`). Owns local UI state only — sweeping work is
 * delegated to `apply` / `remove` props (which call the right IPC).
 *
 *   ON  → dialog: "Turn on" (just flips setting) | "Turn on and hide all"
 *   OFF → dialog: "Turn off"                     | "Turn off and unhide all"
 *
 * The two halves are structurally identical, so we render one dialog driven
 * by `mode` ('on' | 'off') instead of two near-duplicates.
 *
 * Copy props:
 *  - `hideTitle` / `unhideTitle` — dialog headings
 *  - `hideBody`  / `unhideBody`  — JSX paragraph(s) describing the choice
 *  - `progressNoun` — short string used in "Hiding {noun}" / "Unhiding {noun}"
 */
export function AutoHideSwitch({
  settingKey,
  label,
  description,
  apply,
  remove,
  hideTitle,
  unhideTitle,
  hideBody,
  unhideBody,
  progressNoun,
}) {
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState(null) // null | 'on' | 'off' — drives dialog visibility & copy
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState(null)
  const fetchStats = useStatusStore((s) => s.fetchStats)

  useEffect(() => {
    window.api.settings.get(settingKey).then((v) => setEnabled(v === '1'))
  }, [settingKey])

  const setFlag = useCallback(
    async (next) => {
      try {
        await window.api.settings.set(settingKey, next ? '1' : '0')
        setEnabled(next)
        return true
      } catch (err) {
        toast(`Failed to update setting: ${err.message}`)
        return false
      }
    },
    [settingKey],
  )

  const handleFlipOnly = useCallback(
    async (e) => {
      e?.preventDefault()
      if (await setFlag(mode === 'on')) setMode(null)
    },
    [mode, setFlag],
  )

  const handleFlipAndSweep = useCallback(
    async (e) => {
      e?.preventDefault()
      const target = mode === 'on'
      if (!(await setFlag(target))) return
      setWorking(true)
      setProgress(null)
      let cleanup = null
      try {
        cleanup = window.api.onApplyAutoHideProgress((data) => setProgress(data))
        await (target ? apply() : remove())
        fetchStats()
      } catch (err) {
        toast(`${target ? 'Auto-hide' : 'Unhide'} failed: ${err.message}`, 'error', 5000)
      } finally {
        cleanup?.()
        setWorking(false)
        setProgress(null)
        setMode(null)
      }
    },
    [mode, setFlag, apply, remove, fetchStats],
  )

  const onOpenChange = useCallback(
    (open) => {
      if (!open && !working) setMode(null)
    },
    [working],
  )

  const onMode = mode === 'on'
  const verbing = onMode ? 'Hiding' : 'Unhiding'
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0

  return (
    <>
      <label className="flex items-center gap-3 cursor-pointer">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-primary font-medium">{label}</div>
          <div className="text-[11px] text-text-tertiary mt-0.5">{description}</div>
        </div>
        <Switch checked={enabled} onCheckedChange={(next) => setMode(next ? 'on' : 'off')} disabled={working} />
      </label>

      <AlertDialog open={mode != null} onOpenChange={onOpenChange}>
        <AlertDialogContent className="max-w-md" size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>{onMode ? hideTitle : unhideTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-[11px] text-text-tertiary space-y-2">{onMode ? hideBody : unhideBody}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {working && progress && progress.total > 0 && (
            <div className="space-y-2">
              <div className="flex justify-between text-[11px] text-text-tertiary">
                <span className="truncate pr-2">
                  {verbing} {progressNoun} — {progress.current.toLocaleString()} of {progress.total.toLocaleString()}{' '}
                  packages
                </span>
                <span className="shrink-0 text-text-secondary/90">{pct}%</span>
              </div>
              <Progress
                value={pct}
                className="h-[5px] bg-white/8"
                indicatorClassName="bg-linear-to-r from-accent-blue to-[#c040ee]"
              />
            </div>
          )}
          {working && (!progress || progress.total === 0) && (
            <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
              <Loader2 size={14} className="animate-spin shrink-0" />
              {verbing} {progressNoun}…
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <Button type="button" variant="outline" onClick={handleFlipOnly} disabled={working}>
              {onMode ? 'Turn on' : 'Turn off'}
            </Button>
            <AlertDialogAction onClick={handleFlipAndSweep} disabled={working} className="gap-1.5">
              {working ? <Loader2 size={14} className="animate-spin" /> : null}
              {onMode ? 'Turn on and hide all' : 'Turn off and unhide all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Specialization of `AutoHideSwitch` for the per-category foreign-content
 * rules (Hairstyles / Poses / Clothing). Builds the boilerplate copy from
 * `category` + `noun` so call sites stay terse. `ruleId` matches the
 * `AUTO_HIDE_RULES` entry on the main side (`'foreign_hair'` / `'foreign_poses'`
 * / `'foreign_clothing'`).
 */
export function AutoHideForeignSwitch({ ruleId, category, settingKey, label, description, noun }) {
  return (
    <AutoHideSwitch
      settingKey={settingKey}
      label={label}
      description={description}
      apply={() => window.api.scan.applyAutoHide(ruleId)}
      remove={() => window.api.scan.removeAutoHide(ruleId)}
      hideTitle={`Hide foreign ${noun}?`}
      unhideTitle={`Unhide foreign ${noun}?`}
      progressNoun={`foreign ${noun}`}
      hideBody={
        <>
          <p>
            Would you like to hide existing {noun} found in packages that aren&apos;t themselves categorized as{' '}
            {category}?
          </p>
          <p>
            You can enable auto-hide for new installs only — choose &quot;Turn on&quot; and hide existing items later.
          </p>
        </>
      }
      unhideBody={
        <>
          <p>
            Would you like to also unhide all hidden {noun} that were auto-hidden in non-{category} packages?
          </p>
          <p>Items still claimed by another active auto-hide rule will stay hidden.</p>
        </>
      }
    />
  )
}
