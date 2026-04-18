import { useState, useCallback, useMemo } from 'react'
import { Compass, Eye, EyeOff, Library as LibraryIcon, Star } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { toast } from '@/components/Toast'
import { cn, displayName } from '@/lib/utils'
import { useContentStore } from '@/stores/useContentStore'

function applyBulkVisibilityFromStore() {
  const { contents, bulkSelectedIds } = useContentStore.getState()
  const items = contents.filter((c) => bulkSelectedIds.includes(c.id) && c.isEnabled)
  if (!items.length) return
  const hiddenCount = items.filter((i) => i.hidden).length
  const allHidden = hiddenCount === items.length
  const hidden = allHidden ? false : true
  void window.api.contents.setHiddenBatch({
    items: items.map((c) => ({ id: c.id, packageFilename: c.packageFilename, internalPath: c.internalPath })),
    hidden,
  })
}

function applyBulkFavoriteFromStore() {
  const { contents, bulkSelectedIds } = useContentStore.getState()
  const items = contents.filter((c) => bulkSelectedIds.includes(c.id))
  if (!items.length) return
  const favCount = items.filter((i) => i.favorite).length
  const allFav = favCount === items.length
  const favorite = allFav ? false : true
  void window.api.contents.setFavoriteBatch({
    items: items.map((c) => ({ id: c.id, packageFilename: c.packageFilename, internalPath: c.internalPath })),
    favorite,
  })
}

export function ContentItemContextMenu({ item, onNavigate, onToggleHidden, onToggleFavorite, children }) {
  const selectedItem = useContentStore((s) => s.selectedItem)
  const selectedPackage = useContentStore((s) => s.selectedPackage)
  const bulkSelectedIds = useContentStore((s) => s.bulkSelectedIds)
  const contents = useContentStore((s) => s.contents)
  const [pkg, setPkg] = useState(null)

  const showBulk = bulkSelectedIds.length > 0 && bulkSelectedIds.includes(item.id)
  const bulkVisibilityEligible = useMemo(
    () => bulkSelectedIds.some((id) => contents.find((c) => c.id === id)?.isEnabled),
    [bulkSelectedIds, contents],
  )

  const bulkVisibilityUi = useMemo(() => {
    const items = bulkSelectedIds.map((id) => contents.find((c) => c.id === id)).filter(Boolean)
    const eligible = items.filter((c) => c.isEnabled)
    if (!eligible.length) return { label: 'Hide', allHidden: false, allVisible: false, mixed: false }
    const hiddenCount = eligible.filter((c) => c.hidden).length
    const allHidden = hiddenCount === eligible.length
    const allVisible = hiddenCount === 0
    const mixed = !allHidden && !allVisible
    const label = allHidden ? 'Show' : 'Hide'
    return { label, allHidden, allVisible, mixed }
  }, [bulkSelectedIds, contents])

  const bulkFavoriteUi = useMemo(() => {
    const items = bulkSelectedIds.map((id) => contents.find((c) => c.id === id)).filter(Boolean)
    if (!items.length) return { label: 'Favorite', mixed: false, allFav: false, allUnfav: true }
    const favCount = items.filter((c) => c.favorite).length
    const allFav = favCount === items.length
    const allUnfav = favCount === 0
    const mixed = !allFav && !allUnfav
    const label = allFav && !mixed ? 'Unfavorite' : 'Favorite'
    return { label, mixed, allFav, allUnfav }
  }, [bulkSelectedIds, contents])

  const onOpenChange = useCallback(
    (open) => {
      if (open) {
        if (selectedItem?.id === item.id && selectedPackage?.filename === item.packageFilename) {
          setPkg(selectedPackage)
        } else {
          setPkg(null)
          void window.api.packages
            .detail(item.packageFilename)
            .then(setPkg)
            .catch((err) => toast(`Failed to load package: ${err.message}`))
        }
      } else {
        setPkg(null)
      }
    },
    [item.id, item.packageFilename, selectedItem, selectedPackage],
  )

  const hubLabel = pkg
    ? displayName(pkg)
    : displayName({
        hubDisplayName: item.packageHubDisplayName,
        title: item.packageTitle,
        packageName: item.packageName,
        filename: item.packageFilename,
      })

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {showBulk ? (
          <>
            <ContextMenuItem disabled={!bulkVisibilityEligible} onSelect={() => applyBulkVisibilityFromStore()}>
              {bulkVisibilityUi.allHidden ? (
                <Eye size={12} className="shrink-0 text-text-secondary" />
              ) : (
                <EyeOff
                  size={12}
                  className={bulkVisibilityUi.mixed ? 'shrink-0 text-text-tertiary' : 'shrink-0 text-text-secondary'}
                />
              )}
              {bulkVisibilityUi.label} ({bulkSelectedIds.length})
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => applyBulkFavoriteFromStore()}>
              <Star
                size={12}
                className={cn(
                  'shrink-0',
                  bulkFavoriteUi.allFav && !bulkFavoriteUi.mixed && 'text-text-secondary',
                  bulkFavoriteUi.mixed && 'text-text-tertiary',
                  bulkFavoriteUi.allUnfav && !bulkFavoriteUi.mixed && 'text-warning',
                )}
                fill={bulkFavoriteUi.allFav && !bulkFavoriteUi.mixed ? 'none' : 'currentColor'}
              />
              {bulkFavoriteUi.label} ({bulkSelectedIds.length})
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem
              disabled={!item.isEnabled}
              onSelect={() => {
                if (item.isEnabled) onToggleHidden?.(item)
              }}
            >
              {!item.isEnabled ? (
                <>
                  <EyeOff size={12} className="shrink-0" />
                  Package is disabled
                </>
              ) : item.hidden ? (
                <>
                  <Eye size={12} className="shrink-0" />
                  Show
                </>
              ) : (
                <>
                  <EyeOff size={12} className="shrink-0" />
                  Hide
                </>
              )}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                onToggleFavorite?.(item)
              }}
            >
              <Star size={12} className="shrink-0" fill={item.favorite ? 'currentColor' : 'none'} />
              {item.favorite ? 'Unfavorite' : 'Favorite'}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => {
                onNavigate?.('library', { selectPackage: item.packageFilename })
              }}
            >
              <LibraryIcon size={12} className="shrink-0 text-accent-blue" />
              Open package in Library
            </ContextMenuItem>
            {pkg?.hubResourceId ? (
              <ContextMenuItem
                onSelect={() =>
                  onNavigate?.('hub', {
                    openResource: {
                      resource_id: pkg.hubResourceId,
                      title: hubLabel,
                      username: pkg.creator,
                      type: pkg.type,
                    },
                  })
                }
              >
                <Compass size={12} className="shrink-0 text-accent-blue" />
                View package on Hub
              </ContextMenuItem>
            ) : null}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
