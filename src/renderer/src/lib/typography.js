/**
 * Prose typography recipes — roles across two density scales, plus a compact tier for
 * surfaces whose own controls run smaller than the dense scale.
 *
 * Prefer these constants (or SettingRow / EmptyState / SectionLabel / GroupHeading) over
 * hand-rolled size/color combos. Vertical gaps live with the components that own them, or
 * in docs/Implementation.md § Rhythm — not inventable per call site.
 *
 * Colors (against base/surface/elevated):
 *   primary     #e8e9ed — titles, labels, values
 *   emphasis    #d0d1de — inline emphasis inside prose (softer than primary on purpose)
 *   secondary   #82849a — body and clarification prose
 *   tertiary    #6b6e84 — structural chrome: group labels, table headers, metadata, counts
 *   aside       #57596e — skippable footnotes, resting icon-button states, disabled
 *   placeholder #4e5064 — input placeholders and unset values only
 *
 * Tertiary and aside were one token until they pulled in opposite directions: chrome needs to
 * stay legible because you look at a column header deliberately, while an aside needs to get
 * out of the way. One value could only ever be a compromise between the two.
 *
 * Roomy scale (dialogs, page prose): body 14px.
 * Dense scale (settings, panels, cards, tables): body 12px.
 * Settings row descriptions use CLARIFY_DENSE (11px) under LABEL (12px) — size steps
 * for hierarchy; both stay on secondary for readability.
 *
 * Roles:
 *   Title      — page / section / dialog heading; TITLE_GROUP for side-panel content groups
 *   Label      — dense row or field label (names a control)
 *   Value      — dense identifier the user reads as data (name, filename, path)
 *   Emphasis   — inline run inside body; inherits size, bolder + brighter
 *   Body       — main prose that must read clearly
 *   Clarify    — secondary clarification to body (smaller, same color)
 *   Meta       — counts, sizes, timestamps, status words (tertiary)
 *   Aside      — skippable footnote (smaller + aside tone)
 *   Semantic   — warning / error / success at enclosing body size (never its own size step)
 *
 * Assign each sentence a role: would skipping this line make a worse decision? If yes → body
 * or clarification. If no → metadata or aside. Delete it and lose no information → aside;
 * carries a fact found nowhere else → metadata.
 *
 * Budget: at most two sizes and three colors in one block (semantic excepted).
 * Size steps between body and clarification; color steps between clarification and aside.
 * Never put body/clarification on tertiary or aside — those tiers are chrome and footnotes.
 *
 * Do not invent text-[Npx] for prose outside these recipes. Retired for prose: 9 / 13 / 15 /
 * 17 / 22px. text-[10px] is chrome/chips only (and META_COMPACT / ASIDE_COMPACT). text-base is
 * headings/dialog titles only.
 *
 * Never override DialogDescription / AlertDialogDescription size or color — extend the
 * primitive with a variant if a denser dialog is needed.
 * Never opacity-modify theme text tokens (text-text-*, semantic colors). Photo-overlay
 * hierarchy may use text-white/NN (title bright, author/meta dimmer) — do not flatten.
 * App code uses text-text-*; muted-foreground / popover-foreground stay in components/ui only.
 *
 * Prose (tooltips, popovers, hover-cards, settings descriptions, dialog bodies) defaults to
 * secondary. Reserve primary for titles, labels, short identifiers, and inline emphasis —
 * not for running prose. TooltipContent encodes this; call sites should not restyle tip
 * prose back to primary.
 *
 * Leading: dense roles at arbitrary px (CLARIFY_DENSE, ASIDE_DENSE, ASIDE_COMPACT) bake
 * leading-snug — Tailwind pairs no line-height with text-[Npx]. Scale-token prose inherits
 * Tailwind's pairing; override to leading-relaxed only for multi-line roomy prose. Token
 * roles (META_*, MONO_DENSE, TITLE_GROUP, VALUE) never carry leading — call sites add
 * leading-none / leading-tight against chips and fixed-height rows. Do not bake leading into
 * CLARIFY — it is both paragraphs and list items.
 *
 * Settled during the consistency pass:
 *   StatusBar chrome stays ASIDE_DENSE despite carrying counts — it is ambient, and the
 *   user should be able to ignore it.
 *   A label whose value is primary goes on secondary, not tertiary or aside: an aside-toned
 *   label beside a primary value reads as a mismatched pair rather than a hierarchy.
 *   SettingRow description is CLARIFY_DENSE under LABEL (size step, same color).
 *   Downloads panel title stays text-[13px] font-medium (compact panel chrome — do not
 *   promote to TITLE_*).
 *   Table status/dep-count cells may stay text-[10px]; do not force 11px if rows grow.
 *   EmptyState defaults to the roomy scale; pass `dense` inside side panels and sub-panels
 *   so a 14px line does not land in an 11-12px surface.
 *   META_COMPACT / ASIDE_COMPACT only on surfaces whose controls already run 10-11px.
 *
 * Escape hatches: optical pairs (HubDetail title+version / author+role; PackageCard
 * title+author at text-[13px]), chips/tags/badges (THUMB_CHIP_BOX), FirstRun.jsx (own pass).
 *
 * Reference: ArchiveActionDialogs.jsx — the archive dialog covers section label, label + clarify,
 * body and aside; the install dialog covers body, emphasis, semantic and aside.
 * FirstRun.jsx ~613 (inline emphasis). Rhythm, named exceptions, and hard locks:
 * docs/Implementation.md § Rhythm.
 */

