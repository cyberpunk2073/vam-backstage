import { flushSync } from 'react-dom'

/* Transient Radix overlays that portal to <body> but are anchored to a trigger inside a view.
   When a React <Activity> hides that view (tab switch, hub/wishlist toggle), the frozen subtree
   can no longer finish closing its overlay: Presence waits for an animationend it will never
   process (its effects are disconnected), and the portal is left orphaned at the top-left corner
   (the display:none trigger has a zero-size anchor rect). */
const OVERLAY_CONTENT_SELECTOR = [
  'tooltip-content',
  'context-menu-content',
  'context-menu-sub-content',
  'dropdown-menu-content',
  'popover-content',
  'select-content',
]
  .map((slot) => `[data-slot='${slot}']`)
  .join(', ')

/**
 * Synchronously close and unmount every transient overlay. Call this right before hiding a view
 * behind <Activity> — while the view is still visible and its effects are still connected — so
 * nothing is left to orphan. Must run in the same task as the state update that hides the view:
 * both the overlay close and the view hide would otherwise land in one React commit, where
 * Activity disconnects the overlay's effects before Presence can process the close at all.
 *
 * Ordinary overlay closes are untouched and keep their exit animations.
 */
export function dismissTransientOverlays() {
  if (!document.querySelector(OVERLAY_CONTENT_SELECTOR)) return

  // Suppress exit animations for the duration of this task (see main.css): with computed
  // animation-name 'none', Presence skips unmountSuspended and unmounts synchronously.
  const root = document.documentElement
  root.setAttribute('data-nav-dismiss', '')
  setTimeout(() => root.removeAttribute('data-nav-dismiss'), 0)

  // Close everything that's open: every Radix DismissableLayer (menus, popovers, selects,
  // tooltips) dismisses on a pointerdown outside itself, and dispatches that close discretely
  // (flushSync inside Radix) — combined with the suppressed exit animation the content unmounts
  // before this dispatch returns. Dispatched on <body> so it never passes through #root, i.e.
  // no React onPointerDown handlers in the app can see it.
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

  // Finish anything that was already animating out (e.g. a menu closed by the real pointerdown
  // of the very click that is now navigating): Presence unmounts on animationend from its node,
  // and the suppressor above makes the computed animation-name 'none' match the event's.
  for (const el of document.querySelectorAll(OVERLAY_CONTENT_SELECTOR)) {
    const animationName = getComputedStyle(el).animationName.split(',')[0].trim()
    flushSync(() => el.dispatchEvent(new AnimationEvent('animationend', { animationName })))
  }
}
