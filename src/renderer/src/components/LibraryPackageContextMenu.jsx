import { useState, useCallback, useMemo } from 'react'
import {
  ArrowUpCircle,
  Boxes,
  Compass,
  Download,
  Eye,
  Power,
  FolderTree,
  Heart,
  LayoutGrid,
  Link2,
  MousePointerClick,
  Plus,
  Shapes,
  Tag,
  Trash2,
} from 'lucide-react'
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
import { LabelsApplyMenuItems } from '@/components/labels/LabelsApplyMenuItems'
import { singleTargetStateMap, bulkStateMap, applyLabelToFilenames } from '@/components/labels/labelHelpers'
import { AlertDialog } from '@/components/ui/alert-dialog'
import {
  DisablePackageDialogContent,
  ForceRemoveDialogContent,
  UninstallDialogContent,
  hasPinningDependents,
  uninstallOutcomeMessage,
} from '@/components/package-action-dialogs'
import { ArchiveDialogContent, InstallFromArchiveDialogContent } from '@/components/ArchiveActionDialogs'
import FileTreeDialog from '@/components/FileTreeDialog'
import LinkHubDialog from '@/components/LinkHubDialog'
import {
  displayName,
  isPromotionalLink,
  libraryTypeBadgeLabel,
  LIBRARY_FILTER_TYPES,
  openExternalLink,
  TYPE_COLORS,
} from '@/lib/utils'
import { toastIfSingleToggleFailed } from '@/lib/packageStorageToggleResults'
import { packageNeedsDisableConfirmation } from '@/lib/package-disable-confirm'
import { isUpdateUnavailable, isUpdateCheckFailed, isUpdateChecking, updateTargetVersion } from '@/lib/hub-availability'
import { isPackageActive, isPackageArchived } from '@shared/storage-state-predicates.js'
import {
  libraryBulkEnabledState,
  resolveLibraryBulkPackages,
  runLibraryBulkInstallFromArchive,
  runLibraryBulkPromote,
  runLibraryBulkRemove,
  runLibraryBulkRemoveFromArchive,
  runLibraryBulkToggleEnabled,
} from '@/lib/bulk-targets'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { useLabelsStore } from '@/stores/useLabelsStore'
import { useLibraryDirsStore } from '@/stores/useLibraryDirsStore'

const SCENE_SOURCE_TYPES = new Set(['scene', 'legacyScene'])
const LOOK_SOURCE_TYPES = new Set(['legacyLook'])
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
    toastExtractResult(`${actionLabel} presets`, r)
  } catch (err) {
    toast(`${actionLabel} failed: ${err.message}`)
  }
}

async function runLibraryBulkExtract({ kind, sources, sourceNoun, actionLabel }) {
  const { bulkSelectedFilenames } = useLibraryStore.getState()
  if (!bulkSelectedFilenames.length) return
  try {
    const r = await window.api.extract.runForPackages({
      filenames: bulkSelectedFilenames,
      kind,
      sourceTypes: [...sources],
    })
    const w = r.written?.length ?? 0
    const s = r.skipped?.length ?? 0
    if (w === 0 && s === 0 && !(r.errors?.length ?? 0)) {
      toast(
        `No ${sourceNoun} to ${actionLabel.toLowerCase()} in selected package${bulkSelectedFilenames.length === 1 ? '' : 's'}`,
        'info',
      )
      return
    }
    toastExtractResult(`${actionLabel} presets`, r)
  } catch (err) {
    toast(`${actionLabel} failed: ${err.message}`)
  }
}

async function runSetTypeOverride(filenames, typeOverride) {
  if (!filenames.length) return
  try {
    await window.api.packages.setTypeOverride({ filenames, typeOverride })
    await useLibraryStore.getState().fetchPackages()
    await useLibraryStore.getState().refreshDetail()
  } catch (err) {
    toast(`Failed to update package type: ${err.message}`)
  }
}

