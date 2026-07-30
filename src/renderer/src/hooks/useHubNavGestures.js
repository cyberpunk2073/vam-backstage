import { useEffect, useRef } from 'react'
import { useHubStore } from '@/stores/useHubStore'
import { useViewStore } from '@/stores/useViewStore'
import { IS_MAC } from '@/lib/utils'
import { matchNavShortcut, navShortcutFromKeyboardEvent } from '@shared/nav-keys.js'

function isEditableTarget(el) {
  if (!el || el.tagName == null) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * Wire discrete back/forward inputs to hub detail navigation: mouse buttons 3/4,
 * the platform back/forward keys (see `matchNavShortcut`), and Electron
 * app-command / 3-finger swipe (relayed as `navigate:back` / `navigate:forward`).
 *
 * Only active while Hub detail is showing. Prefer the embedded hub webview
 * whenever it has guest history; otherwise peel the app detail stack. Keys typed
 * into the webview are stolen in main via `before-input-event` on the guest.
 *
 * @param {{
 *   onNavigate?: (view: string) => void,
 *   detailNavRef: React.RefObject<{ tryGuestBack?: () => boolean, tryGuestForward?: () => boolean } | null>,
 * }} opts
 */
export function useHubNavGestures({ onNavigate, detailNavRef }) {
  // Both selectors must run unconditionally — HubView stays mounted (hidden
  // <Activity>) while other tabs are active, so a short-circuited second hook
  // would change the hook count on the very render that leaves the Hub.
  const hubActive = useViewStore((s) => s.view === 'hub')
  const detailOpen = useHubStore((s) => !!s.detailResource)
  const enabled = hubActive && detailOpen

  const handlersRef = useRef({})
  handlersRef.current = {
    peelAppBack: () => {
      const result = useHubStore.getState().popDetailHistory()
      if (result?.navigateTo) onNavigate?.(result.navigateTo)
    },
    tryBack: () => {
      if (detailNavRef.current?.tryGuestBack?.()) return
      handlersRef.current.peelAppBack()
    },
    tryForward: () => {
      detailNavRef.current?.tryGuestForward?.()
    },
  }

  useEffect(() => {
    if (!enabled) return undefined
    const onMouseUp = (e) => {
      if (e.button === 3) {
        e.preventDefault()
        handlersRef.current.tryBack()
      } else if (e.button === 4) {
        e.preventDefault()
        handlersRef.current.tryForward()
      }
    }
    const onMouseDown = (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
    }
    const onKeyDown = (e) => {
      if (e.defaultPrevented) return
      if (isEditableTarget(e.target)) return
      // Pager actions from the same matcher belong to HubDetail — ignore them here.
      const action = matchNavShortcut(navShortcutFromKeyboardEvent(e), IS_MAC)
      if (action !== 'back' && action !== 'forward') return
      e.preventDefault()
      if (action === 'back') handlersRef.current.tryBack()
      else handlersRef.current.tryForward()
    }
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !window.api?.on) return undefined
    const offBack = window.api.on('navigate:back', () => handlersRef.current.tryBack())
    const offForward = window.api.on('navigate:forward', () => handlersRef.current.tryForward())
    return () => {
      offBack?.()
      offForward?.()
    }
  }, [enabled])
}
