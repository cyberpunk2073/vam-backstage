/**
 * In-app release notes (substantial user-facing changes only), newest first.
 * @typedef {{ kind: 'new' | 'improved' | 'fixed', title: string, body: string }} ChangelogNote
 * @typedef {{ version: string, date: string, notes: ChangelogNote[] }} ChangelogEntry
 * @type {ChangelogEntry[]}
 */
export const CHANGELOG = [
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
