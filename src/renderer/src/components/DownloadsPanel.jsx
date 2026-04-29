import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  X,
  Download,
  CheckCircle,
  Clock,
  XCircle,
  RotateCw,
  ArrowDown,
  ChevronUp,
  Pause,
  Play,
  Trash2,
} from 'lucide-react'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { formatBytes, displayName as pkgDisplayName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
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
import ResizeHandle from './ResizeHandle'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return ''
  return formatBytes(bytesPerSec) + '/s'
}

function formatTimeAgo(unixTs) {
  if (!unixTs) return ''
  const diff = Math.floor(Date.now() / 1000) - unixTs
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function downloadLabel(item) {
  return item.display_name || pkgDisplayName({ filename: item.package_ref })
}

/** Matches main download manager pickNextQueued: direct first, then FIFO by created_at */
function sortQueuedNextFirst(a, b) {
  const da = a.priority === 'direct'
  const db = b.priority === 'direct'
  if (da && !db) return -1
  if (!da && db) return 1
  return (a.created_at || 0) - (b.created_at || 0)
}

function sortCompletedRecentFirst(a, b) {
  return (b.completed_at || 0) - (a.completed_at || 0)
}

const SECTION_CAP = 5

export default function DownloadsPanel({ onClose }) {
  const { items, liveProgress, paused, cancel, retry, removeFailed, clearCompleted, pauseAll, resumeAll, cancelAll } =
    useDownloadStore()

  const [panelWidth, setPanelWidth] = usePersistedPanelWidth('panel_width_downloads', {
    min: 200,
    max: 500,
    defaultWidth: 340,
  })
  const startWidthRef = useRef(panelWidth)
  const onResizeStart = useCallback(() => {
    startWidthRef.current = panelWidth
  }, [panelWidth])
  const onPanelResize = useCallback(
    (delta) => setPanelWidth(Math.min(500, Math.max(200, startWidthRef.current + delta))),
    [setPanelWidth],
  )

  useEffect(() => {
    useDownloadStore.getState().init()
  }, [])

  const active = items.filter((d) => d.status === 'active')
  const queued = items.filter((d) => d.status === 'queued').sort(sortQueuedNextFirst)
  const completed = items.filter((d) => d.status === 'completed').sort(sortCompletedRecentFirst)
  const failed = items.filter((d) => d.status === 'failed')
  const hasAny = active.length + queued.length + completed.length + failed.length > 0
  const hasInFlight = active.length + queued.length > 0

  const { totalSpeed, totalRemaining } = useMemo(() => {
    let speed = 0
    let remaining = 0
    for (const item of active) {
      const live = liveProgress[item.id] || {}
      speed += live.speed || 0
      const loaded = live.bytesLoaded || 0
      const size = item.file_size || 0
      if (size > loaded) remaining += size - loaded
    }
    for (const item of queued) {
      if (item.file_size) remaining += item.file_size
    }
    return { totalSpeed: speed, totalRemaining: remaining }
  }, [active, queued, liveProgress])

  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)

  const retryAllFailed = useCallback(() => {
    for (const item of failed) retry(item.id)
  }, [failed, retry])

  return (
    <div className="flex shrink-0" style={{ width: panelWidth }}>
      <div className="flex-1 min-w-0 bg-surface border-r border-border flex flex-col h-full">
        {/* Title */}
        <div className="h-11 flex items-center justify-between px-4 border-b border-border shrink-0">
          <span className="text-[13px] font-medium text-text-primary flex items-center gap-2">
            <Download size={15} /> Downloads
          </span>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        {/* Aggregate status */}
        {hasInFlight && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0 text-[11px] text-text-secondary">
            {paused ? (
              <Pause size={12} className="text-text-tertiary shrink-0" />
            ) : (
              <ArrowDown size={12} className="text-text-tertiary shrink-0" />
            )}
            <span className="min-w-0 truncate">
              {paused
                ? 'Paused'
                : totalSpeed > 0 || totalRemaining > 0
                  ? [
                      totalSpeed > 0 && formatSpeed(totalSpeed),
                      totalRemaining > 0 && `${formatBytes(totalRemaining)} left`,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : `${active.length} active`}
            </span>
            <div className="flex items-center gap-0.5 ml-auto shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-text-tertiary hover:text-text-secondary"
                title={paused ? 'Resume downloads' : 'Pause downloads'}
                onClick={paused ? resumeAll : pauseAll}
              >
                {paused ? <Play size={12} /> : <Pause size={12} />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-text-tertiary hover:text-error"
                title="Cancel all downloads"
                onClick={() => setConfirmCancelOpen(true)}
              >
                <XCircle size={12} />
              </Button>
            </div>
          </div>
        )}
        <AlertDialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel all downloads?</AlertDialogTitle>
              <AlertDialogDescription>
                {active.length + queued.length} download{active.length + queued.length !== 1 ? 's' : ''} will be
                cancelled.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep downloading</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => cancelAll()}>
                Cancel all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex-1 overflow-y-auto">
          {/* Active */}
          {active.length > 0 && (
            <Section title="Active" count={active.length}>
              {active.map((item) => (
                <ActiveItem key={item.id} item={item} liveProgress={liveProgress} onCancel={cancel} />
              ))}
            </Section>
          )}

          {/* Queued */}
          {queued.length > 0 && (
            <CappedSection
              title="Queued"
              count={queued.length}
              items={queued}
              renderItem={(item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2.5 px-4 py-1.5 hover:bg-elevated transition-colors"
                >
                  <Clock size={12} className="text-text-tertiary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary truncate select-text cursor-text">
                      {downloadLabel(item)}
                    </div>
                  </div>
                </div>
              )}
            />
          )}

          {/* Failed */}
          {failed.length > 0 && (
            <Section
              title="Failed"
              count={failed.length}
              action={failed.length > 1 ? { label: 'Retry all', onClick: retryAllFailed } : null}
            >
              {failed.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2.5 px-4 py-1.5 hover:bg-elevated transition-colors"
                >
                  <XCircle size={12} className="text-error shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary truncate select-text cursor-text">
                      {downloadLabel(item)}
                    </div>
                    {item.error && (
                      <div className="text-[10px] text-error truncate select-text cursor-text">{item.error}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button variant="ghost" size="icon-xs" onClick={() => retry(item.id)} title="Retry">
                      <RotateCw size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeFailed(item.id)}
                      title="Remove"
                      className="text-text-tertiary hover:text-error"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* Completed */}
          {completed.length > 0 && (
            <CappedSection
              title="Completed"
              count={completed.length}
              action={{ label: 'Clear', onClick: clearCompleted }}
              items={completed}
              renderItem={(item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2.5 px-4 py-1.5 hover:bg-elevated transition-colors"
                >
                  <CheckCircle size={12} className="text-success shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary truncate select-text cursor-text">
                      {downloadLabel(item)}
                    </div>
                  </div>
                  <span className="text-[10px] text-text-tertiary shrink-0">{formatTimeAgo(item.completed_at)}</span>
                </div>
              )}
            />
          )}

          {!hasAny && (
            <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
              <Download size={24} className="opacity-20 mb-2" />
              <span className="text-[11px]">No downloads</span>
            </div>
          )}
        </div>
      </div>
      <ResizeHandle side="right" onResizeStart={onResizeStart} onResize={onPanelResize} />
    </div>
  )
}

function ActiveItem({ item, liveProgress, onCancel }) {
  const live = liveProgress[item.id] || {}
  const progress = live.progress ?? item.progress ?? 0
  const speed = live.speed ?? 0

  return (
    <div className="group/active px-4 py-1.5 hover:bg-elevated transition-colors">
      <div className="flex items-center gap-1.5 mb-1">
        <div className="min-w-0 flex-1 text-xs text-text-primary truncate select-text cursor-text">
          {downloadLabel(item)}
        </div>
        <span className="text-[10px] text-text-tertiary shrink-0">
          {progress}%{speed > 0 ? ` · ${formatSpeed(speed)}` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onCancel(item.id)}
          title="Cancel"
          className="opacity-0 group-hover/active:opacity-100 text-text-tertiary hover:text-error transition-opacity shrink-0"
        >
          <XCircle size={12} />
        </Button>
      </div>
      <Progress value={progress} className="h-[3px] bg-elevated" indicatorClassName="progress-bar" />
    </div>
  )
}

function Section({ title, count, action, children }) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-4 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-medium">{title}</span>
        <span className="text-[10px] text-text-tertiary">{count}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="text-[10px] text-text-tertiary hover:text-text-secondary ml-auto cursor-pointer transition-colors"
          >
            {action.label}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function CappedSection({ title, count, action, items, renderItem }) {
  const [expanded, setExpanded] = useState(false)
  const total = items.length
  const collapsible = total > 6
  const visible = expanded || !collapsible ? items : items.slice(0, SECTION_CAP)
  const remaining = expanded ? 0 : collapsible ? total - SECTION_CAP : 0

  return (
    <Section title={title} count={count} action={action}>
      {visible.map(renderItem)}
      {!expanded && remaining >= 2 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full px-2 py-1.5 text-[10px] text-text-tertiary hover:bg-elevated hover:text-text-secondary cursor-pointer text-center transition-colors"
        >
          + {remaining} more
        </button>
      )}
      {expanded && collapsible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full py-1 flex items-center justify-center text-text-tertiary hover:bg-elevated hover:text-text-secondary cursor-pointer transition-colors"
        >
          <ChevronUp size={14} />
        </button>
      )}
    </Section>
  )
}
