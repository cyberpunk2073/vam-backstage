import { useState } from 'react'
import { Check, CircleMinus, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { toast } from '@/components/Toast'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
import { COLOR_AUTO, COLOR_NONE, LABEL_NONE_COLOR, LABEL_PALETTE, labelColor } from '@/lib/labels'

const SHARP_PALETTE_INDICES = LABEL_PALETTE.map((_, i) => i).filter((i) => !LABEL_PALETTE[i].soft)
const SOFT_PALETTE_INDICES = LABEL_PALETTE.map((_, i) => i).filter((i) => LABEL_PALETTE[i].soft)

/**
 * Right-click menu wrapping a label chip / row. Surface variants:
 *   - 'item'    — chip in detail panel; includes "Remove from this item"; can add
 *                 "Enable / Disable all packages" when `onEnableMatching` / `onDisableMatching` are passed
 *   - 'card'    — chip / dot in a card or apply-widget row; standard set
 *   - 'sidebar' — row in filter sidebar; same package enable/disable actions when those callbacks are passed
 *
 * All callbacks are optional. `onRemoveFromItem` only matters in 'item' surface.
 * `onStartRename` flips the chip into inline-edit mode in the parent. `onDeleted`
 * runs after a successful delete. The delete confirmation `AlertDialog` lives
 * inside this component so the consumer doesn't need to wire it.
 */
export function LabelManageMenu({
  label,
  surface = 'card',
  applicationCount = 0,
  asChild = true,
  children,
  onStartRename,
  onRemoveFromItem,
  onDeleted,
  // sidebar & detail row: enable/disable every package carrying this label
  onEnableMatching,
  onDisableMatching,
}) {
  const matchingPackageCount = label?.packageCount ?? 0
  const [confirmOpen, setConfirmOpen] = useState(false)

  if (!label) return children ?? null

  const currentColor = label.color
  const handleRecolor = async (color) => {
    try {
      await window.api.labels.recolor({ id: label.id, color })
    } catch (err) {
      toast(`Failed to change color: ${err.message}`)
    }
  }
  const handleDelete = async () => {
    try {
      await window.api.labels.delete({ id: label.id })
      onDeleted?.()
    } catch (err) {
      toast(`Failed to delete label: ${err.message}`)
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild={asChild}>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuLabel>{label.name}</ContextMenuLabel>
          {surface === 'item' && onRemoveFromItem && (
            <>
              <ContextMenuItem onSelect={() => onRemoveFromItem()}>
                <CircleMinus size={12} className="shrink-0" />
                Remove from this item
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {onStartRename && (
            <ContextMenuItem onSelect={() => onStartRename()}>
              <Pencil size={12} className="shrink-0" />
              Rename label
            </ContextMenuItem>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: labelColor(label) }} />
              Color
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-36">
              <ContextMenuItem onSelect={() => handleRecolor(COLOR_AUTO)}>
                <span className="w-2 h-2 rounded-full shrink-0 border border-text-tertiary" />
                Auto
                {currentColor === COLOR_AUTO && <Check size={11} className="ml-auto" />}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => handleRecolor(COLOR_NONE)}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: LABEL_NONE_COLOR }} />
                None
                {currentColor === COLOR_NONE && <Check size={11} className="ml-auto" />}
              </ContextMenuItem>
              <ContextMenuSeparator />
              {SHARP_PALETTE_INDICES.map((i) => (
                <ContextMenuItem key={i} onSelect={() => handleRecolor(i)}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: LABEL_PALETTE[i].hex }} />
                  {LABEL_PALETTE[i].name}
                  {currentColor === i && <Check size={11} className="ml-auto" />}
                </ContextMenuItem>
              ))}
              {SOFT_PALETTE_INDICES.length > 0 && <ContextMenuSeparator />}
              {SOFT_PALETTE_INDICES.map((i) => (
                <ContextMenuItem key={i} onSelect={() => handleRecolor(i)}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: LABEL_PALETTE[i].hex }} />
                  {LABEL_PALETTE[i].name}
                  {currentColor === i && <Check size={11} className="ml-auto" />}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>

          {(surface === 'sidebar' || surface === 'item') &&
            (onEnableMatching || onDisableMatching) &&
            matchingPackageCount > 0 && (
              <>
                <ContextMenuSeparator />
                {onEnableMatching && (
                  <ContextMenuItem onSelect={() => onEnableMatching()}>
                    <Eye size={12} className="shrink-0" />
                    {`Enable all packages (${matchingPackageCount})`}
                  </ContextMenuItem>
                )}
                {onDisableMatching && (
                  <ContextMenuItem onSelect={() => onDisableMatching()}>
                    <EyeOff size={12} className="shrink-0" />
                    {`Disable all packages (${matchingPackageCount})`}
                  </ContextMenuItem>
                )}
              </>
            )}

          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => {
              if (applicationCount > 0) setConfirmOpen(true)
              else void handleDelete()
            }}
          >
            <Trash2 size={12} className="shrink-0" />
            Delete label
            {applicationCount > 0 ? ` (${applicationCount})` : ''}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{label.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              {applicationCount > 0
                ? `The label is currently applied to ${applicationCount} item${applicationCount === 1 ? '' : 's'}. It will be removed from all of them. This cannot be undone.`
                : 'This label has no items applied. It will be removed permanently.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
