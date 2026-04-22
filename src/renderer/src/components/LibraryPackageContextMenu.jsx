import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  ArrowUpCircle,
  Compass,
  Download,
  Eye,
  EyeOff,
  FolderTree,
  Heart,
  LayoutGrid,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from '@/components/Toast'
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
import { useIsDev } from '@/hooks/useIsDev'
import { AlertDialog } from '@/components/ui/alert-dialog'
import {
  DisablePackageDialogContent,
  ForceRemoveDialogContent,
  UninstallDialogContent,
} from '@/components/package-action-dialogs'
import FileTreeDialog from '@/components/FileTreeDialog'
import { displayName } from '@/lib/utils'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useLibraryStore } from '@/stores/useLibraryStore'

async function runLibraryBulkToggleEnabledFromStore() {
  const { packages, bulkSelectedFilenames } = useLibraryStore.getState()
  const items = packages.filter((p) => bulkSelectedFilenames.includes(p.filename))
  if (!items.length) return
  const nEnabled = items.filter((p) => p.isEnabled).length
  const allEnabled = nEnabled === items.length
  const allDisabled = nEnabled === 0
  const mixed = !allEnabled && !allDisabled
  const targets = mixed ? items.filter((p) => !p.isEnabled) : items
  try {
    for (const p of targets) {
      await window.api.packages.toggleEnabled(p.filename)
    }
    await useLibraryStore.getState().fetchPackages()
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}

async function runLibraryBulkRemoveFromStore() {
  const { packages, bulkSelectedFilenames } = useLibraryStore.getState()
  const items = packages.filter((p) => bulkSelectedFilenames.includes(p.filename))
  const direct = items.filter((p) => p.isDirect)
  const dep = items.filter((p) => !p.isDirect)
  try {
    if (direct.length) {
      const d = direct.map((p) => p.filename)
      await window.api.packages.uninstall(d.length === 1 ? d[0] : d)
    }
    if (dep.length) {
      const d = dep.map((p) => p.filename)
      await window.api.packages.forceRemove(d.length === 1 ? d[0] : d)
    }
    useLibraryStore.getState().clearBulkSelection()
    await useLibraryStore.getState().fetchPackages()
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}

const SCENE_TYPES = new Set(['scene', 'legacyScene'])

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
    toastExtractResult(`Extract ${kindLabel} presets`, r)
  } catch (err) {
    toast(`Extract failed: ${err.message}`)
  }
}

async function runLibraryBulkExtract(kind) {
  const label = kind === 'appearance' ? 'appearance' : 'outfit'
  const { packages, bulkSelectedFilenames } = useLibraryStore.getState()
  const selected = packages.filter((p) => bulkSelectedFilenames.includes(p.filename))
  if (!selected.length) return
  try {
    const details = await Promise.all(selected.map((p) => window.api.packages.detail(p.filename).catch(() => null)))
    const items = []
    for (const d of details) {
      if (!d?.contents) continue
      for (const c of d.contents) {
        if (SCENE_TYPES.has(c.type)) {
          items.push({ packageFilename: c.packageFilename, internalPath: c.internalPath })
        }
      }
    }
    if (!items.length) {
      toast(`No scenes in selected package${selected.length === 1 ? '' : 's'}`, 'info')
      return
    }
    await runExtractAndToast(label, { items, kind })
  } catch (err) {
    toast(`Extract failed: ${err.message}`)
  }
}

