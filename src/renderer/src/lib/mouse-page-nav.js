export const MOUSE_PAGE_BACK_BUTTON = 3
export const MOUSE_PAGE_FORWARD_BUTTON = 4

const IGNORED_TARGETS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'A'])

function isElement(value) {
  return typeof Element !== 'undefined' && value instanceof Element
}

export function isMousePageBackButton(button) {
  return button === MOUSE_PAGE_BACK_BUTTON
}

export function isMousePageForwardButton(button) {
  return button === MOUSE_PAGE_FORWARD_BUTTON
}

export function getMousePageDirection(button) {
  if (isMousePageBackButton(button)) return -1
  if (isMousePageForwardButton(button)) return 1
  return 0
}

export function getAppCommandPageDirection(command) {
  if (command === 'browser-backward') return -1
  if (command === 'browser-forward') return 1
  return 0
}

export function shouldIgnoreMousePageTargetName(tagName) {
  return IGNORED_TARGETS.has(String(tagName || '').toUpperCase())
}

export function shouldIgnoreMousePageTarget(target) {
  if (!isElement(target)) return false
  const el = target.closest('input, textarea, select, a, [contenteditable="true"]')
  return !!el
}

export function scrollMousePage(target, root, direction) {
  if (!isElement(root)) return false
  const start = isElement(target) ? target : root
  const scroller = start.closest('[data-page-nav-scroll]') || root.querySelector('[data-page-nav-scroll]')
  if (!scroller) return false
  scroller.scrollBy({ top: direction * Math.max(1, scroller.clientHeight), behavior: 'auto' })
  return true
}
