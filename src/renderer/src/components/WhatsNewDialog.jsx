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

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {readonly { version: string, date: string, notes: string[] }[]} props.entries
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
      <DialogContent className="flex flex-col max-h-[85vh] max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground text-lg">
            What&apos;s new{version ? ` in v${version}` : ''}
          </DialogTitle>
          <DialogDescription className="text-sm text-foreground/80">
            Here&apos;s what&apos;s changed since your last launch.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1 -mr-1">
          {entries.map((entry) => (
            <section key={entry.version}>
              {!single && (
                <h3 className="text-xs font-medium text-muted-foreground mb-1.5">
                  v{entry.version} · {entry.date}
                </h3>
              )}
              <ul className="list-disc pl-4 space-y-1 text-sm text-foreground/95">
                {entry.notes.map((note, i) => (
                  <li key={i} className="leading-relaxed select-text">
                    {note}
                  </li>
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
