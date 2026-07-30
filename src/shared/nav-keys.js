/**
 * Back / forward / pager keyboard shortcuts, shared by the host document and the
 * Hub <webview> guest so both panes answer to exactly the same keys. Keys typed
 * into the guest never reach the host, so main intercepts them there and relays
 * `navigate:<action>` — the returned action doubles as the channel suffix.
 *
 * Platform split follows the browsers: Alt+←/→ on Windows/Linux, Cmd+[ / Cmd+]
 * on macOS. macOS Cmd+←/→ and Option+←/→ are deliberately left alone: they are
 * line/word text-editing keys, and `before-input-event` gives no way to tell
 * whether a guest text field has focus, so stealing them would break typing on
 * the Hub page.
 *
 * @param {{ key?: string, code?: string, alt?: boolean, control?: boolean, meta?: boolean, shift?: boolean }} input
 *   Electron `before-input-event` shape; use `navShortcutFromKeyboardEvent` for DOM events.
 * @param {boolean} isMac
 * @returns {'back'|'forward'|'pager-prev'|'pager-next'|null}
 */
export function matchNavShortcut(input, isMac) {
  const { key, code, alt, control, meta, shift } = input
  if (key === 'BrowserBack') return 'back'
  if (key === 'BrowserForward') return 'forward'
  if (control && !alt && !meta && (key === 'Tab' || code === 'Tab')) return shift ? 'pager-prev' : 'pager-next'
  if (isMac) {
    if (!meta || alt || control) return null
    if (key === '[' || code === 'BracketLeft') return 'back'
    if (key === ']' || code === 'BracketRight') return 'forward'
    return null
  }
  if (!alt || meta || control) return null
  if (key === 'ArrowLeft' || code === 'ArrowLeft') return 'back'
  if (key === 'ArrowRight' || code === 'ArrowRight') return 'forward'
  return null
}

/** Adapt a DOM KeyboardEvent to the shape `matchNavShortcut` expects. */
export function navShortcutFromKeyboardEvent(e) {
  return { key: e.key, code: e.code, alt: e.altKey, control: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }
}
