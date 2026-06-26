# Targeted Library Navigation Design

## Goal

When a user chooses a targeted Library action, such as Hub or Content "View in Library", the target package must be visible and selected even if current Library filters would hide it.

## Behavior

Normal sidebar navigation to Library preserves the user's filters and selection. Targeted navigation with `selectPackage` clears Library filters to a maximum-inclusion state, updates the visible filter controls, and selects the requested package.

The maximum-inclusion Library state is:

- empty text filters
- `statusFilter: 'all'`
- `enabledFilter: 'all'`
- no type, tag, or label filters
- `license: 'Any'`

Sort and view preferences stay unchanged.

## Implementation

Add one store action in `useLibraryStore`, tentatively `showPackageInLibrary(filename)`. It centralizes the filter reset and target selection state. `LibraryView` calls it when consuming `navContext.current.selectPackage`, so all existing targeted callers reuse the same behavior without changing each button.

Keep the existing Content behavior unchanged: Library "View in gallery" already uses `showPackageContents()`, which resets Content filters for that targeted flow.

## Verification

Add/update the smallest store test if existing store tests cover filter actions. Otherwise run lint, format check, and build.
