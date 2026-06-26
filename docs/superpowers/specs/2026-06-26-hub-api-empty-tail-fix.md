# Hub API Empty Tail Page Fix

## Problem

The Hub API reports more pages than it actually returns. In one live probe, an unfiltered request reported `total_found=50055` and `total_pages=1669`, but pages after `1538` returned no resources. Paged Hub mode exposes this by letting users jump to "last" and then page through empty results.

## Goal

When a paged Hub request lands on an empty page above page `1`, recover to the real last non-empty page for the current filters and sort. The UI should show that page, update the current page, and clamp `totalPages` so pagination controls stop pointing into the empty tail.

## Required Fix

Implement the recovery in `useHubStore.fetchResources`, because launch restore, page buttons, and direct page jumps all route through it.

Behavior:

- Keep normal successful requests unchanged.
- If a non-append request for `requestedPage > 1` returns zero resources while the API still reports that page as valid, resolve the last non-empty page below `requestedPage`.
- Use bounded probing, not a full scan. Start below the empty page, find a non-empty lower bound, then binary-search the last non-empty page.
- Fetch or keep the resolved page's resources.
- Set `page` to the resolved page and `totalPages` to that resolved page.
- Do not hardcode `1538`; that number is only observed API behavior.
- Do not change infinite scroll behavior except through the same store guard if it ever hits an empty tail.

## Nice To Have Later

Cache the resolved tail page per filter/sort key. The key should include search, sort, category, type, creator, paid/free, dependencies, tags, and hide-installed state, but exclude the requested page. Skip cache in the first implementation unless an existing cache already fits this exactly.

## Verification

Test with live API or mocked `window.api.hub.search`:

- page `1` with no results stays empty
- page inside real range works unchanged
- page past real tail resolves to last non-empty page
- pagination controls use the clamped `totalPages`
