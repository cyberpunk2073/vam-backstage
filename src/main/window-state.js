import { screen } from 'electron'
import { getSetting, setSetting } from './db.js'

const SETTING_KEY = 'main_window_state'
const SAVE_DEBOUNCE_MS = 500

export const DEFAULT_WIDTH = 1280
export const DEFAULT_HEIGHT = 820
export const MIN_WIDTH = 800
export const MIN_HEIGHT = 500

/**
 * @returns {{ x: number, y: number, width: number, height: number, isMaximized: boolean } | null}
 */
export function loadMainWindowState() {
  const raw = getSetting(SETTING_KEY)
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const { x, y, width, height } = parsed
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  const fitted = isRectOnAnyDisplay(rect) ? fitToMatchedDisplay(rect) : centerOnPrimary(rect)
  return fitted && { ...fitted, isMaximized: Boolean(parsed.isMaximized) }
}

/**
 * Some Linux/X11 sessions report bogus `workArea`; fall back to `bounds` in that case.
 * @param {import('electron').Display} d
 * @returns {import('electron').Rectangle | null}
 */
function getUsableArea(d) {
  if (d.workArea.width > 0 && d.workArea.height > 0) return d.workArea
  if (d.bounds.width > 0 && d.bounds.height > 0) return d.bounds
  return null
}

/**
 * @param {import('electron').Rectangle} a
 * @param {import('electron').Rectangle} b
 */
function rectOverlaps(a, b) {
  return a.x + a.width > b.x && a.x < b.x + b.width && a.y + a.height > b.y && a.y < b.y + b.height
}

/** @param {import('electron').Rectangle} rect */
function isRectOnAnyDisplay(rect) {
  return screen.getAllDisplays().some((d) => {
    const area = getUsableArea(d)
    return area && rectOverlaps(rect, area)
  })
}

/** @param {import('electron').Rectangle} rect */
function fitToMatchedDisplay(rect) {
  let display
  try {
    display = screen.getDisplayMatching(rect)
  } catch {
    return null
  }
  const area = getUsableArea(display)
  if (!area) return null
  const width = Math.min(Math.max(MIN_WIDTH, rect.width), area.width)
  const height = Math.min(Math.max(MIN_HEIGHT, rect.height), area.height)
  const x = Math.min(Math.max(area.x, rect.x), area.x + area.width - width)
  const y = Math.min(Math.max(area.y, rect.y), area.y + area.height - height)
  return { x, y, width, height }
}

/** @param {import('electron').Rectangle} rect */
function centerOnPrimary(rect) {
  const area = getUsableArea(screen.getPrimaryDisplay())
  if (!area) return null
  const width = Math.min(Math.max(MIN_WIDTH, rect.width), area.width)
  const height = Math.min(Math.max(MIN_HEIGHT, rect.height), area.height)
  return {
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  }
}

/** @param {import('electron').BrowserWindow} win */
function saveMainWindowState(win) {
  if (win.isDestroyed()) return
  const state = { ...win.getNormalBounds(), isMaximized: win.isMaximized() }
  setSetting(SETTING_KEY, JSON.stringify(state))
}

/** @param {import('electron').BrowserWindow} win */
export function attachMainWindowStatePersistence(win) {
  let timer = null
  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    saveMainWindowState(win)
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize']) win.on(ev, schedule)
  win.on('close', flush)
}
