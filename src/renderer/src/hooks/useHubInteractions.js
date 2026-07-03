import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from '@/components/Toast'

// The personal flags, all cleared. Spread into a fresh/logged-out state so the
// shape stays in one place.
const CLEARED = { favorited: false, bookmarked: false, liked: false, disliked: false }

/**
 * Favorite/bookmark interactivity for a single Hub resource. Fetches the user's
 * state on mount/id-change, reacts to Hub login/logout, and exposes optimistic
 * toggles that reconcile against the authoritative POST response.
 *
 * @param {string|number} resourceId
 * @param {{ enabled?: boolean }} [options] When `enabled` is false the hook stays
 *   mounted but performs no fetches and reports a neutral logged-out state.
 */
export function useHubInteractions(resourceId, { enabled = true } = {}) {
  const [state, setState] = useState({
    loggedIn: false,
    ...CLEARED,
    loading: enabled,
    serverFavoriteCount: null,
  })
  // Latest known state for optimistic-toggle reconciliation without stale closures.
  const stateRef = useRef(state)
  stateRef.current = state
  // The server-truth favorited at last fetch, so the displayed count can show a
  // live +/-1 relative to the base count (Twitter-style).
  const serverFavoritedRef = useRef(false)

  const fetchState = useCallback(() => {
    if (!enabled || resourceId == null) return
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
          liked: !!res?.liked,
          disliked: !!res?.disliked,
          loading: false,
          serverFavoriteCount: typeof res?.favoriteCount === 'number' ? res.favoriteCount : null,
        })
      })
      .catch(() => {
        if (!cancelled) setState({ loggedIn: false, ...CLEARED, loading: false, serverFavoriteCount: null })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, resourceId])

  useEffect(() => fetchState(), [fetchState])

  useEffect(() => {
    if (!enabled) return
    return window.api.onHubAuthChanged((data) => {
      if (data?.loggedIn) fetchState()
      // Logged out: clear personal state too, otherwise a filled heart lingers
      // after the count/bookmark (gated on login) disappear.
      else setState((s) => ({ ...s, loggedIn: false, ...CLEARED, serverFavoriteCount: null }))
    })
  }, [enabled, fetchState])

  // Shared optimistic toggle: snapshot prev → apply optimistic patch → reconcile
  // against the POST result, reverting (and surfacing a toast) on auth/error.
  const runToggle = useCallback(({ snapshot, optimistic, reconcile, revert, call, authMsg, errMsg }) => {
    const prev = snapshot(stateRef.current)
    setState((s) => ({ ...s, ...optimistic(prev) }))
    return call(prev).then((res) => {
      if (res?.ok) {
        setState((s) => ({ ...s, ...reconcile(res) }))
      } else if (res?.reason === 'auth') {
        setState((s) => ({ ...s, loggedIn: false, ...revert(prev) }))
        toast(authMsg, 'info')
      } else {
        setState((s) => ({ ...s, ...revert(prev) }))
        toast(res?.message || errMsg, 'error')
      }
    })
  }, [])

  const toggleFavorite = useCallback(
    () =>
      runToggle({
        snapshot: (s) => s.favorited,
        optimistic: (prev) => ({ favorited: !prev }),
        reconcile: (res) => ({ favorited: !!res.favorited }),
        revert: (prev) => ({ favorited: prev }),
        call: () => window.api.hub.toggleFavorite(resourceId),
        authMsg: 'Sign in to the Hub to use favorites.',
        errMsg: 'Could not update favorite.',
      }),
    [resourceId, runToggle],
  )

  const toggleBookmark = useCallback(
    () =>
      runToggle({
        snapshot: (s) => s.bookmarked,
        optimistic: (prev) => ({ bookmarked: !prev }),
        reconcile: (res) => ({ bookmarked: !!res.bookmarked }),
        revert: (prev) => ({ bookmarked: prev }),
        call: (prev) => window.api.hub.toggleBookmark(resourceId, prev),
        authMsg: 'Sign in to the Hub to use bookmarks.',
        errMsg: 'Could not update bookmark.',
      }),
    [resourceId, runToggle],
  )

  const toggleLike = useCallback(
    () =>
      runToggle({
        snapshot: (s) => ({ liked: s.liked, disliked: s.disliked }),
        // Liking always clears any existing dislike (the Hub treats them as exclusive).
        optimistic: (prev) => ({ liked: !prev.liked, disliked: false }),
        reconcile: (res) => ({ liked: !!res.liked, disliked: !!res.disliked }),
        revert: (prev) => ({ liked: prev.liked, disliked: prev.disliked }),
        call: (prev) => window.api.hub.toggleLike(resourceId, prev.liked),
        authMsg: 'Sign in to the Hub to like resources.',
        errMsg: 'Could not update like.',
      }),
    [resourceId, runToggle],
  )

  // null until the page reports the real count (UI shows a skeleton meanwhile).
  const favoriteCount =
    state.serverFavoriteCount == null
      ? null
      : Math.max(
          0,
          state.serverFavoriteCount + (state.favorited === serverFavoritedRef.current ? 0 : state.favorited ? 1 : -1),
        )

  return { ...state, favoriteCount, toggleFavorite, toggleBookmark, toggleLike }
}
