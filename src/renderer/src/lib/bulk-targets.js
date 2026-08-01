import { toast } from '@/components/Toast'
import { toastIfBulkToggleFailures } from '@/lib/packageStorageToggleResults'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { useContentStore } from '@/stores/useContentStore'
import { isPackageActive, isPackageArchived } from '@shared/storage-state-predicates.js'

/** Resolve the current library selection to package objects (selection order). */
export function resolveLibraryBulkPackages(state = useLibraryStore.getState()) {
  const { selection, packageByFilename } = state
  return selection.map((fn) => packageByFilename.get(fn)).filter(Boolean)
}

/** Resolve the current content selection to content items (selection order). */
export function resolveContentBulkItems(state = useContentStore.getState()) {
  const { selection, contents } = state
  if (!selection.length) return []
  const byId = new Map(contents.map((c) => [c.id, c]))
  return selection.map((id) => byId.get(id)).filter(Boolean)
}

/** Enable/disable UI state for a set of library packages. Empty selection => every flag false, `disabled`. */
export function libraryBulkEnabledState(items) {
  const n = items.filter((p) => isPackageActive(p.storageState)).length
  const allEnabled = items.length > 0 && n === items.length
  return {
    disabled: !items.length,
    allEnabled,
    allDisabled: items.length > 0 && n === 0,
    mixed: n > 0 && n < items.length,
    label: allEnabled ? 'Disable' : 'Enable',
  }
}

export async function runLibraryBulkToggleEnabled(items = resolveLibraryBulkPackages()) {
  if (useLibraryStore.getState().bulkToggleIntent) return
  const st = libraryBulkEnabledState(items)
  if (st.disabled) return
  const targets = st.mixed ? items.filter((p) => !isPackageActive(p.storageState)) : items
  if (!targets.length) return
  const enabled = st.allDisabled || st.mixed
  useLibraryStore.setState({ bulkToggleIntent: enabled ? 'enable' : 'disable' })
  try {
    const res = await window.api.packages.setEnabled(
      targets.map((p) => p.filename),
      enabled,
    )
    toastIfBulkToggleFailures(res)
    await useLibraryStore.getState().fetchPackages()
  } catch (err) {
    toast(`Failed: ${err.message}`)
  } finally {
    useLibraryStore.setState({ bulkToggleIntent: null })
  }
}

export async function runLibraryBulkRemove(items = resolveLibraryBulkPackages()) {
  const direct = items.filter((p) => p.isDirect)
  const dep = items.filter((p) => !p.isDirect)
  try {
    let relocated = 0
    if (direct.length) {
      const d = direct.map((p) => p.filename)
      const res = await window.api.packages.uninstall(d.length === 1 ? d[0] : d)
      for (const r of res?.results ?? (res ? [res] : [])) {
        if (r.relocatedToArchive) relocated++
      }
    }
    if (dep.length) {
      const d = dep.map((p) => p.filename)
      await window.api.packages.forceRemove(d.length === 1 ? d[0] : d)
    }
    useLibraryStore.getState().clearSelection()
    await useLibraryStore.getState().fetchPackages()
    if (relocated) toast(`${relocated} moved to archive (still needed by archived packages)`, 'success')
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}

export async function runLibraryBulkPromote(items = resolveLibraryBulkPackages()) {
  const fnames = items.filter((p) => !p.isDirect).map((p) => p.filename)
  if (!fnames.length) return
  try {
    await window.api.packages.promote(fnames.length === 1 ? fnames[0] : fnames, null)
    useLibraryStore.getState().clearSelection()
    await useLibraryStore.getState().fetchPackages()
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}

export async function runLibraryBulkInstallFromArchive(items = resolveLibraryBulkPackages()) {
  const fnames = items.filter((p) => isPackageArchived(p.storageState)).map((p) => p.filename)
  if (!fnames.length) return
  try {
    const res = await window.api.packages.installFromArchive(fnames)
    if (res?.queued > 0) toast(`Installing: ${res.queued} dependenc${res.queued === 1 ? 'y' : 'ies'} queued`, 'success')
    useLibraryStore.getState().clearSelection()
    await Promise.all([useLibraryStore.getState().fetchPackages(), useDownloadStore.getState().fetchItems()])
  } catch (err) {
    toast(`Install failed: ${err.message}`)
  }
}

export async function runLibraryBulkRemoveFromArchive(items = resolveLibraryBulkPackages()) {
  const fnames = items.filter((p) => isPackageArchived(p.storageState)).map((p) => p.filename)
  if (!fnames.length) return
  try {
    await window.api.packages.forceRemove(fnames.length === 1 ? fnames[0] : fnames)
    useLibraryStore.getState().clearSelection()
    await useLibraryStore.getState().fetchPackages()
  } catch (err) {
    toast(`Remove failed: ${err.message}`)
  }
}

/** Hide/show UI state for a set of content items. Empty selection => every flag false, `disabled`. */
export function contentBulkVisibilityState(items) {
  const hiddenCount = items.filter((c) => c.hidden).length
  const allHidden = items.length > 0 && hiddenCount === items.length
  return {
    disabled: !items.length,
    allHidden,
    allVisible: items.length > 0 && hiddenCount === 0,
    mixed: hiddenCount > 0 && hiddenCount < items.length,
    label: allHidden ? 'Show' : 'Hide',
  }
}

/** Favorite UI state for a set of content items. Empty selection => every flag false, `disabled`. */
export function contentBulkFavoriteState(items) {
  const favCount = items.filter((c) => c.favorite).length
  const allFav = items.length > 0 && favCount === items.length
  return {
    disabled: !items.length,
    allFav,
    allUnfav: items.length > 0 && favCount === 0,
    mixed: favCount > 0 && favCount < items.length,
    label: allFav ? 'Unfavorite' : 'Favorite',
  }
}

function contentBatchPayload(items) {
  return items.map((c) => ({
    id: c.id,
    packageFilename: c.packageFilename,
    internalPath: c.internalPath,
  }))
}

/** Toggle hide/show for the current content bulk selection (mixed → hide). */
export async function runContentBulkToggleVisibility(items = resolveContentBulkItems()) {
  const st = contentBulkVisibilityState(items)
  if (st.disabled) return
  const hidden = st.mixed || st.allVisible
  try {
    await window.api.contents.setHiddenBatch({ items: contentBatchPayload(items), hidden })
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}

/** Toggle favorite for the current content bulk selection (mixed → favorite). */
export async function runContentBulkToggleFavorite(items = resolveContentBulkItems()) {
  const st = contentBulkFavoriteState(items)
  if (st.disabled) return
  const favorite = st.mixed || st.allUnfav
  try {
    await window.api.contents.setFavoriteBatch({ items: contentBatchPayload(items), favorite })
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
}
