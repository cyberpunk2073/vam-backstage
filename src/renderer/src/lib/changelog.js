/**
 * In-app release notes (substantial user-facing changes only), newest first.
 * @typedef {{ kind: 'new' | 'improved' | 'fixed' | 'removed', title: string, body: string }} ChangelogNote
 * @typedef {{ version: string, date: string, notes: ChangelogNote[] }} ChangelogEntry
 * @type {ChangelogEntry[]}
 */
export const CHANGELOG = [
  {
    version: '0.3.0',
    date: '2026-07-08',
    notes: [
      {
        kind: 'new',
        title: 'Use your library from other devices',
        body: 'New client-server mode lets a second computer on your network connect to your main library and browse, download, and manage packages remotely. Set it up in Settings.',
      },
      {
        kind: 'new',
        title: 'Wishlist for Hub packages',
        body: 'Pin packages you want to grab later, right from Hub cards or the details panel, then browse them in the new Wishlist tab with its own search, filters, and sorting. Wishlisted packages stay visible even if they disappear from the Hub.',
      },
      {
        kind: 'new',
        title: 'Find more from an author on the Hub',
        body: 'When filtering your library, content, or wishlist by author, a new arrow button next to the filter jumps straight to a Hub search for that creator.',
      },
      {
        kind: 'improved',
        title: 'Extracted presets know where they came from',
        body: 'Presets extracted from packages are now tied to their source: they show an "extracted" badge, follow the package when it is disabled or removed, and can be re-extracted from the right-click menu to update them.',
      },
      {
        kind: 'improved',
        title: 'Many small improvements',
        body: "Type any address into the Hub browser's address bar; flip through content thumbnails with arrow keys.",
      },
      {
        kind: 'fixed',
        title: 'Bulk right-click actions',
        body: 'Right-click menu actions now reliably apply to every selected item.',
      },
      {
        kind: 'fixed',
        title: 'Many small fixes',
        body: 'The macOS installer no longer has signature issues, plus fixes to Hub link refresh and update checks.',
      },
    ],
  },
  {
    version: '0.2.5',
    date: '2026-07-03',
    notes: [
      {
        kind: 'removed',
        title: 'Removed Hub favorites, bookmarks, and likes features',
        body: 'By request of the Hub admins, favoriting, bookmarking, and liking resources from the details panel is disabled.',
      },
      {
        kind: 'improved',
        title: 'Picks up where you left off',
        body: 'The app now reopens on the view you were last using and remembers your filters, sorting, and layout between restarts.',
      },
      {
        kind: 'fixed',
        title: 'Small fixes',
        body: 'Fixed some Patreon links that would not open, and Hub downloads that could sometimes fail.',
      },
    ],
  },
  {
    version: '0.2.4',
    date: '2026-06-30',
    notes: [
      {
        kind: 'new',
        title: 'Favorites, bookmarks, and likes on the Hub',
        body: 'When signed in to the Hub browser, favorite, bookmark, and like resources right from their details panel.',
      },
      {
        kind: 'new',
        title: 'Link packages to the Hub',
        body: 'Packages missing from the public index, like paid ones, now get matched to the Hub automatically, and you can link any package to its Hub page yourself with "Link to Hub..." in the right-click menu.',
      },
      {
        kind: 'new',
        title: 'Packages in subfolders',
        body: "Packages organized into subfolders now show up and behave like any other instead of being skipped, and offload directories can now live inside VaM's Saves folder, such as the one BrowserAssist offloads to.",
      },
      {
        kind: 'improved',
        title: 'Browse the Hub without losing your place',
        body: 'Step through search results with Previous/Next buttons and arrow keys, and when you follow a link inside the Hub browser the details panel updates to match the package you land on.',
      },
      {
        kind: 'improved',
        title: 'Many small improvements',
        body: 'Newly added content stays grouped together under "Recently installed", arrow keys move across rows and columns in grids, Hub browsing and downloads follow your system proxy settings, and Hub search ignores stray spaces.',
      },
      {
        kind: 'fixed',
        title: 'Many small fixes',
        body: "Fixed downloads for packages with non-Latin names, a freeze when removing packages from the right-click menu, Hub scrolling that could stop loading more, and a search box that wouldn't always clear. Startup is also quicker on Windows.",
      },
    ],
  },
  {
    version: '0.2.3',
    date: '2026-06-24',
    notes: [
      {
        kind: 'new',
        title: 'Install dependencies straight from the Hub',
        body: "Missing dependencies in a Hub resource's dependency list now have their own Install button, so you can grab just the pieces you need without leaving the list.",
      },
      {
        kind: 'new',
        title: 'Settings carried over on update',
        body: 'Installing a newer version of a package now inherits your custom category, labels, and hidden/favorite flags from the previous version, so updates no longer reset how you organized it.',
      },
      {
        kind: 'improved',
        title: 'Know which looks are already extracted',
        body: "Packages and legacy looks now show a checkmark once you've extracted an appearance preset from them, making it easy to see what's left to convert.",
      },
      {
        kind: 'improved',
        title: 'Many small improvements',
        body: 'Added a "Non-commercial use allowed" license filter, dependency search now keeps parent items so matches stay in context, smoother Hub scrolling.',
      },
    ],
  },
  {
    version: '0.2.2',
    date: '2026-05-04',
    notes: [
      {
        kind: 'new',
        title: 'Hide bundled hairstyles, poses, and clothing',
        body: 'Optional auto-hide rules for hair, pose, and clothing items that ship inside packages categorized as something else, so the Hairstyles, Poses, and Clothing views only show dedicated packs.',
      },
      {
        kind: 'improved',
        title: 'Faster bulk actions',
        body: 'Enabling, disabling, and removing many packages at once is now noticeably quicker, with a handful of related bugs fixed.',
      },
      {
        kind: 'improved',
        title: 'Many small improvements',
        body: 'Polish across the library, content, and Hub views - including dependency list filtering, custom-tag search on the Hub, Hub browser improvements, more reliable update checks, and assorted fixes.',
      },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-04-30',
    notes: [
      {
        kind: 'new',
        title: 'Offload directories',
        body: 'Register paths outside AddonPackages to keep packages in your library without VaM loading them.',
      },
      {
        kind: 'new',
        title: 'Loose files in the library',
        body: 'Files outside .var packages now show up alongside your installs, with a filter to view local-only items.',
      },
      {
        kind: 'new',
        title: 'Custom labels',
        body: 'Organize packages and content into your own groups, filterable in both the library and content views.',
      },
      {
        kind: 'improved',
        title: 'Faster and smoother',
        body: 'Quicker startup, snappier browsing right after a scan, and faster thumbnail loads.',
      },
      {
        kind: 'improved',
        title: 'Window state remembered',
        body: 'Window size and position are now restored between launches.',
      },
    ],
  },
  {
    version: '0.1.11',
    date: '2026-04-22',
    notes: [
      {
        kind: 'new',
        title: 'Preset extraction',
        body: 'Extract appearance and clothing presets from scenes, and convert legacy looks to appearance presets. Available from the right-click menu.',
      },
      {
        kind: 'improved',
        title: 'Dependency hide prompt',
        body: 'Toggling the dependency-hiding setting now offers to apply it to all existing dependency content.',
      },
    ],
  },
]
