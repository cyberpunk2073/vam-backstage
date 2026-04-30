import { Gift, Wrench, Bug } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/** @typedef {import('@/lib/changelog').ChangelogEntry} ChangelogEntry */
/** @typedef {import('@/lib/changelog').ChangelogNote} ChangelogNote */

const KIND_META = {
  new: { Icon: Gift, label: 'New', colorCls: 'text-emerald-400/70' },
  improved: { Icon: Wrench, label: 'Improved', colorCls: 'text-sky-400/70' },
  fixed: { Icon: Bug, label: 'Fixed', colorCls: 'text-amber-400/70' },
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {readonly ChangelogEntry[]} props.entries
 * @param {string} props.version app version to record when dismissed
 * @param {() => void} props.onDismiss called on close (X, overlay click, or Got it)
 */
export function WhatsNewDialog({ open, entries, version, onDismiss }) {
  const single = entries.length === 1
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <DialogContent className="flex flex-col max-h-[85vh] max-w-lg sm:max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground text-lg">
            What&apos;s new{version ? ` in v${version}` : ''}
          </DialogTitle>
          <DialogDescription className="text-sm text-foreground/80">
            Here&apos;s what&apos;s changed since your last launch.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1 space-y-5">
          {entries.map((entry) => (
            <section key={entry.version} className="space-y-2.5">
              {!single && (
                <div className="flex items-baseline gap-2 pb-1 border-b border-border/60">
                  <span className="font-heading text-sm font-semibold text-accent-blue">v{entry.version}</span>
                  <span className="text-xs text-muted-foreground">{entry.date}</span>
                </div>
              )}
              <ul className="space-y-2.5">
                {entry.notes.map((note, i) => (
                  <NoteRow key={i} note={note} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Got it</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** @param {{ note: ChangelogNote }} props */
function NoteRow({ note }) {
  const meta = KIND_META[note.kind] ?? KIND_META.new
  const { Icon } = meta
  return (
    <li className="flex gap-2.5">
      <Icon size={13} className={`mt-[5px] shrink-0 ${meta.colorCls}`} aria-label={meta.label} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground select-text">{note.title}</div>
        <div className="text-[13px] text-foreground/65 leading-snug select-text">{note.body}</div>
      </div>
    </li>
  )
}
