import { useState, useCallback, useEffect } from 'react'
import { EyeOff, Loader2, Plus, RotateCcw, X } from 'lucide-react'
import { toast } from '@/components/Toast'
import { useStatusStore } from '@/stores/useStatusStore'
import { useDepHideOfferStore } from '@/stores/useDepHideOfferStore'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { META_DENSE } from '@/lib/typography'

const SWEEP_POINTS = [
  { icon: EyeOff, body: 'Dependencies stay installed and working, just hidden from view.' },
  {
    icon: Plus,
    body: 'If a package you use ends up hidden, open the Dependencies filter and Add it to your library to bring its content back.',
  },
  { icon: RotateCcw, body: 'Undo anytime in Settings \u2192 Behavior.' },
]

/**
 * Teach-before-acting dialog for the existing-library dependency sweep. This is
 * where the explanation lives (attention peaks right before the click, not on a
 * result screen): it states the outcome, the always-available undo, the
 * magnitude, and the promote escape hatch, then acts.
 *
 * Controlled open so the Apply button can keep the dialog up through progress
 * and close it only when the sweep finishes.
 *
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void, count?: number, onApplied?: () => void }} props
 */
export function DepHideSweepDialog({ open, onOpenChange, count = 0, onApplied }) {
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState(null)
  const fetchStats = useStatusStore((s) => s.fetchStats)

  const handleApply = useCallback(async () => {
    setWorking(true)
    setProgress(null)
    let cleanup = null
    try {
      cleanup = window.api.onApplyAutoHideProgress((data) => setProgress(data))
      await window.api.scan.applyAutoHide('deps')
      await window.api.settings.set('auto_hide_deps', '1')
      // The user has now acted on the offer; retire the nudge for good (like a
      // hard dismiss) so it can't resurface if some dependency content becomes
      // visible again later.
      useDepHideOfferStore.getState().dismissHard()
      fetchStats()
      onApplied?.()
    } catch (err) {
      toast(`Failed to hide dependency content: ${err.message}`, 'error', 5000)
    } finally {
      cleanup?.()
      setWorking(false)
      setProgress(null)
      onOpenChange(false)
    }
  }, [fetchStats, onApplied, onOpenChange])

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0

  return (
    <Dialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
      <DialogContent className="max-w-md" showCloseButton={!working}>
        <DialogHeader>
          <DialogTitle>Show only packages you installed?</DialogTitle>
          <DialogDescription>
            {count > 0 ? (
              <>
                Hides <strong className="text-text-primary">{count.toLocaleString()} dependency items</strong> so your
                VaM browser shows only the packages you installed, with a lot less to wade through.
              </>
            ) : (
              <>Your VaM browser will show only the packages you installed, with a lot less to wade through.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!working && (
          <ul className="flex flex-col gap-2">
            {SWEEP_POINTS.map(({ icon: Icon, body }) => (
              <li key={body} className="flex gap-2.5 text-[12px] leading-snug text-text-secondary">
                <Icon size={14} className="shrink-0 mt-0.5 text-text-aside" />
                <span className="min-w-0">{body}</span>
              </li>
            ))}
          </ul>
        )}

        {working && progress && progress.total > 0 && (
          <div className="space-y-2">
            <div className={cn('flex justify-between', META_DENSE)}>
              <span className="truncate pr-2">
                Hiding dependency content · {progress.current.toLocaleString()} of {progress.total.toLocaleString()}{' '}
                packages
              </span>
              <span className="shrink-0 text-text-secondary">{pct}%</span>
            </div>
            <Progress
              value={pct}
              className="h-[5px] bg-white/8"
              indicatorClassName="bg-linear-to-r from-accent-blue to-[#c040ee]"
            />
          </div>
        )}
        {working && (!progress || progress.total === 0) && (
          <div className={cn('flex items-center gap-2', META_DENSE)}>
            <Loader2 size={14} className="animate-spin shrink-0" />
            Hiding dependency content&hellip;
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={working}>
            Cancel
          </Button>
          <Button type="button" variant="gradient" onClick={handleApply} disabled={working} className="gap-1.5">
            {working ? <Loader2 size={14} className="animate-spin" /> : <EyeOff size={14} />}
            Hide dependency content
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Ephemeral, dismissible strip that offers the existing-library sweep when the
 * user is ready. Its only job is discovery; the decision + teaching happen in
 * {@link DepHideSweepDialog}.
 *
 * Visibility is driven by there still being visible dependency content
 * (`depContentVisible`) and the escalating dismissal state:
 *  - `variant="library"`: the general nudge on the default view; shown until
 *    soft-dismissed once.
 *  - `variant="dependency"`: the confident contextual nudge inside the
 *    Dependencies filter; shown until hard-dismissed. Once the user has
 *    dismissed any nudge once, it also carries a de-emphasized "Don't show
 *    again".
 *
 * Once the library is swept (`depContentVisible === 0`) nothing lingers.
 *
 * @param {{ variant?: 'library' | 'dependency' }} props
 */
export function DepHideOffer({ variant = 'library' }) {
  const depContentVisible = useStatusStore((s) => s.stats.depContentVisible || 0)
  const depCount = useStatusStore((s) => s.stats.depCount || 0)
  const eligible = useDepHideOfferStore((s) => s.eligible)
  const softDismissed = useDepHideOfferStore((s) => s.softDismissed)
  const hardDismissed = useDepHideOfferStore((s) => s.hardDismissed)
  const dismissSoft = useDepHideOfferStore((s) => s.dismissSoft)
  const dismissHard = useDepHideOfferStore((s) => s.dismissHard)
  const [dialogOpen, setDialogOpen] = useState(false)
  // Hides the strip for the rest of this appearance after a soft dismiss, so the
  // escalated "Don't show again" surfaces on a *later* appearance rather than
  // popping in the instant the user clicks the close X. Reset when the variant
  // changes: switching to the Dependencies filter is itself a fresh appearance.
  const [hiddenNow, setHiddenNow] = useState(false)
  useEffect(() => {
    setHiddenNow(false)
  }, [variant])

  const handleSoftDismiss = useCallback(() => {
    dismissSoft()
    setHiddenNow(true)
  }, [dismissSoft])

  const handleHardDismiss = useCallback(() => {
    dismissHard()
    toast('You can still hide dependency content anytime in Settings \u2192 Behavior.', 'info', 5000)
  }, [dismissHard])

  const unswept = depContentVisible > 0
  const isDepVariant = variant === 'dependency'
  // General nudge retires after one soft dismiss; the contextual variant persists
  // until an explicit "Don't show again" since you only meet it by choosing the
  // Dependencies filter.
  const visible = eligible && unswept && !hardDismissed && !hiddenNow && (isDepVariant || !softDismissed)

  if (!visible) return null

  const message = isDepVariant ? (
    <>
      Content from these {depCount.toLocaleString()} dependency packages is showing in VaM. Hide it so your browser
      shows only the packages you installed.
    </>
  ) : (
    <>
      Your VaM browser is showing {depContentVisible.toLocaleString()} items from dependency packages. Hide them so it
      shows only the packages you installed. Reversible anytime.
    </>
  )

  return (
    <div className="shrink-0 flex items-center gap-3 border-b border-border bg-accent-blue/6 px-4 py-2">
      <EyeOff size={14} className="shrink-0 text-accent-blue" />
      <span className={cn('min-w-0 flex-1', META_DENSE, 'text-text-secondary leading-snug')}>{message}</span>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="shrink-0 whitespace-nowrap text-[11px] font-medium text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer"
      >
        Hide dependency content
      </button>
      {softDismissed && (
        <>
          <span aria-hidden className="shrink-0 text-text-aside">
            ·
          </span>
          <button
            type="button"
            onClick={handleHardDismiss}
            className="shrink-0 whitespace-nowrap text-[11px] text-text-aside hover:text-text-secondary transition-colors cursor-pointer"
          >
            Don&apos;t show again
          </button>
        </>
      )}
      <button
        type="button"
        onClick={handleSoftDismiss}
        title="Dismiss"
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-text-aside hover:text-text-primary hover:bg-elevated cursor-pointer"
      >
        <X size={14} />
      </button>

      <DepHideSweepDialog open={dialogOpen} onOpenChange={setDialogOpen} count={depContentVisible} />
    </div>
  )
}