async function runLibraryBulkPromoteFromStore() {
  const { packages, bulkSelectedFilenames } = useLibraryStore.getState()
  const fnames = packages
    .filter((p) => bulkSelectedFilenames.includes(p.filename) && !p.isDirect)
    .map((p) => p.filename)
  if (!fnames.length) return
  try {
    await window.api.packages.promote(fnames.length === 1 ? fnames[0] : fnames, null)
    useLibraryStore.getState().clearBulkSelection()
    await useLibraryStore.getState().fetchPackages()
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}

export function LibraryPackageContextMenu({ pkg, updateInfo, onNavigate, children }) {
  const selectedDetail = useLibraryStore((s) => s.selectedDetail)
  const bulkSelectedFilenames = useLibraryStore((s) => s.bulkSelectedFilenames)
  const packages = useLibraryStore((s) => s.packages)
  const [detail, setDetail] = useState(null)
  const [probe, setProbe] = useState(null)
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [forceRemoveOpen, setForceRemoveOpen] = useState(false)
  const isDev = useIsDev()

  const hasScenes = (detail?.contents || []).some((c) => SCENE_TYPES.has(c.type))

  const onOpenChange = useCallback(
    (open) => {
      if (open) {
        if (selectedDetail?.filename === pkg.filename) {
          setDetail(selectedDetail)
        } else {
          setDetail(null)
          void window.api.packages
            .detail(pkg.filename)
            .then(setDetail)
            .catch((err) => toast(`Failed to load package: ${err.message}`))
        }
      } else {
        setDetail(null)
        setProbe(null)
      }
    },
    [pkg.filename, selectedDetail],
  )

  useEffect(() => {
    if (!isDev || !hasScenes || probe !== null) return
    let alive = true
    window.api.extract
      .probePackage(pkg.filename)
      .then((r) => {
        if (alive) setProbe(r || { scenes: [] })
      })
      .catch(() => {
        if (alive) setProbe({ scenes: [] })
      })
    return () => {
      alive = false
    }
  }, [isDev, hasScenes, pkg.filename, probe])

  const p = detail || pkg
  const name = displayName(p)
  const hasDependents = (p.dependents?.length ?? 0) > 0
  const hasCascadeDeps = (p.cascadeDisableDeps?.length ?? 0) > 0
  const showDisableDialog = p.isEnabled && (hasDependents || hasCascadeDeps)
  const dependentNames = hasDependents
    ? p.dependents
        .slice(0, 2)
        .map((d) => d.packageName?.split('.').pop() || d.filename)
        .join(', ') + (p.dependents.length > 2 ? ` +${p.dependents.length - 2}` : '')
    : ''

  const handleToggleEnabled = async () => {
    try {
      await window.api.packages.toggleEnabled(p.filename)
    } catch (err) {
      toast(`Failed to toggle package: ${err.message}`)
    }
  }
  const handlePromote = async () => {
    try {
      await window.api.packages.promote(p.filename)
    } catch (err) {
      toast(`Failed to promote package: ${err.message}`)
    }
  }
  const handleUninstall = async () => {
    try {
      await window.api.packages.uninstall(p.filename)
    } catch (err) {
      toast(`Uninstall failed: ${err.message}`)
    }
  }
  const handleForceRemove = async () => {
    try {
      await window.api.packages.forceRemove(p.filename)
    } catch (err) {
      toast(`Remove failed: ${err.message}`)
    }
  }
  const handleRedownload = async () => {
    try {
      await window.api.packages.redownload(p.filename)
      toast('Package redownloaded and verified', 'success')
    } catch (err) {
      toast(`Redownload failed: ${err.message}`)
    }
  }

  const showBulk = bulkSelectedFilenames.length > 0 && bulkSelectedFilenames.includes(pkg.filename)
  const bulkDepCount = showBulk
    ? packages.filter((x) => bulkSelectedFilenames.includes(x.filename) && !x.isDirect).length
    : 0

  const bulkEnableUi = useMemo(() => {
    if (!showBulk) return null
    const items = packages.filter((p) => bulkSelectedFilenames.includes(p.filename))
    if (!items.length) {
      return { label: 'Enable', allEnabled: false, allDisabled: true, mixed: false }
    }
    const n = items.filter((p) => p.isEnabled).length
    const allEnabled = n === items.length
    const allDisabled = n === 0
    const mixed = n > 0 && n < items.length
    const label = mixed || allDisabled ? 'Enable' : 'Disable'
    return { label, allEnabled, allDisabled, mixed }
  }, [showBulk, packages, bulkSelectedFilenames])

  const extractMissing = useMemo(() => {
    if (!probe?.scenes?.length) return null
    const missing = { appearance: [], outfit: [] }
    for (const scene of probe.scenes) {
      for (const atom of scene.atoms || []) {
        if (!atom.outputs?.appearance?.exists) {
          missing.appearance.push({ scene, atomId: atom.atomId })
        }
        if (!atom.outputs?.clothing?.exists) {
          missing.outfit.push({ scene, atomId: atom.atomId })
        }
      }
    }
    return missing
  }, [probe])

  const renderPkgExtractEntries = () => {
    if (!isDev || !hasScenes || !extractMissing) return null
    const entries = []
    for (const kind of ['appearance', 'outfit']) {
      const missing = extractMissing[kind]
      if (!missing.length) continue
      if (missing.length === 1) {
        const m = missing[0]
        entries.push(
          <ContextMenuItem
            key={`extract-${kind}`}
            onSelect={() =>
              void runExtractAndToast(kind, {
                packageFilename: m.scene.packageFilename,
                internalPath: m.scene.internalPath,
                atomIds: [m.atomId],
                kind,
              })
            }
          >
            <Download size={12} className="shrink-0 text-accent-blue" />
            Extract {kind} preset
          </ContextMenuItem>,
        )
        continue
      }
      const byScene = new Map()
      for (const m of missing) {
        const key = m.scene.internalPath
        let group = byScene.get(key)
        if (!group) {
          group = { scene: m.scene, atomIds: [] }
          byScene.set(key, group)
        }
        group.atomIds.push(m.atomId)
      }
      // Single scene with N atoms → list atom ids (like content-item menu).
      // Multiple scenes → list scenes (each runs across all its missing atoms).
      const singleScene = byScene.size === 1
      const only = singleScene ? [...byScene.values()][0] : null
      entries.push(
        <ContextMenuSub key={`extract-${kind}`}>
          <ContextMenuSubTrigger>
            <Download size={12} className="shrink-0 text-accent-blue" />
            Extract {kind} preset{singleScene ? '' : 's from scenes'}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() =>
                void runExtractAndToast(
                  kind,
                  singleScene
                    ? {
                        packageFilename: only.scene.packageFilename,
                        internalPath: only.scene.internalPath,
                        atomIds: only.atomIds,
                        kind,
                      }
                    : {
                        items: [...byScene.values()].map((g) => ({
                          packageFilename: g.scene.packageFilename,
                          internalPath: g.scene.internalPath,
                          atomIds: g.atomIds,
                        })),
                        kind,
                      },
                )
              }
            >
              Extract all ({missing.length})
            </ContextMenuItem>
            <ContextMenuSeparator />
            {singleScene
              ? only.atomIds.map((atomId) => (
                  <ContextMenuItem
                    key={atomId}
                    onSelect={() =>
                      void runExtractAndToast(kind, {
                        packageFilename: only.scene.packageFilename,
                        internalPath: only.scene.internalPath,
                        atomIds: [atomId],
                        kind,
                      })
                    }
                  >
                    {atomId}
                  </ContextMenuItem>
                ))
              : [...byScene.values()].map((g) => (
                  <ContextMenuItem
                    key={g.scene.internalPath}
                    onSelect={() =>
                      void runExtractAndToast(kind, {
                        packageFilename: g.scene.packageFilename,
                        internalPath: g.scene.internalPath,
                        atomIds: g.atomIds,
                        kind,
                      })
                    }
                  >
                    {g.scene.label}
                    {g.atomIds.length > 1 ? ` (${g.atomIds.length})` : ''}
                  </ContextMenuItem>
                ))}
          </ContextMenuSubContent>
        </ContextMenuSub>,
      )
    }
    return entries
  }

  return (
    <>
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">
          {showBulk ? (
            <>
              <ContextMenuItem onSelect={() => void runLibraryBulkToggleEnabledFromStore()}>
                {bulkEnableUi.allEnabled && !bulkEnableUi.mixed ? (
                  <EyeOff size={12} className="shrink-0 text-text-secondary" />
                ) : bulkEnableUi.mixed ? (
                  <Eye size={12} className="shrink-0 text-text-tertiary" />
                ) : (
                  <Eye size={12} className="shrink-0 text-text-secondary" />
                )}
                {bulkEnableUi.label} ({bulkSelectedFilenames.length})
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onSelect={() => void runLibraryBulkRemoveFromStore()}>
                <Trash2 size={12} className="shrink-0" />
                Remove ({bulkSelectedFilenames.length})
              </ContextMenuItem>
              {bulkDepCount > 0 && (
                <ContextMenuItem onSelect={() => void runLibraryBulkPromoteFromStore()}>
                  <Plus size={12} className="shrink-0 text-accent-blue" />
                  Promote ({bulkDepCount})
                </ContextMenuItem>
              )}
              {isDev && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void runLibraryBulkExtract('appearance')}>
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Extract appearance presets from scenes ({bulkSelectedFilenames.length})
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => void runLibraryBulkExtract('outfit')}>
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Extract outfit presets from scenes ({bulkSelectedFilenames.length})
                  </ContextMenuItem>
                </>
              )}
            </>
          ) : (
            <>
              {updateInfo?.localNewerFilename ? (
                <>
                  <ContextMenuItem
                    onSelect={async () => {
                      try {
                        await window.api.packages.uninstall(p.filename)
                        await window.api.packages.promote(updateInfo.localNewerFilename)
                        await useLibraryStore.getState().fetchPackages()
                        await useLibraryStore.getState().selectPackage(updateInfo.localNewerFilename)
                      } catch (err) {
                        toast(`Update failed: ${err.message}`)
                      }
                    }}
                  >
                    <ArrowUpCircle size={12} className="shrink-0 text-accent-blue" />
                    Update to v{updateInfo.hubVersion}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => useLibraryStore.getState().selectPackage(updateInfo.localNewerFilename)}
                  >
                    <Eye size={12} className="shrink-0 text-accent-blue" />
                    Go to v{updateInfo.hubVersion}
                  </ContextMenuItem>
                </>
              ) : (
                (updateInfo?.hubResourceId || updateInfo?.packageName) && (
                  <ContextMenuItem
                    onSelect={() => {
                      useDownloadStore
                        .getState()
                        .install(
                          updateInfo.hubResourceId,
                          null,
                          false,
                          updateInfo.packageName,
                          !!updateInfo.isDepUpdate,
                        )
                    }}
                  >
                    <ArrowUpCircle size={12} className="shrink-0 text-accent-blue" />
                    Update to v{updateInfo.hubVersion}
                  </ContextMenuItem>
                )
              )}
              {p.hubResourceId && (
                <ContextMenuItem
                  onSelect={() =>
                    onNavigate?.('hub', {
                      openResource: {
                        resource_id: p.hubResourceId,
                        title: displayName(p),
                        username: p.creator,
                        type: p.derivedType || p.type,
                      },
                    })
                  }
                >
                  <Compass size={12} className="shrink-0 text-accent-blue" />
                  View on Hub
                </ContextMenuItem>
              )}
              {p.promotionalLink && (
                <ContextMenuItem
                  onSelect={() => {
                    void window.api.shell.openExternal(p.promotionalLink)
                  }}
                >
                  <Heart size={12} className="shrink-0 text-accent-blue" />
                  Support
                </ContextMenuItem>
              )}
              {p.missingDeps > 0 && (
                <ContextMenuItem
                  onSelect={() => {
                    useDownloadStore.getState().installMissing(p.filename)
                  }}
                >
                  <Download size={12} className="shrink-0" />
                  Install missing dependencies
                </ContextMenuItem>
              )}
              {p.isCorrupted && (
                <ContextMenuItem onSelect={() => void handleRedownload()}>
                  <Download size={12} className="shrink-0 text-error" />
                  Redownload
                </ContextMenuItem>
              )}
              {(p.contentCount ?? 0) > 0 && (
                <ContextMenuItem
                  onSelect={() => {
                    onNavigate?.('content', { filterByPackage: p.packageName || p.filename })
                  }}
                >
                  <LayoutGrid size={12} className="shrink-0" />
                  View in gallery
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => setFileTreeOpen(true)}>
                <FolderTree size={12} className="shrink-0" />
                Browse package files
              </ContextMenuItem>
              {renderPkgExtractEntries()}
              {!p.isDirect && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void handlePromote()}>
                    <Plus size={12} className="shrink-0 text-accent-blue" />
                    Add to Library
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              {showDisableDialog ? (
                <ContextMenuItem onSelect={() => setDisableOpen(true)} disabled={!detail}>
                  <EyeOff size={12} className="shrink-0" />
                  Disable…
                </ContextMenuItem>
              ) : (
                <ContextMenuItem onSelect={() => void handleToggleEnabled()}>
                  {p.isEnabled ? <EyeOff size={12} className="shrink-0" /> : <Eye size={12} className="shrink-0" />}
                  {p.isEnabled ? 'Disable' : 'Enable'}
                </ContextMenuItem>
              )}
              {p.isDirect ? (
                <ContextMenuItem variant="destructive" onSelect={() => setUninstallOpen(true)} disabled={!detail}>
                  <Trash2 size={12} className="shrink-0" />
                  {hasDependents ? 'Remove…' : 'Uninstall…'}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem variant="destructive" onSelect={() => setForceRemoveOpen(true)} disabled={!detail}>
                  <Trash2 size={12} className="shrink-0" />
                  {hasDependents ? 'Force remove…' : 'Remove…'}
                </ContextMenuItem>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <FileTreeDialog open={fileTreeOpen} onOpenChange={setFileTreeOpen} filename={pkg.filename} />

      <AlertDialog open={uninstallOpen} onOpenChange={setUninstallOpen}>
        {uninstallOpen && detail ? (
          <UninstallDialogContent
            pkg={detail}
            name={name}
            hasDependents={hasDependents}
            dependentNames={dependentNames}
            onConfirm={handleUninstall}
          />
        ) : null}
      </AlertDialog>

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        {disableOpen && detail ? (
          <DisablePackageDialogContent pkg={detail} name={name} onConfirm={handleToggleEnabled} />
        ) : null}
      </AlertDialog>

      <AlertDialog open={forceRemoveOpen} onOpenChange={setForceRemoveOpen}>
        {forceRemoveOpen && detail ? (
          <ForceRemoveDialogContent
            pkg={detail}
            name={name}
            hasDependents={hasDependents}
            onConfirm={handleForceRemove}
          />
        ) : null}
      </AlertDialog>
    </>
  )
}
