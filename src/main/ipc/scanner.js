import { ipcMain, dialog, app } from 'electron'
import { access, readdir } from 'fs/promises'
import { dirname, join } from 'path'
import { ADDON_PACKAGES } from '../../shared/paths.js'
import { getSetting, clearAllCorrupted, batchSetCorrupted } from '../db.js'
import { runScan, applyAutoHide, removeAutoHide } from '../scanner/index.js'
import { runIntegrityCheck } from '../scanner/integrity.js'
import { buildFromDb } from '../store.js'
import { startWatcher } from '../watcher.js'
import { resolvePackageThumbnails } from '../thumb-resolver.js'
import { notify, getWindow } from '../notify.js'
import { scanHubDetails } from '../hub/scanner.js'

/** Filled after startup `runScan` when unreadable .var files are found; consumed once by the renderer. */
let pendingStartupUnreadable = null

export function setPendingStartupUnreadable(filenames) {
  pendingStartupUnreadable = filenames?.length ? [...filenames] : null
}

export function registerScanHandlers() {
  ipcMain.handle('startup:consume-unreadable', () => {
    const out = pendingStartupUnreadable
    pendingStartupUnreadable = null
    return out || []
  })

  ipcMain.handle('scan:start', async () => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    const result = await runScan(vamDir, (progress) => {
      notify('scan:progress', progress)
    })

    notify('packages:updated')
    notify('contents:updated')

    startWatcher(vamDir)
    resolvePackageThumbnails()

    return result
  })

  ipcMain.handle('scan:apply-auto-hide', async () => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    await applyAutoHide(vamDir, (progress) => {
      notify('auto-hide:progress', progress)
    })

    notify('contents:updated')
    return { ok: true }
  })

  ipcMain.handle('scan:remove-auto-hide', async () => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    await removeAutoHide(vamDir, (progress) => {
      notify('auto-hide:progress', progress)
    })

    notify('contents:updated')
    return { ok: true }
  })

  ipcMain.handle('integrity:check', async () => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    clearAllCorrupted()

    const result = await runIntegrityCheck(vamDir, (progress) => {
      notify('integrity:progress', progress)
    })

    if (result.corruptedFiles.length > 0) {
      batchSetCorrupted(result.corruptedFiles.map((fn) => [fn, true]))
    }

    buildFromDb()
    notify('packages:updated')

    return { checked: result.checked, corrupted: result.corrupted, corruptedFiles: result.corruptedFiles }
  })

  ipcMain.handle('wizard:enrich-hub', async () => {
    return await scanHubDetails((data) => notify('hub-scan:progress', data))
  })

  // --- First-run wizard handlers ---

  ipcMain.handle('wizard:detect-vam-dir', async () => {
    const detected = await detectVamDir()
    if (!detected) return { path: null, varCount: 0, source: null }
    const varCount = await quickCountVars(detected.path)
    return { path: detected.path, varCount, source: detected.source }
  })

  ipcMain.handle('wizard:browse-vam-dir', async (_e, defaultPath) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openDirectory'],
      title: 'Select VaM installation directory',
      ...(defaultPath ? { defaultPath } : {}),
    })
    if (result.canceled || !result.filePaths.length) return { cancelled: true }

    const dir = result.filePaths[0]
    try {
      await access(join(dir, ADDON_PACKAGES))
    } catch {
      return { path: dir, varCount: 0, valid: false }
    }
    const varCount = await quickCountVars(dir)
    return { path: dir, varCount, valid: true }
  })
}

/** Walk up to `maxDepth` levels from each root; dedupe by path; first root wins for `source`. */
function walkUpRoots(roots, maxDepth) {
  const seen = new Set()
  const out = []
  for (const { start, source } of roots) {
    let dir = start
    for (let i = 0; i < maxDepth; i++) {
      if (!seen.has(dir)) {
        seen.add(dir)
        out.push({ dir, source })
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return out
}

async function detectVamDir() {
  const candidates = walkUpRoots(
    [
      // Terminal / launcher cwd may sit inside or above the VaM tree
      { start: process.cwd(), source: 'cwd' },
      // Production: app lives next to or under VaM
      { start: dirname(app.getPath('exe')), source: 'exe' },
      // Dev: project may be inside VaM dir
      { start: app.getAppPath(), source: 'app' },
    ],
    5,
  )

  for (const { dir, source } of candidates) {
    try {
      await access(join(dir, ADDON_PACKAGES))
      return { path: dir, source }
    } catch {}
  }
  return null
}

async function quickCountVars(vamDir) {
  try {
    const entries = await readdir(join(vamDir, ADDON_PACKAGES), { recursive: true })
    return entries.filter((n) => n.toLowerCase().endsWith('.var')).length
  } catch {
    return 0
  }
}
