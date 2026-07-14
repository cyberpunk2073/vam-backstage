import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistViewState, asBool, asClamped } from './persistViewState'

/**
 * Graph view UI state persisted to localStorage. Low-stakes — if it resets the
 * user gets physics defaults and sees the experimental caution again.
 *
 * - `warningDismissed` — experimental-feature banner
 * - physics sliders (UI-facing friction: 1 = sticky; cosmos takes 1 - friction)
 *
 * Tuning philosophy (engine caveats live in DependencyGraphView.jsx): springs
 * define structure, repulsion only separates. If repulsion:linkSpring drifts
 * back above ~30:1 the layout anneals into a uniform hex-packed lattice where
 * topology stops mattering. Each slider's honest role:
 * - Repulsion: width of the voids between constellations. Side effect: it is
 *   also the "wind" that pushes leaf satellites leeward, so past ~150 you pay
 *   more in streamer stretching than you gain in spread.
 * - Link dist: orbit radius of private deps — the knob for "thumbnails feel
 *   packed", not repulsion.
 * - Link pull: global spring multiplier. Stability budget: per-link strength
 *   (up to ~11 for leaf links) × linkSpring × alpha must stay below ~1, so
 *   values past ~1.2 make dense areas vibrate and never settle.
 * - Cluster: constellation cohesion vs the cross-community links that try to
 *   merge everything back into one mass.
 * - Gravity/Center: stray containment only — both are harmonic traps that
 *   quietly re-form the central ball if raised.
 */
export const GRAPH_PARAM_DEFAULTS = {
  // A hair above zero, just to stop disconnected nodes from parking on the
  // box walls.
  gravity: 0.003,
  center: 0,
  repulsion: 120,
  friction: 0.75,
  linkSpring: 1.0,
  // Rest length = private-dep orbit radius. Springs are attraction-only, so
  // this is a floor: stiff leaf links settle here while weakly-linked hub
  // neighborhoods get pushed far beyond it by repulsion. Sized so an orbit
  // comfortably clears the largest thumbnails (~24) — below that, satellites
  // visually touch their parent and the layout reads as "packed" no matter
  // how much repulsion inflates the voids.
  linkDistance: 45,
  collision: 1.5,
  // Extra collision radius (space units) beyond the thumbnail. Sized so
  // sibling satellites on the same orbit *touch*: the ambient repulsion field
  // of the neighborhood pushes all of a parent's satellites to the leeward
  // side of their leash circle, and only sibling-on-sibling contact can fan
  // them back around the ring. Too low and satellites blob at one offset; too
  // high (> linkDistance - radii) and collision overrides the tight orbits.
  collisionPadding: 12,
  cluster: 0.45,
}

const initializer = (set) => ({
  warningDismissed: false,
  dismissWarning: () => set({ warningDismissed: true }),
  ...GRAPH_PARAM_DEFAULTS,
  setParam: (key, value) => set({ [key]: value }),
  resetParams: () => set({ ...GRAPH_PARAM_DEFAULTS }),
})

// Persistence can be disabled while tuning GRAPH_PARAM_DEFAULTS so edits above
// apply on reload instead of being shadowed by localStorage.
const PERSIST = true

export const useGraphStore = create(
  PERSIST
    ? persist(
        initializer,
        persistViewState('graph-view', {
          warningDismissed: asBool,
          // Only slider-backed knobs — gravity/center/collision/cluster stay at code defaults.
          repulsion: asClamped(0, 200),
          friction: asClamped(0, 1),
          linkSpring: asClamped(0, 2),
          linkDistance: asClamped(2, 200),
        }),
      )
    : initializer,
)
