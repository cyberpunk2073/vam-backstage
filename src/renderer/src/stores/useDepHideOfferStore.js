import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistViewState, asBool } from './persistViewState'

/**
 * Dismissal state for the "hide existing dependency content" offer nudge shown
 * in the Library. Two escalating levels so "not now" and "never" map to
 * different behavior:
 *
 *   softDismissed — the user closed the general Library nudge once. It stops
 *     appearing on the default view; the contextual Dependencies-filter variant
 *     may still offer (you only see it when you deliberately filter to deps) but
 *     now carries a de-emphasized "Don't show again".
 *   hardDismissed — the user chose "Don't show again". No nudge appears anywhere;
 *     the sweep stays reachable from Settings and the package context menu.
 *
 * `eligible` gates the whole offer to genuine fresh installs: the first-run
 * wizard sets it, so existing users (who onboarded before this feature and never
 * re-run the wizard) leave it at its `false` default and never see the nudge.
 * This needs no DB migration — absence of the flag simply means "existing user".
 *
 * Low-stakes localStorage state: if it resets, the offer simply reappears while
 * there is still un-swept dependency content, and vanishes for good once swept.
 */
export const useDepHideOfferStore = create(
  persist(
    (set) => ({
      eligible: false,
      softDismissed: false,
      hardDismissed: false,
      setEligible: (v) => set({ eligible: !!v }),
      dismissSoft: () => set({ softDismissed: true }),
      dismissHard: () => set({ softDismissed: true, hardDismissed: true }),
    }),
    persistViewState('dep-hide-offer', {
      eligible: asBool,
      softDismissed: asBool,
      hardDismissed: asBool,
    }),
  ),
)