// --- Headings ---

/** Page title — one per view. 18px / 600 / primary */
export const TITLE_PAGE = 'text-lg font-semibold text-text-primary'

/** Section or card heading. 16px / 600 / primary */
export const TITLE_SECTION = 'text-base font-semibold tracking-tight text-text-primary'

/** Dialog title — matches the shadcn primitive default. 16px / 500 / primary */
export const TITLE_DIALOG = 'text-base font-medium text-text-primary'

/**
 * Heading for a group of content inside a detail side-panel — "Used by", "Content",
 * "Dependencies", "Package files". 11px / 500 / primary, normally with a count beside it
 * (see the `GroupHeading` component, which owns the count styling).
 *
 * Capitalized, not uppercase: SECTION_LABEL labels a *structure* you cannot click into — a
 * table column, a filter group — while this labels a group of content that is itself the
 * thing on screen. Keeping them distinct means one uppercase level per panel.
 */
export const TITLE_GROUP = 'text-[11px] font-medium text-text-primary'

// --- Dense labels ---

/** Row or field label on the dense scale. 12px / 500 / primary */
export const LABEL = 'text-xs font-medium text-text-primary'

/**
 * Dense identifier the user reads as data rather than chrome — download names, filenames,
 * package names in rows. 12px / 400 / primary. Distinct from LABEL: a label names a control,
 * a value *is* the content, so it stays at normal weight.
 */
export const VALUE = 'text-xs text-text-primary'

// --- Emphasis (inherits enclosing size) ---

/**
 * Inline emphasis inside body prose — bolder + brighter, no size change.
 *
 * Uses `text-emphasis` (#d0d1de), not primary. A run set in primary at font-medium reads as
 * glare at prose sizes and makes the paragraph around it feel like it is competing; the
 * softer value keeps the same ~2.4:1 step over body that emphasis had before the tertiary
 * lift. Titles and labels still use primary — they are not embedded in a line of prose.
 */
export const EMPHASIS = 'font-medium text-text-emphasis'

// --- Roomy prose (dialogs, page-level) ---

/** Roomy body. 14px / 400 / secondary */
export const BODY = 'text-sm text-text-secondary'

/**
 * Roomy clarification. 12px / 400 / secondary.
 * No baked leading — used as both paragraphs and list items; call sites choose.
 */
export const CLARIFY = 'text-xs text-text-secondary'

/** Roomy aside. 12px / 400 / aside */
export const ASIDE = 'text-xs text-text-aside'

// --- Dense prose (settings, panels, cards, tables) ---

/** Dense body. 12px / 400 / secondary */
export const BODY_DENSE = 'text-xs text-text-secondary'

/**
 * Dense clarification. 11px / 400 / secondary.
 * `leading-snug` is deliberate: Tailwind pairs no line-height with `text-[Npx]`, so without
 * it leading is inherited from ancestors and non-deterministic across surfaces.
 */
export const CLARIFY_DENSE = 'text-[11px] leading-snug text-text-secondary'

/**
 * Dense aside. 11px / 400 / aside.
 * `leading-snug` baked in for the same reason as CLARIFY_DENSE.
 */
export const ASIDE_DENSE = 'text-[11px] leading-snug text-text-aside'

/**
 * Aside on a compact surface — a detail-panel action column or a table cell, where the
 * controls themselves run 10-11px. At 11px an aside matches the button label beside it and
 * stops receding, which is the whole job of the tier.
 *
 * Not a general licence for 10px prose: only reach for this where the surrounding controls
 * are already smaller than the dense scale.
 *
 * `leading-snug` baked in for the same reason as CLARIFY_DENSE.
 */
export const ASIDE_COMPACT = 'text-[10px] leading-snug text-text-aside'

// --- Metadata (structural chrome, not prose) ---

/**
 * Short factual tokens beside content: counts, file sizes, time-ago, positions, status words,
 * filenames in a card footer. Tertiary, not aside — metadata is subordinate to the content it
 * annotates but you read it on purpose, so it stays above the skippable tier.
 *
 * The test against ASIDE: could you delete this and lose no information? Then it is an aside.
 * If it carries a fact that appears nowhere else on screen, it is metadata.
 */
export const META = 'text-xs text-text-tertiary'

/** Dense metadata. 11px / 400 / tertiary */
export const META_DENSE = 'text-[11px] text-text-tertiary'

/** Metadata on a compact surface — table cells, card footers. 10px / 400 / tertiary */
export const META_COMPACT = 'text-[10px] text-text-tertiary'

// --- Chrome (not prose; settled so recipes stay one place) ---

/** Uppercase group label and table header */
export const SECTION_LABEL = 'text-[10px] uppercase tracking-wider font-medium text-text-tertiary'

/**
 * Monospaced tokens on dense surfaces — version strings, URLs, hashes. Secondary, not
 * tertiary: despite looking like metadata these are usually the thing being compared or
 * copied. Not a `META_*` variant, which is why it does not share that prefix.
 */
export const MONO_DENSE = 'text-[11px] font-mono text-text-secondary'
