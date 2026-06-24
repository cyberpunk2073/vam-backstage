import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from '@/components/Toast'

/**
 * Favorite/bookmark interactivity for a single Hub resource. Fetches the user's
 * state on mount/id-change, reacts to Hub login/logout, and exposes optimistic
 * toggles that reconcile against the authoritative POST response.
 *
 * @param {string|number} resourceId
 */
export function useHubInteractions(resourceId) {
  const [state, setState] = useState({
    loggedIn: false,
    favorited: false,
    bookmarked: false,
    loading: true,
    serverFavoriteCount: null,
  })
  // Latest known state for optimistic-toggle reconciliation without stale closures.
  const stateRef = useRef(state)
  stateRef.current = state
  // The server-truth favorited at last fetch, so the displayed count can show a
  // live +/-1 relative to the base count (Twitter-style).
  const serverFavoritedRef = useRef(false)

  const fetchState = useCallback(() => {
    if (resourceId == null) return
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    // Fast cookie-only check so the bookmark button + enabled heart appear
    // immediately (default unbookmarked), before the slower page fetch resolves.
    window.api.hub
      .isLoggedIn()
      .then((loggedIn) => {
        if (!cancelled && loggedIn) setState((s) => ({ ...s, loggedIn: true }))
      })
      .catch(() => {})
    window.api.hub
      .resourceUserState(resourceId)
      .then((res) => {
        if (cancelled) return
        serverFavoritedRef.current = !!res?.favorited
        setState({
          loggedIn: !!res?.loggedIn,
          favorited: !!res?.favorited,
          bookmarked: !!res?.bookmarked,
          loading: false,
          serverFavoriteCount: typeof res?.favoriteCount === 'number' ? res.favoriteCount : null,
        })
      })
      .catch(() => {
        if (!cancelled)
          setState({ loggedIn: false, favorited: false, bookmarked: false, loading: false, serverFavoriteCount: null })
      })
    return () => {
      cancelled = true
    }
  }, [resourceId])

  useEffect(() => fetchState(), [fetchState])

  useEffect(() => {
    return window.api.onHubAuthChanged((data) => {
      if (data?.loggedIn) fetchState()
      // Logged out: clear personal state too, otherwise a filled heart lingers
      // after the count/bookmark (gated on login) disappear.
      else setState((s) => ({ ...s, loggedIn: false, favorited: false, bookmarked: false, serverFavoriteCount: null }))
    })
  }, [fetchState])

  const toggleFavorite = useCallback(async () => {
    const prev = stateRef.current.favorited
    setState((s) => ({ ...s, favorited: !prev }))
    const res = await window.api.hub.toggleFavorite(resourceId)
    if (res?.ok) {
      setState((s) => ({ ...s, favorited: !!res.favorited }))
    } else if (res?.reason === 'auth') {
      setState((s) => ({ ...s, loggedIn: false, favorited: prev }))
      toast('Sign in to the Hub to use favorites.', 'info')
    } else {
      setState((s) => ({ ...s, favorited: prev }))
      toast(res?.message || 'Could not update favorite.', 'error')
    }
  }, [resourceId])

  const toggleBookmark = useCallback(async () => {
    const prev = stateRef.current.bookmarked
    setState((s) => ({ ...s, bookmarked: !prev }))
    const res = await window.api.hub.toggleBookmark(resourceId, prev)
    if (res?.ok) {
      setState((s) => ({ ...s, bookmarked: !!res.bookmarked }))
    } else if (res?.reason === 'auth') {
      setState((s) => ({ ...s, loggedIn: false, bookmarked: prev }))
      toast('Sign in to the Hub to use bookmarks.', 'info')
    } else {
      setState((s) => ({ ...s, bookmarked: prev }))
      toast(res?.message || 'Could not update bookmark.', 'error')
    }
  }, [resourceId])

  // null until the page reports the real count (UI shows a skeleton meanwhile).
  const favoriteCount =
    state.serverFavoriteCount == null
      ? null
      : Math.max(
          0,
          state.serverFavoriteCount + (state.favorited === serverFavoritedRef.current ? 0 : state.favorited ? 1 : -1),
        )

  return { ...state, favoriteCount, toggleFavorite, toggleBookmark }
}
