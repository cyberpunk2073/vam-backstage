import { useState, useCallback, useMemo } from 'react'
import { Compass, Download, Eye, EyeOff, Library as LibraryIcon, Star, Tag } from 'lucide-react'
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
import { useLabelsStore } from '@/stores/useLabelsStore'
import { LabelsApplyMenuItems } from '@/components/labels/LabelsApplyMenuItems'
import { singleTargetStateMap, bulkStateMap } from '@/components/labels/labelApplyState'
import { applyLabelToContentItems } from '@/components/labels/labelActions'

const SCENE_SOURCE_TYPES = new Set(['scene', 'legacyScene'])
const LOOK_SOURCE_TYPES = new Set(['legacyLook'])
const KIND_NOUN = { appearance: 'appearance', outfit: 'outfit' }

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

async function runExtractAndToast(actionLabel, payload) {
  try {
    const r = await window.api.extract.run(payload)
    toastExtractResult(`${actionLabel} preset${(r?.written?.length ?? 0) === 1 ? '' : 's'}`, r)
  } catch (err) {
    toast(`${actionLabel} failed: ${err.message}`)
  }
}

export function ContentItemContextMenu({ item, onNavigate, onToggleHidden, onToggleFavorite, children }) {
  const selectedItem = useContentStore((s) => s.selectedItem)
  const selectedPackage = useContentStore((s) => s.selectedPackage)
  const bulkSelectedIds = useContentStore((s) => s.bulkSelectedIds)
  const contents = useContentStore((s) => s.contents)
  const labels = useLabelsStore((s) => s.labels)
  const [pkg, setPkg] = useState(null)
  const [probe, setProbe] = useState(null)

  const showBulk = bulkSelectedIds.length > 0 && bulkSelectedIds.includes(item.id)
  const isScene = SCENE_SOURCE_TYPES.has(item.type)
  const isLook = LOOK_SOURCE_TYPES.has(item.type)
  const isExtractable = isScene || isLook

  const bulkSceneItems = useMemo(() => {
    if (!showBulk) return []
    return bulkSelectedIds
      .map((id) => contents.find((c) => c.id === id))
      .filter((c) => c && SCENE_SOURCE_TYPES.has(c.type))
  }, [showBulk, bulkSelectedIds, contents])

  const bulkLookItems = useMemo(() => {
    if (!showBulk) return []
    return bulkSelectedIds
      .map((id) => contents.find((c) => c.id === id))
      .filter((c) => c && LOOK_SOURCE_TYPES.has(c.type))
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

  const labelTargetItems = useMemo(() => {
    if (!showBulk) return [{ packageFilename: item.packageFilename, internalPath: item.internalPath }]
    return bulkSelectedIds
      .map((id) => contents.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => ({ packageFilename: c.packageFilename, internalPath: c.internalPath }))
  }, [showBulk, bulkSelectedIds, contents, item.packageFilename, item.internalPath])

  const labelStateMap = useMemo(() => {
    if (!showBulk) return singleTargetStateMap(item.ownLabelIds || [])
    const targets = bulkSelectedIds.map((id) => contents.find((c) => c.id === id)).filter(Boolean)
    return bulkStateMap(targets.map((c) => c.ownLabelIds || []))
  }, [showBulk, bulkSelectedIds, contents, item.ownLabelIds])

  const handleLabelToggle = async (label, currentState) => {
    const apply = currentState !== 'all'
    await applyLabelToContentItems(label.id, labelTargetItems, apply)
  }

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
    async (open) => {
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
        if (isExtractable && !showBulk) {
          try {
            setProbe(
              await window.api.extract.probeScene({
                packageFilename: item.packageFilename,
                internalPath: item.internalPath,
              }),
            )
          } catch {
            setProbe({ atoms: [], error: true })
          }
        }
      } else {
        setPkg(null)
        setProbe(null)
      }
    },
    [item.id, item.packageFilename, item.internalPath, selectedItem, selectedPackage, isExtractable, showBulk],
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
    const kinds = isScene ? ['appearance', 'clothing'] : ['appearance']
    const out = {}
    for (const kind of kinds) {
      const missing = probe.atoms.filter((a) => !a.outputs[kind].exists)
      if (missing.length) out[kind] = missing
    }
    return out
  }, [probe, isScene])

  const renderExtractEntries = () => {
    if (!isExtractable || !probe || !missingByKind) return null
    // Scenes → "Extract <kind> preset". Legacy looks → "Convert to appearance preset".
    const verb = isLook ? 'Convert to' : 'Extract'
    const entries = []
    for (const [kindKey, missing] of Object.entries(missingByKind)) {
      const kind = kindKey === 'clothing' ? 'outfit' : 'appearance'
      const noun = KIND_NOUN[kind]
      const actionLabel = `${verb} ${noun}`
      if (missing.length === 1) {
        entries.push(
          <ContextMenuItem
            key={`extract-${kind}`}
            onSelect={() =>
              void runExtractAndToast(actionLabel, {
                packageFilename: item.packageFilename,
                internalPath: item.internalPath,
                atomIds: [missing[0].atomId],
                kind,
              })
            }
          >
            <Download size={12} className="shrink-0 text-accent-blue" />
            {actionLabel} preset
          </ContextMenuItem>,
        )
      } else {
        entries.push(
          <ContextMenuSub key={`extract-${kind}`}>
            <ContextMenuSubTrigger>
              <Download size={12} className="shrink-0 text-accent-blue" />
              {actionLabel} preset
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() =>
                  void runExtractAndToast(actionLabel, {
                    packageFilename: item.packageFilename,
                    internalPath: item.internalPath,
                    atomIds: missing.map((a) => a.atomId),
                    kind,
                  })
                }
              >
                {isLook ? 'Convert' : 'Extract'} all ({missing.length})
              </ContextMenuItem>
              <ContextMenuSeparator />
              {missing.map((a) => (
                <ContextMenuItem
                  key={a.atomId}
                  onSelect={() =>
                    void runExtractAndToast(actionLabel, {
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
      <ContextMenuContent className="min-w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        {showBulk ? (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Tag size={12} className="shrink-0" />
                Labels ({bulkSelectedIds.length})
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <LabelsApplyMenuItems labels={labels} stateById={labelStateMap} onToggle={handleLabelToggle} />
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
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
            {(bulkSceneItems.length > 0 || bulkLookItems.length > 0) && (
              <>
                <ContextMenuSeparator />
                {bulkSceneItems.length > 0 && (
                  <>
                    <ContextMenuItem
                      onSelect={() =>
                        void runExtractAndToast('Extract appearance', {
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
                        void runExtractAndToast('Extract outfit', {
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
                {bulkLookItems.length > 0 && (
                  <ContextMenuItem
                    onSelect={() =>
                      void runExtractAndToast('Convert to appearance', {
                        items: bulkLookItems.map((c) => ({
                          packageFilename: c.packageFilename,
                          internalPath: c.internalPath,
                        })),
                        kind: 'appearance',
                      })
                    }
                  >
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Convert legacy looks to appearance presets ({bulkLookItems.length})
                  </ContextMenuItem>
                )}
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
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Tag size={12} className="shrink-0" />
                Labels
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <LabelsApplyMenuItems labels={labels} stateById={labelStateMap} onToggle={handleLabelToggle} />
              </ContextMenuSubContent>
            </ContextMenuSub>
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
