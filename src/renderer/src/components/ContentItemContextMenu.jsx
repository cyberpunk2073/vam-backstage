import { useState, useCallback, useMemo } from 'react'
import { Compass, Download, Eye, EyeOff, Library as LibraryIcon, Star } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { toast } from '@/components/Toast'
import { cn, displayName } from '@/lib/utils'
import { useContentStore } from '@/stores/useContentStore'
import { useIsDev } from '@/hooks/useIsDev'

const SCENE_TYPES = new Set(['scene', 'legacyScene'])
const EXTRACT_KIND_LABEL = { appearance: 'appearance', outfit: 'outfit' }

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

function toastExtractResult(label, result) {
  if (!result) return
  const w = result.written?.length ?? 0
  const s = result.skipped?.length ?? 0
  const e = result.errors?.length ?? 0
  if (e > 0) {
    toast(`${label}: ${w} written, ${s} skipped, ${e} error${e === 1 ? '' : 's'}`, 'error')
  } else if (w === 0) {
    toast(`${label}: nothing to extract (${s} already existed)`, 'info')
  } else {
    toast(`${label}: ${w} preset${w === 1 ? '' : 's'} written${s ? `, ${s} skipped` : ''}`, 'success')
  }
}

async function runExtractAndToast(kindLabel, payload) {
  try {
    const r = await window.api.extract.run(payload)
    toastExtractResult(`Extract ${kindLabel} preset${(r?.written?.length ?? 0) === 1 ? '' : 's'}`, r)
  } catch (err) {
    toast(`Extract failed: ${err.message}`)
  }
}

export function ContentItemContextMenu({ item, onNavigate, onToggleHidden, onToggleFavorite, children }) {
  const selectedItem = useContentStore((s) => s.selectedItem)
  const selectedPackage = useContentStore((s) => s.selectedPackage)
  const bulkSelectedIds = useContentStore((s) => s.bulkSelectedIds)
  const contents = useContentStore((s) => s.contents)
  const [pkg, setPkg] = useState(null)
  const [probe, setProbe] = useState(null)
  const isDev = useIsDev()

  const showBulk = bulkSelectedIds.length > 0 && bulkSelectedIds.includes(item.id)
  const isScene = SCENE_TYPES.has(item.type)

  const bulkSceneItems = useMemo(() => {
    if (!showBulk) return []
    return bulkSelectedIds.map((id) => contents.find((c) => c.id === id)).filter((c) => c && SCENE_TYPES.has(c.type))
  }, [showBulk, bulkSelectedIds, contents])

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
        if (isDev && isScene && !showBulk) {
          setProbe(null)
          window.api.extract
            .probeScene({ packageFilename: item.packageFilename, internalPath: item.internalPath })
            .then(setProbe)
            .catch(() => setProbe({ atoms: [], error: true }))
        }
      } else {
        setPkg(null)
        setProbe(null)
      }
    },
    [item.id, item.packageFilename, item.internalPath, selectedItem, selectedPackage, isDev, isScene, showBulk],
  )

  const hubLabel = pkg
    ? displayName(pkg)
    : displayName({
        hubDisplayName: item.packageHubDisplayName,
        title: item.packageTitle,
        packageName: item.packageName,
        filename: item.packageFilename,
      })

  const missingByKind = useMemo(() => {
    if (!probe?.atoms?.length) return null
    const out = {}
    for (const kind of ['appearance', 'clothing']) {
      const missing = probe.atoms.filter((a) => !a.outputs[kind].exists)
      if (missing.length) out[kind] = missing
    }
    return out
  }, [probe])

  const renderExtractEntries = () => {
    if (!isDev || !isScene || !probe || !missingByKind) return null
    const entries = []
    for (const [kindKey, missing] of Object.entries(missingByKind)) {
      const kind = kindKey === 'clothing' ? 'outfit' : 'appearance'
      const label = EXTRACT_KIND_LABEL[kind]
      if (missing.length === 1) {
        entries.push(
          <ContextMenuItem
            key={`extract-${kind}`}
            onSelect={() =>
              void runExtractAndToast(label, {
                packageFilename: item.packageFilename,
                internalPath: item.internalPath,
                atomIds: [missing[0].atomId],
                kind,
              })
            }
          >
            <Download size={12} className="shrink-0 text-accent-blue" />
            Extract {label} preset
          </ContextMenuItem>,
        )
      } else {
        entries.push(
          <ContextMenuSub key={`extract-${kind}`}>
            <ContextMenuSubTrigger>
              <Download size={12} className="shrink-0 text-accent-blue" />
              Extract {label} preset
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() =>
                  void runExtractAndToast(label, {
                    packageFilename: item.packageFilename,
                    internalPath: item.internalPath,
                    atomIds: missing.map((a) => a.atomId),
                    kind,
                  })
                }
              >
                Extract all ({missing.length})
              </ContextMenuItem>
              <ContextMenuSeparator />
              {missing.map((a) => (
                <ContextMenuItem
                  key={a.atomId}
                  onSelect={() =>
                    void runExtractAndToast(label, {
                      packageFilename: item.packageFilename,
                      internalPath: item.internalPath,
                      atomIds: [a.atomId],
                      kind,
                    })
                  }
                >
                  {a.atomId}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>,
        )
      }
    }
    return entries
  }

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
            {isDev && bulkSceneItems.length > 0 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() =>
                    void runExtractAndToast('appearance', {
                      items: bulkSceneItems.map((c) => ({
                        packageFilename: c.packageFilename,
                        internalPath: c.internalPath,
                      })),
                      kind: 'appearance',
                    })
                  }
                >
                  <Download size={12} className="shrink-0 text-accent-blue" />
                  Extract appearance presets ({bulkSceneItems.length})
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    void runExtractAndToast('outfit', {
                      items: bulkSceneItems.map((c) => ({
                        packageFilename: c.packageFilename,
                        internalPath: c.internalPath,
                      })),
                      kind: 'outfit',
                    })
                  }
                >
                  <Download size={12} className="shrink-0 text-accent-blue" />
                  Extract outfit presets ({bulkSceneItems.length})
                </ContextMenuItem>
              </>
            )}
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
            {renderExtractEntries()}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