function TypeOverrideMenuItems({ filenames, typeOverride, autoBucketLabel, bulk }) {
  return (
    <>
      <ContextMenuLabel>Set type</ContextMenuLabel>
      {bulk && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void runSetTypeOverride(filenames, null)}>
            Auto (clear override)
          </ContextMenuItem>
        </>
      )}
      {LIBRARY_FILTER_TYPES.map((t) => (
        <ContextMenuItem key={t} className="gap-2" onSelect={() => void runSetTypeOverride(filenames, t)}>
          <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: TYPE_COLORS[t] }} />
          {t}
        </ContextMenuItem>
      ))}
      {!bulk && typeOverride != null && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void runSetTypeOverride(filenames, null)}>
            Auto ({autoBucketLabel})
          </ContextMenuItem>
        </>
      )}
    </>
  )
}

export function LibraryPackageContextMenu({ pkg, updateInfo, onNavigate, forceSingle = false, children }) {
  const selectedDetail = useLibraryStore((s) => s.selectedDetail)
  const bulkSelectedFilenames = useLibraryStore((s) => s.bulkSelectedFilenames)
  const packageByFilename = useLibraryStore((s) => s.packageByFilename)
  const labels = useLabelsStore((s) => s.labels)
  const [detail, setDetail] = useState(null)
  const [probe, setProbe] = useState(null)
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  const [linkHubOpen, setLinkHubOpen] = useState(false)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [forceRemoveOpen, setForceRemoveOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [installArchiveOpen, setInstallArchiveOpen] = useState(false)
  const auxDirs = useLibraryDirsStore((s) => s.aux)
  const archiveDirs = useMemo(() => auxDirs.filter((d) => d.archive), [auxDirs])
  const hasArchiveDirs = archiveDirs.length > 0
  // Snapshot of `detail` taken when a confirm dialog opens. The context menu
  // clears `detail` on close, so gating the dialog on the live `detail` would
  // unmount its content while the dialog is still open — which tears down
  // Radix's modal layer mid-flight and freezes the app. Keep our own copy.
  const [confirmDetail, setConfirmDetail] = useState(null)

  const openConfirm = useCallback(
    (setOpen) => {
      const snapshot = detail || (selectedDetail?.filename === pkg.filename ? selectedDetail : null)
      if (!snapshot) return
      setConfirmDetail(snapshot)
      setOpen(true)
    },
    [detail, selectedDetail, pkg.filename],
  )

  const closeConfirm = useCallback(
    (setOpen) => (open) => {
      setOpen(open)
      if (!open) setConfirmDetail(null)
    },
    [],
  )

  const onOpenChange = useCallback(
    async (open) => {
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
        try {
          setProbe((await window.api.extract.probePackage(pkg.filename)) || { scenes: [] })
        } catch {
          setProbe({ scenes: [] })
        }
      } else {
        setDetail(null)
        setProbe(null)
      }
    },
    [pkg.filename, selectedDetail],
  )

  const p = detail || pkg
  const hasDependents = (p.dependents?.length ?? 0) > 0
  const hasPinning = hasPinningDependents(detail || pkg)
  const suppressDisablePackageWarning = useLibraryStore((s) => s.suppressDisablePackageWarning)
  const showDisableDialog = packageNeedsDisableConfirmation(p, suppressDisablePackageWarning)

  const handleToggleEnabled = async () => {
    try {
      const res = await window.api.packages.toggleEnabled(p.filename)
      toastIfSingleToggleFailed(res)
    } catch (err) {
      toast(`Failed to toggle package: ${err.message}`)
    }
  }
  const handleEnableInactiveDeps = async () => {
    try {
      const res = await window.api.packages.enableDeps(p.filename)
      if (res?.count > 0) toast(`Enabled ${res.count} dependenc${res.count === 1 ? 'y' : 'ies'}`, 'success')
    } catch (err) {
      toast(`Failed to enable dependencies: ${err.message}`)
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
      const res = await window.api.packages.uninstall(p.filename)
      const msg = uninstallOutcomeMessage(res)
      if (msg) toast(msg, 'success')
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
  const handleArchive = async (archiveDirId, depMode) => {
    try {
      const res = await window.api.packages.archive(archiveTargetFilenames, archiveDirId, depMode)
      const parts = []
      if (res?.pruned) parts.push(`${res.pruned} dropped`)
      if (res?.storedToArchive) parts.push(`${res.storedToArchive} stored`)
      toast(`Archived${parts.length ? `: ${parts.join(', ')}` : ''}`, 'success')
      if (showBulk) useLibraryStore.getState().clearBulkSelection()
    } catch (err) {
      toast(`Archive failed: ${err.message}`)
    }
  }
  const handleInstallFromArchive = async () => {
    try {
      const res = await window.api.packages.installFromArchive([p.filename])
      if (res?.queued > 0)
        toast(`Installing: ${res.queued} dependenc${res.queued === 1 ? 'y' : 'ies'} queued`, 'success')
      await useDownloadStore.getState().fetchItems()
    } catch (err) {
      toast(`Install failed: ${err.message}`)
    }
  }
  const isArchived = isPackageArchived(p.storageState)

  // Length > 1 is bulk; a lone pick in the selection array is a single selection.
  const showBulk = !forceSingle && bulkSelectedFilenames.length > 1 && bulkSelectedFilenames.includes(pkg.filename)
  const bulkPackages = useMemo(
    () => (showBulk ? resolveLibraryBulkPackages({ bulkSelectedFilenames, packageByFilename }) : []),
    [showBulk, bulkSelectedFilenames, packageByFilename],
  )
  const bulkDepCount = bulkPackages.filter((x) => !x.isDirect).length

  const labelTargetFilenames = useMemo(
    () => (showBulk ? bulkSelectedFilenames : [pkg.filename]),
    [showBulk, bulkSelectedFilenames, pkg.filename],
  )
  const labelStateMap = useMemo(() => {
    if (!showBulk) return singleTargetStateMap(pkg.labelIds || [])
    return bulkStateMap(bulkPackages.map((x) => x.labelIds || []))
  }, [showBulk, bulkPackages, pkg.labelIds])

  const handleLabelToggle = async (label, currentState) => {
    const apply = currentState !== 'all'
    await applyLabelToFilenames(label.id, labelTargetFilenames, apply)
  }

  const bulkEnableUi = useMemo(() => libraryBulkEnabledState(bulkPackages), [bulkPackages])

  // How many of the bulk selection are archived — drives whether the bulk menu
  // shows archive-shelf actions (Install/Remove) or the normal library actions.
  const bulkArchivedCount = bulkPackages.filter((p) => isPackageArchived(p.storageState)).length
  const bulkNonArchivedFilenames = useMemo(
    () => bulkPackages.filter((p) => !isPackageArchived(p.storageState)).map((p) => p.filename),
    [bulkPackages],
  )
  const bulkAllArchived = bulkArchivedCount > 0 && bulkArchivedCount === bulkPackages.length
  const archiveTargetFilenames = showBulk ? bulkNonArchivedFilenames : [pkg.filename]

  // Three sibling groups: scene-sourced appearance, scene-sourced outfit,
  // and look-sourced appearance. Looks produce a distinct "Convert to ..."
  // entry rather than being folded into the scene-sourced "Extract ..." one.
  const extractGroups = useMemo(() => {
    if (!probe?.scenes?.length) return null
    const groups = {
      sceneAppearance: { kind: 'appearance', actionLabel: 'Extract appearance', missing: [] },
      sceneOutfit: { kind: 'outfit', actionLabel: 'Extract outfit', missing: [] },
      lookAppearance: { kind: 'appearance', actionLabel: 'Convert to appearance', missing: [] },
    }
    for (const scene of probe.scenes) {
      const isLook = LOOK_SOURCE_TYPES.has(scene.type)
      for (const atom of scene.atoms || []) {
        if (!atom.outputs?.appearance?.exists) {
          const bucket = isLook ? groups.lookAppearance : groups.sceneAppearance
          bucket.missing.push({ scene, atomId: atom.atomId })
        }
        if (!isLook && !atom.outputs?.clothing?.exists) {
          groups.sceneOutfit.missing.push({ scene, atomId: atom.atomId })
        }
      }
    }
    return groups
  }, [probe])

  const renderPkgExtractEntries = () => {
    if (!extractGroups) return null
    const entries = []
    for (const [groupKey, group] of Object.entries(extractGroups)) {
      const { kind, actionLabel, missing } = group
      if (!missing.length) continue
      const entryKey = `extract-${groupKey}`
      if (missing.length === 1) {
        const m = missing[0]
        entries.push(
          <ContextMenuItem
            key={entryKey}
            onSelect={() =>
              void runExtractAndToast(actionLabel, {
                packageFilename: m.scene.packageFilename,
                internalPath: m.scene.internalPath,
                atomIds: [m.atomId],
                kind,
              })
            }
          >
            <Download size={12} className="shrink-0 text-accent-blue" />
            {actionLabel} preset
          </ContextMenuItem>,
        )
        continue
      }
      const byScene = new Map()
      for (const m of missing) {
        const key = m.scene.internalPath
        let g = byScene.get(key)
        if (!g) {
          g = { scene: m.scene, atomIds: [] }
          byScene.set(key, g)
        }
        g.atomIds.push(m.atomId)
      }
      // Single source with N atoms → list atom ids (like content-item menu).
      // Multiple sources → list each (each runs across all its missing atoms).
      const singleSource = byScene.size === 1
      const only = singleSource ? [...byScene.values()][0] : null
      const verb = groupKey === 'lookAppearance' ? 'Convert' : 'Extract'
      entries.push(
        <ContextMenuSub key={entryKey}>
          <ContextMenuSubTrigger>
            <Download size={12} className="shrink-0 text-accent-blue" />
            {actionLabel} preset{singleSource ? '' : 's'}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() =>
                void runExtractAndToast(
                  actionLabel,
                  singleSource
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
              {verb} all ({missing.length})
            </ContextMenuItem>
            <ContextMenuSeparator />
            {singleSource
              ? only.atomIds.map((atomId) => (
                  <ContextMenuItem
                    key={atomId}
                    onSelect={() =>
                      void runExtractAndToast(actionLabel, {
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
                      void runExtractAndToast(actionLabel, {
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
        <ContextMenuContent className="min-w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
          {showBulk ? (
            <>
              <ContextMenuLabel>
                {bulkSelectedFilenames.length} package{bulkSelectedFilenames.length === 1 ? '' : 's'} selected
              </ContextMenuLabel>
              <ContextMenuSeparator />
              {bulkAllArchived ? (
                <>
                  <ContextMenuItem onSelect={() => void runLibraryBulkInstallFromArchive(bulkPackages)}>
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Install from archive
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Tag size={12} className="shrink-0" />
                      Labels
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <LabelsApplyMenuItems labels={labels} stateById={labelStateMap} onToggle={handleLabelToggle} />
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Shapes size={12} className="shrink-0" />
                      Type
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="min-w-40">
                      <TypeOverrideMenuItems filenames={bulkSelectedFilenames} bulk />
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => void runLibraryBulkRemoveFromArchive(bulkPackages)}
                  >
                    <Trash2 size={12} className="shrink-0" />
                    Remove from archive
                  </ContextMenuItem>
                </>
              ) : (
                <>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Tag size={12} className="shrink-0" />
                      Labels
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <LabelsApplyMenuItems labels={labels} stateById={labelStateMap} onToggle={handleLabelToggle} />
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Shapes size={12} className="shrink-0" />
                      Type
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="min-w-40">
                      <TypeOverrideMenuItems filenames={bulkSelectedFilenames} bulk />
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuItem
                    onSelect={() =>
                      void runLibraryBulkExtract({
                        kind: 'appearance',
                        sources: SCENE_SOURCE_TYPES,
                        sourceNoun: 'scenes',
                        actionLabel: 'Extract appearance',
                      })
                    }
                  >
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Extract appearance presets from scenes
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      void runLibraryBulkExtract({
                        kind: 'outfit',
                        sources: SCENE_SOURCE_TYPES,
                        sourceNoun: 'scenes',
                        actionLabel: 'Extract outfit',
                      })
                    }
                  >
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Extract outfit presets from scenes
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      void runLibraryBulkExtract({
                        kind: 'appearance',
                        sources: LOOK_SOURCE_TYPES,
                        sourceNoun: 'legacy looks',
                        actionLabel: 'Convert to appearance',
                      })
                    }
                  >
                    <Download size={12} className="shrink-0 text-accent-blue" />
                    Convert legacy looks to appearance presets
                  </ContextMenuItem>
                  {bulkDepCount > 0 && (
                    <ContextMenuItem onSelect={() => void runLibraryBulkPromote(bulkPackages)}>
                      <Plus size={12} className="shrink-0 text-accent-blue" />
                      Promote
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void runLibraryBulkToggleEnabled(bulkPackages)}>
                    <Power
                      size={12}
                      className={
                        bulkEnableUi.mixed
                          ? 'shrink-0 text-text-aside'
                          : bulkEnableUi.allDisabled
                            ? 'shrink-0 text-error'
                            : 'shrink-0 text-text-secondary'
                      }
                    />
                    {bulkEnableUi.label}
                  </ContextMenuItem>
                  {hasArchiveDirs && bulkNonArchivedFilenames.length > 0 && (
                    <ContextMenuItem onSelect={() => setArchiveOpen(true)}>
                      <Boxes size={12} className="shrink-0" />
                      Archive…
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem variant="destructive" onSelect={() => void runLibraryBulkRemove(bulkPackages)}>
                    <Trash2 size={12} className="shrink-0" />
                    Remove
                  </ContextMenuItem>
                </>
              )}
            </>
          ) : (
            <>
              {forceSingle && (
                <>
                  <ContextMenuItem onSelect={() => void useLibraryStore.getState().selectPackage(pkg.filename)}>
                    <MousePointerClick size={12} className="shrink-0" />
                    Select only this
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              {isArchived ? (
                <ContextMenuItem onSelect={() => openConfirm(setInstallArchiveOpen)} disabled={!detail}>
                  <Download size={12} className="shrink-0 text-accent-blue" />
                  Install from archive…
                </ContextMenuItem>
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
                            toast(`Updated to v${updateInfo.hubVersion}`, 'success', 2500)
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
                  ) : isUpdateCheckFailed(updateInfo) ? (
                    <ContextMenuItem disabled title="The hub could not be reached. Re-check to try again">
                      <ArrowUpCircle size={12} className="shrink-0" />v{updateInfo.hubVersion} unchecked
                    </ContextMenuItem>
                  ) : isUpdateUnavailable(updateInfo) ? (
                    <ContextMenuItem
                      disabled
                      title="Listed on the hub but not downloadable (paid, externally hosted, or no longer served)"
                    >
                      <ArrowUpCircle size={12} className="shrink-0" />v{updateInfo.hubVersion} unavailable
                    </ContextMenuItem>
                  ) : isUpdateChecking(updateInfo) ? (
                    <ContextMenuItem disabled title="Verifying availability with the hub…">
                      <ArrowUpCircle size={12} className="shrink-0" />
                      Checking v{updateInfo.hubVersion}…
                    </ContextMenuItem>
                  ) : (
                    (updateInfo?.hubResourceId || updateInfo?.packageName) && (
                      <ContextMenuItem
                        onSelect={() => {
                          useDownloadStore.getState().installUpdate(p, updateInfo)
                        }}
                      >
                        <ArrowUpCircle size={12} className="shrink-0 text-accent-blue" />
                        Update to v{updateTargetVersion(updateInfo)}
                      </ContextMenuItem>
                    )
                  )}
                  {!p.hubResourceId && (
                    <ContextMenuItem onSelect={() => setLinkHubOpen(true)}>
                      <Link2 size={12} className="shrink-0" />
                      Link to Hub…
                    </ContextMenuItem>
                  )}
                  {isPromotionalLink(p.promotionalLink) && (
                    <ContextMenuItem
                      onSelect={() => {
                        void openExternalLink(p.promotionalLink)
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
                  {isPackageActive(p.storageState ?? 'enabled') && p.inactiveDeps > 0 && (
                    <ContextMenuItem onSelect={() => void handleEnableInactiveDeps()}>
                      <Power size={12} className="shrink-0" />
                      Enable disabled dependencies
                    </ContextMenuItem>
                  )}
                  {p.isCorrupted && !p.isLocalOnly && (
                    <ContextMenuItem onSelect={() => void handleRedownload()}>
                      <Download size={12} className="shrink-0 text-error" />
                      Redownload
                    </ContextMenuItem>
                  )}
                </>
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
              {(p.contentCount ?? 0) > 0 && (
                <ContextMenuItem
                  onSelect={() => onNavigate?.('content', { filterByPackage: p.packageName || p.filename })}
                >
                  <LayoutGrid size={12} className="shrink-0" />
                  Browse content
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => setFileTreeOpen(true)}>
                <FolderTree size={12} className="shrink-0" />
                Browse package files
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Tag size={12} className="shrink-0" />
                  Labels
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <LabelsApplyMenuItems labels={labels} stateById={labelStateMap} onToggle={handleLabelToggle} />
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Shapes size={12} className="shrink-0" />
                  Type
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="min-w-40">
                  <TypeOverrideMenuItems
                    filenames={[pkg.filename]}
                    typeOverride={p.typeOverride}
                    autoBucketLabel={libraryTypeBadgeLabel(p.derivedType || p.hubType)}
                  />
                </ContextMenuSubContent>
              </ContextMenuSub>
              {isArchived ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => void handleForceRemove()}>
                    <Trash2 size={12} className="shrink-0" />
                    Remove from archive
                  </ContextMenuItem>
                </>
              ) : (
                <>
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
                    <ContextMenuItem onSelect={() => openConfirm(setDisableOpen)} disabled={!detail}>
                      <Power size={12} className="shrink-0" />
                      Disable…
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem onSelect={() => void handleToggleEnabled()}>
                      <Power
                        size={12}
                        className={isPackageActive(p.storageState ?? 'enabled') ? 'shrink-0' : 'shrink-0 text-error'}
                      />
                      {isPackageActive(p.storageState ?? 'enabled') ? 'Disable' : 'Enable'}
                    </ContextMenuItem>
                  )}
                  {hasArchiveDirs && (
                    <ContextMenuItem onSelect={() => openConfirm(setArchiveOpen)} disabled={!detail}>
                      <Boxes size={12} className="shrink-0" />
                      Archive…
                    </ContextMenuItem>
                  )}
                  {p.isDirect ? (
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => openConfirm(setUninstallOpen)}
                      disabled={!detail}
                    >
                      <Trash2 size={12} className="shrink-0" />
                      {hasPinning ? 'Remove…' : 'Uninstall…'}
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => openConfirm(setForceRemoveOpen)}
                      disabled={!detail}
                    >
                      <Trash2 size={12} className="shrink-0" />
                      {hasDependents ? 'Force remove…' : 'Remove…'}
                    </ContextMenuItem>
                  )}
                </>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <FileTreeDialog open={fileTreeOpen} onOpenChange={setFileTreeOpen} filename={pkg.filename} />

      {linkHubOpen && <LinkHubDialog pkg={pkg} open={linkHubOpen} onOpenChange={setLinkHubOpen} />}

      <AlertDialog open={uninstallOpen} onOpenChange={closeConfirm(setUninstallOpen)}>
        {uninstallOpen && confirmDetail ? (
          <UninstallDialogContent pkg={confirmDetail} name={displayName(confirmDetail)} onConfirm={handleUninstall} />
        ) : null}
      </AlertDialog>

      <AlertDialog open={disableOpen} onOpenChange={closeConfirm(setDisableOpen)}>
        {disableOpen && confirmDetail ? (
          <DisablePackageDialogContent
            pkg={confirmDetail}
            name={displayName(confirmDetail)}
            onConfirm={handleToggleEnabled}
          />
        ) : null}
      </AlertDialog>

      <AlertDialog open={forceRemoveOpen} onOpenChange={closeConfirm(setForceRemoveOpen)}>
        {forceRemoveOpen && confirmDetail ? (
          <ForceRemoveDialogContent
            pkg={confirmDetail}
            name={displayName(confirmDetail)}
            hasDependents={(confirmDetail.dependents?.length ?? 0) > 0}
            onConfirm={handleForceRemove}
          />
        ) : null}
      </AlertDialog>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        {archiveOpen && archiveTargetFilenames.length > 0 ? (
          <ArchiveDialogContent
            filenames={archiveTargetFilenames}
            archiveDirs={archiveDirs}
            onConfirm={handleArchive}
          />
        ) : null}
      </AlertDialog>

      <AlertDialog open={installArchiveOpen} onOpenChange={closeConfirm(setInstallArchiveOpen)}>
        {installArchiveOpen && confirmDetail ? (
          <InstallFromArchiveDialogContent pkgs={confirmDetail} onConfirm={handleInstallFromArchive} />
        ) : null}
      </AlertDialog>
    </>
  )
}
