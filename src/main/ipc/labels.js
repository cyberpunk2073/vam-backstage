import { ipcMain } from 'electron'
import {
  findOrCreateLabel,
  renameLabel,
  recolorLabel,
  deleteLabel as dbDeleteLabel,
  applyLabelToPackages as dbApplyLabelToPackages,
  removeLabelFromPackages as dbRemoveLabelFromPackages,
  applyLabelToContents as dbApplyLabelToContents,
  removeLabelFromContents as dbRemoveLabelFromContents,
} from '../db.js'
import { refreshLabels, refreshLabelMeta, getLabelList } from '../store.js'
import { notify } from '../notify.js'

/**
 * Notify channel choice per mutation:
 *   - rename/recolor/create  → only `labels:updated` (label metadata only; package/content
 *     `labelIds` are unchanged — cards re-resolve names/colors from the cached labels list).
 *   - apply-packages         → +packages:updated, +contents:updated (downward inheritance).
 *   - apply-contents         → +contents:updated only (package's own labelIds didn't change;
 *     LibraryView's `onContentsUpdated` already refetches packages, so there's no need to
 *     also fire packages:updated and pay the tagCounts/authorCounts/update-check cost).
 *   - delete                 → all three (cascade FK wipes label_packages + label_contents).
 */
export function registerLabelHandlers() {
  ipcMain.handle('labels:list', () => {
    return getLabelList()
  })

  ipcMain.handle('labels:create', (_, { name }) => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) throw new Error('Label name cannot be empty')
    const result = findOrCreateLabel(trimmed)
    if (result.created) {
      refreshLabelMeta()
      notify('labels:updated')
    }
    return result
  })

  ipcMain.handle('labels:rename', (_, { id, name }) => {
    const updated = renameLabel(id, name)
    refreshLabelMeta()
    notify('labels:updated')
    return updated
  })

  ipcMain.handle('labels:recolor', (_, { id, color }) => {
    const updated = recolorLabel(id, color ?? null)
    refreshLabelMeta()
    notify('labels:updated')
    return updated
  })

  ipcMain.handle('labels:delete', (_, { id }) => {
    dbDeleteLabel(id)
    refreshLabels()
    notify('labels:updated')
    notify('packages:updated')
    notify('contents:updated')
    return { ok: true }
  })

  /** Apply or remove a label across N packages atomically. */
  ipcMain.handle('labels:apply-packages', (_, { id, filenames, applied }) => {
    if (!Array.isArray(filenames) || filenames.length === 0) return { ok: true, count: 0 }
    if (applied) dbApplyLabelToPackages(id, filenames)
    else dbRemoveLabelFromPackages(id, filenames)
    refreshLabels()
    notify('labels:updated')
    notify('packages:updated')
    notify('contents:updated')
    return { ok: true, count: filenames.length }
  })

  /** Apply or remove a label across N content items atomically. */
  ipcMain.handle('labels:apply-contents', (_, { id, items, applied }) => {
    if (!Array.isArray(items) || items.length === 0) return { ok: true, count: 0 }
    if (applied) dbApplyLabelToContents(id, items)
    else dbRemoveLabelFromContents(id, items)
    refreshLabels()
    notify('labels:updated')
    notify('contents:updated')
    return { ok: true, count: items.length }
  })
}
