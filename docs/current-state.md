## Known Issues

### Performance — Visibility Toggle Path (partially addressed)

- **Renderer does a full refetch on every `contents:updated`**: `ContentView` calls `fetchContents()` → `contents.list({})` (unfiltered), which clones, sorts, and maps all content items over IPC. `StatusBar` also re-fetches stats. For a single toggle this is heavy; could be replaced with a delta/patch notification.
- `getFilteredContents` always clones + sorts + maps the full array: Even when the renderer only needs to know about a change to one item, the IPC response serializes the entire content list.

### Minor / Low Priority

- Hub view virtual scrolling (currently accumulates all loaded cards in DOM via infinite scroll; fine for typical usage, may degrade with very deep scrolling)
- **Thumbnail blob URLs never revoked**: `useThumbnail.js` caches `URL.createObjectURL` results in module-level Map, never `revokeObjectURL`'d. Long sessions leak memory gradually..

## Polish ToDo

- conflict when direct package is overshadowed by newer version, but it is dependency so hides the content
- scan all hub packages on start wizard and external adds
- ~~Download button bottom margin in compact hub layout~~
- need some more testing of initial scan state - visibility, dep tree, and what changes are applied to user lib
- broader review on how we handle all types for external changes
  - visibility sidecars
  - package add/remove
  - multiple interdependent packages added/removed, including influincing dep tree of existing packages
  - package enable/disable
  - tag override
- javadoc the main functions and classes
- more test coverage
- updates tab in hub is hidden for some reason
- when no known content, still should be a button to browse file

## Features with low priority:

- custom tag system, tag negation filters
- hub: secondary sort, exclude commercial licenses and deps, hub hosted, asc/desc
- image galleries in hub
- findPackages likely supports sending entire library with high enough HTTP timeout instead of chunking by 50.
- dynamically adjust search result count such that it perfectly fills our rows. be mindful that changing per page counts would also alter the page number and might require some deduplication.
- hub dependencies page on the web shows "primary dependencies" and "sub-dependencies" that are likely deeper within the tree. investigate. can we get those from API? that would make our dep discovery more robust considering we improve all the transitive deps on install.
- add local content to gallery
- Maybe make actual package ID clearly visible in the package details?

### Old version handling after package update

After updating a package, the old version remains alongside the new one. The orphan filter doesn't apply (it's for `is_direct = 0` only). Need to design what happens to superseded versions — options include demotion to dependency, a "Superseded" filter, prompting the user, or just leaving them coexisting. Deferred.
