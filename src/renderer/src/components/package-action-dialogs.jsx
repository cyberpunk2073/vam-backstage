import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { activeBreakingDependents } from '@/lib/package-disable-confirm'
import { formatBytes } from '@/lib/utils'
import { isPackageArchived } from '@shared/storage-state-predicates.js'
import { EMPHASIS, CLARIFY } from '@/lib/typography'

const CONFIRM_LIST_MAX = 5

function NameList({ items, getName }) {
  const over = items.length - CONFIRM_LIST_MAX
  const cap = over === 1 ? items.length : CONFIRM_LIST_MAX
  const shown = items.slice(0, cap)
  const remaining = items.length - shown.length
  return (
    <ul className={`mt-1.5 mb-0.5 space-y-0.5 list-none p-0 ${CLARIFY}`}>
      {shown.map((item, i) => (
        <li key={i} className="text-text-secondary truncate">
          · {getName(item)}
        </li>
      ))}
      {remaining >= 2 && <li className="text-text-secondary">…and {remaining} more</li>}
    </ul>
  )
}

function depNames(deps) {
  if (!deps?.length) return ''
  const names = deps.slice(0, 2).map((d) => d.packageName?.split('.').pop() || d.filename)
  return names.join(', ') + (deps.length > 2 ? ` +${deps.length - 2}` : '')
}

/**
 * Local-only callout shared by deletion confirms.
 * `strong` — intentional delete (uninstall / force-remove / archive exit).
 * `trash` — orphan cleanup; irreplaceable but likely junk.
 */
export function LocalOnlyDeletionNote({ packages, tone = 'strong' }) {
  const localOnly = packages.filter((p) => p.isLocalOnly)
  if (!localOnly.length) return null
  const n = localOnly.length

  if (tone === 'trash') {
    return (
      <div>
        <p className="text-warning font-medium">
          {n} local-only package{n !== 1 ? 's are' : ' is'} not on the Hub — unused in practice, but
          {n !== 1 ? ' they' : ' it'} cannot be re-downloaded if you change your mind:
        </p>
        <NameList items={localOnly} getName={(p) => p.filename} />
      </div>
    )
  }

  if (n === 1 && packages.length === 1) {
    return (
      <p className="text-warning font-medium">
        This package is not available on the Hub. Once deleted, you will not be able to reinstall it.
      </p>
    )
  }
  return (
    <div>
      <p className="text-warning font-medium">
        {n} local-only package{n !== 1 ? 's are' : ' is'} not available on the Hub and cannot be reinstalled after
        deletion:
      </p>
      <NameList items={localOnly} getName={(p) => p.filename} />
    </div>
  )
}

/** Non-archived dependents — the only ones that demote on uninstall (Rule 1). */
export function hasPinningDependents(pkg) {
  return (pkg.dependents || []).some((d) => !isPackageArchived(d.storageState))
}

/**
 * Toast copy for a single-package uninstall result — everything the confirm
 * dialog couldn't promise up front: the target being relocated into the archive
 * instead of deleted, plus whatever the re-settle pass did to surviving deps.
 * Empty string when the uninstall was an ordinary delete (no toast needed).
 */
export function uninstallOutcomeMessage(res) {
  const bits = []
  if (res?.relocatedToArchive) bits.push('Moved to archive (still needed by archived packages)')
  if (res?.prunedDeps) bits.push(`${res.prunedDeps} unneeded dependenc${res.prunedDeps === 1 ? 'y' : 'ies'} deleted`)
  if (res?.depsMovedToArchive)
    bits.push(`${res.depsMovedToArchive} local-only dep${res.depsMovedToArchive === 1 ? '' : 's'} moved to archive`)
  return bits.join('; ')
}

/**
 * Confirm uninstall. Mirrors `packages:uninstall` Rule 1: only non-archived
 * dependents demote; archive-only + not Hub-replaceable → relocate into archive.
 */
