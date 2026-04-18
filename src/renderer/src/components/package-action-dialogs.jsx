import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatBytes } from '@/lib/utils'

const CONFIRM_LIST_MAX = 5

function NameList({ items, getName }) {
  const over = items.length - CONFIRM_LIST_MAX
  const cap = over === 1 ? items.length : CONFIRM_LIST_MAX
  const shown = items.slice(0, cap)
  const remaining = items.length - shown.length
  return (
    <ul className="mt-1.5 mb-0.5 space-y-0.5 text-[11px] list-none p-0">
      {shown.map((item, i) => (
        <li key={i} className="text-muted-foreground truncate">
          · {getName(item)}
        </li>
      ))}
      {remaining >= 2 && <li className="text-muted-foreground/60">…and {remaining} more</li>}
    </ul>
  )
}

export function UninstallDialogContent({ pkg, name, hasDependents, dependentNames, onConfirm }) {
  const contentCount = pkg.contents?.length || pkg.contentCount || 0
  const allRemovableDeps = pkg.removableDeps || []
  const hubRemovableDeps = allRemovableDeps.filter((d) => !d.isLocalOnly)
  const localOnlyDeps = allRemovableDeps.filter((d) => d.isLocalOnly)
  const hubRemovableSize = hubRemovableDeps.reduce((sum, d) => sum + (d.sizeBytes || 0), 0)
  const totalFreed = pkg.sizeBytes + hubRemovableSize

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          {hasDependents ? `Remove ${name}?` : `Uninstall ${name}?`}
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 text-sm text-muted-foreground select-text cursor-text">
            {pkg.isLocalOnly && !hasDependents && (
              <p className="text-warning font-medium">
                This package is not available on the Hub. You will not be able to reinstall it.
              </p>
            )}
            {hasDependents ? (
              <p>
                This package is still used by <strong className="text-popover-foreground">{dependentNames}</strong>. It
                will be kept as a dependency but its {contentCount} content item{contentCount !== 1 ? 's' : ''} will be
                hidden.
              </p>
            ) : (
              <>
                <p>The package file ({formatBytes(pkg.sizeBytes)}) will be deleted from disk.</p>
                {hubRemovableDeps.length > 0 && (
                  <div>
                    <p>
                      {hubRemovableDeps.length} dependenc{hubRemovableDeps.length === 1 ? 'y' : 'ies'} no longer used by
                      anything else will also be removed:
                    </p>
                    <NameList items={hubRemovableDeps} getName={(d) => `${d.name} (${formatBytes(d.sizeBytes)})`} />
                  </div>
                )}
                {localOnlyDeps.length > 0 && (
                  <div>
                    <p className="text-warning">
                      {localOnlyDeps.length} local-only dependenc{localOnlyDeps.length === 1 ? 'y' : 'ies'} will not be
                      removed (not available on Hub, cannot be reinstalled):
                    </p>
                    <NameList items={localOnlyDeps} getName={(d) => `${d.name} (${formatBytes(d.sizeBytes)})`} />
                  </div>
                )}
                {contentCount > 0 && (
                  <p>
                    {contentCount} content item{contentCount !== 1 ? 's' : ''} will no longer appear in VaM.
                  </p>
                )}
                <p className="text-popover-foreground font-medium">Total space freed: {formatBytes(totalFreed)}</p>
              </>
            )}
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={hasDependents ? 'destructive-outline' : 'destructive'} onClick={onConfirm}>
          {hasDependents ? 'Remove' : 'Uninstall'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

export function DisablePackageDialogContent({ pkg, name, onConfirm }) {
  const dependents = pkg.dependents || []
  const cascadeDeps = pkg.cascadeDisableDeps || []

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">Disable {name}?</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 text-sm text-muted-foreground select-text cursor-text">
            <p>
              The package file will be renamed to <span className="font-mono text-[11px]">.var.disabled</span>. VaM will
              not load it.
            </p>
            {dependents.length > 0 && (
              <div>
                <p className="text-destructive font-medium">
                  {dependents.length} package{dependents.length !== 1 ? 's' : ''} that depend on this will break:
                </p>
                <NameList items={dependents} getName={(d) => d.packageName?.split('.').pop() || d.filename} />
              </div>
            )}
            {cascadeDeps.length > 0 && (
              <div>
                <p className="font-medium">
                  {cascadeDeps.length} unique dep{cascadeDeps.length !== 1 ? 's' : ''} will also be disabled:
                </p>
                <NameList items={cascadeDeps} getName={(d) => d.name || d.filename} />
              </div>
            )}
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>
          Disable
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

export function ForceRemoveDialogContent({ pkg, name, hasDependents, onConfirm }) {
  const dependents = pkg.dependents || []

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          {hasDependents ? `Force remove ${name}?` : `Remove ${name}?`}
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 text-sm text-muted-foreground select-text cursor-text">
            {pkg.isLocalOnly && (
              <p className="text-warning font-medium">
                This package is not available on the Hub. You will not be able to reinstall it.
              </p>
            )}
            <p>The package file ({formatBytes(pkg.sizeBytes)}) will be permanently deleted from disk.</p>
            {hasDependents ? (
              <>
                <div>
                  <p className="text-destructive font-medium">
                    {dependents.length} package{dependents.length !== 1 ? 's' : ''} that depend on this will break:
                  </p>
                  <NameList items={dependents} getName={(d) => d.packageName?.split('.').pop() || d.filename} />
                </div>
                <p className="text-destructive/80">This cannot be undone.</p>
              </>
            ) : (
              <p>Nothing depends on this package, so it is safe to remove.</p>
            )}
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={hasDependents ? 'destructive' : 'destructive-outline'} onClick={onConfirm}>
          {hasDependents ? 'Force Remove' : 'Remove'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}