export function UninstallDialogContent({ pkg, name, onConfirm }) {
  const contentCount = pkg.contents?.length || pkg.contentCount || 0
  const allRemovableDeps = pkg.removableDeps || []
  const hubRemovableDeps = allRemovableDeps.filter((d) => !d.isLocalOnly)
  const localOnlyDeps = allRemovableDeps.filter((d) => d.isLocalOnly)
  const hubRemovableSize = hubRemovableDeps.reduce((sum, d) => sum + (d.sizeBytes || 0), 0)
  const totalFreed = pkg.sizeBytes + hubRemovableSize

  const pinning = (pkg.dependents || []).filter((d) => !isPackageArchived(d.storageState))
  const archivedDeps = (pkg.dependents || []).filter((d) => isPackageArchived(d.storageState))
  // Archive-only + not verifiably replaceable → backend relocates (fail-safe when catalog unknown).
  const relocate = pinning.length === 0 && archivedDeps.length > 0 && pkg.isHubReplaceable !== true
  const demote = pinning.length > 0

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          {demote ? `Remove ${name}?` : `Uninstall ${name}?`}
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 select-text cursor-text">
            {!demote && !relocate && <LocalOnlyDeletionNote packages={[pkg]} />}
            {demote ? (
              <p>
                This package is still used by <strong className={EMPHASIS}>{depNames(pinning)}</strong>. It will be kept
                as a dependency but its {contentCount} content item
                {contentCount !== 1 ? 's' : ''} will be hidden.
              </p>
            ) : relocate ? (
              <p>
                Still needed by archived <strong className={EMPHASIS}>{depNames(archivedDeps)}</strong>. It will be
                moved to the archive instead of deleted.
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
                <p className={EMPHASIS}>Total space freed: {formatBytes(totalFreed)}</p>
              </>
            )}
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={demote || relocate ? 'destructive-outline' : 'destructive'} onClick={onConfirm}>
          {demote || relocate ? 'Remove' : 'Uninstall'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

export function DisablePackageDialogContent({ pkg, name, onConfirm }) {
  const dependents = activeBreakingDependents(pkg)
  const cascadeDeps = pkg.cascadeDisableDeps || []

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">Disable {name}?</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 select-text cursor-text">
            <p>The package will be marked as disabled. VaM will not load it.</p>
            {dependents.length > 0 && (
              <div>
                <p className="text-error font-medium">
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
  const localOnly = !!pkg.isLocalOnly

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          {hasDependents ? `Force delete ${name}?` : `Delete ${name} from disk?`}
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 select-text cursor-text">
            <LocalOnlyDeletionNote packages={[pkg]} />
            <p>The package file ({formatBytes(pkg.sizeBytes)}) will be permanently deleted from disk.</p>
            {hasDependents ? (
              <>
                <div>
                  <p className="text-error font-medium">
                    {dependents.length} package{dependents.length !== 1 ? 's' : ''} that depend on this will break:
                  </p>
                  <NameList items={dependents} getName={(d) => d.packageName?.split('.').pop() || d.filename} />
                </div>
                <p className="text-error">This cannot be undone.</p>
              </>
            ) : (
              <p>Nothing depends on this package.</p>
            )}
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant={hasDependents || localOnly ? 'destructive' : 'destructive-outline'}
          onClick={onConfirm}
        >
          {hasDependents ? 'Force Delete' : localOnly ? 'Delete permanently' : 'Delete'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

/** Bulk permanent delete (archive shelf). Always deletes; escalates when local-only. */
export function BulkForceRemoveDialogContent({ packages, onConfirm }) {
  const count = packages.length
  const irreversible = packages.some((p) => p.isLocalOnly)
  const totalBytes = packages.reduce((sum, p) => sum + (p.sizeBytes || 0), 0)

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          Delete {count} package{count !== 1 ? 's' : ''} from disk?
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 select-text cursor-text">
            <p>
              {count} package file{count !== 1 ? 's' : ''} ({formatBytes(totalBytes)}) will be permanently deleted from
              disk.
            </p>
            <LocalOnlyDeletionNote packages={packages} />
            <p className="text-error">This cannot be undone.</p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>
          {irreversible ? 'Delete permanently' : 'Delete'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

/**
 * Bulk library Remove (non-archive). Mix of uninstall (directs, may demote) and
 * force-remove (deps). Shares the local-only callout with permanent-delete dialogs.
 */
export function BulkLibraryRemoveDialogContent({ packages, onConfirm }) {
  const direct = packages.filter((p) => p.isDirect)
  const dep = packages.filter((p) => !p.isDirect)
  const irreversible = packages.some((p) => p.isLocalOnly)

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="select-text cursor-text">
          Remove {packages.length} package{packages.length !== 1 ? 's' : ''}?
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2 select-text cursor-text">
            {direct.length > 0 && (
              <p>
                {direct.length} installed package{direct.length !== 1 ? 's' : ''} will be uninstalled
                {direct.length > 1 ? '. Packages' : ', or'} demoted to dependency if other packages depend on them.
              </p>
            )}
            {dep.length > 0 && (
              <p>
                {dep.length} dependenc{dep.length !== 1 ? 'ies' : 'y'} will be removed from disk.
              </p>
            )}
            <LocalOnlyDeletionNote packages={packages} />
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>
          {irreversible ? 'Remove permanently' : 'Remove'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}
