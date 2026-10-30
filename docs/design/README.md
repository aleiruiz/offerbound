Offerbound is a personal job-search tracker: it reads the owner's Gmail, keeps every application current, and ranks new leads every morning. It is built on **Material UI** (`@mui/material`). This system is the Offerbound theme for MUI plus the rules for the one custom element, the route line. If a screen needs a control, use the MUI component; restyle it only through the theme described here.

## Building with Material UI

Create one theme with `createTheme` and wrap the app in `ThemeProvider` + `CssBaseline`. Build both modes from these tokens (`palette.mode` follows the system setting, overridable in Settings).

| MUI theme key | Token |
|---|---|
| `palette.primary.main` / `.contrastText` | `route` / `on-route` |
| `palette.warning.main` | `signal` (Alert ground `signal-tint`) |
| `palette.error.main` | `stop` (Alert ground `stop-tint`) |
| `palette.background.default` / `.paper` | `bg` / `surface` |
| `palette.text.primary` / `.secondary` | `ink` / `ink-muted` |
| `palette.divider` | `line` |
| `palette.status.<name>` (custom key) | `{ main: status-<name>, tint: status-<name>-tint }` |
| `shape.borderRadius` | 6 (`radius-md`) |
| `spacing` | 8 (`space-1` … `space-4` are `spacing(1)` … `spacing(4)`) |
| `typography.fontFamily` | `sans` (Overpass, self-hosted with `@fontsource/overpass` 400/600/700/800) |

Component defaults to set in `theme.components`:

- `MuiButton`: `disableElevation`, `textTransform: none`, `label` style. One `contained` button per view for the main action; `outlined` for secondary; `text` for tertiary and row actions.
- `MuiPaper`: in-page sections use `variant="outlined"` with `elevation={0}`. Only menus, popovers, dialogs and snackbars float, with `shadow-overlay`.
- `MuiChip`: `size="small"`, radius `radius-sm`. Status chips are soft: ground `status-<name>-tint`, text `status-<name>`, always with the status word.
- `MuiTextField`, `MuiSelect`: `size="small"`, `variant="outlined"`, border `line-control`.
- `MuiTableCell`: `font-variant-numeric: tabular-nums`; header row on `surface-sunken`, `ink-muted` text in `label` style.
- `MuiTabs`: indicator in `route`; tab labels sentence case.
- `MuiTooltip`: `arrow`, used for absolute dates on relative times and for explaining disabled controls.
- Focus: `:focus-visible` outline 2px `focus` with 2px offset on every interactive element (MUI's ripple is not a focus indicator).

## Content fundamentals

- Write from the owner's side: *applications*, *leads*, *follow-ups*, *interviews*, *review*. Never *triage*, *pipeline state*, *extraction* or *job key* in the UI.
- Sentence case everywhere: titles, buttons, tabs, chips. No uppercase labels, no exclamation marks, no emoji.
- Buttons say what happens, and the result repeats the verb: **Mark applied** → toast "Marked as applied"; **Undo** → "Undone"; **Dismiss** → "Dismissed"; **Start syncing** → "Syncing your Gmail".
- Fixed vocabulary: Shortlist, Dismiss, Reconsider, Mark applied, Mark followed up, Undo, Sync now, Reconnect Gmail, Run search now, Replace CV.
- Automatic changes are stated as facts with their source: "Status changed to Rejected from an email on Oct 21." Low-confidence ones are questions: "Is this the Senior Frontend Engineer application?"
- Errors say what happened and what to do: "Gmail needs reconnecting. Offerbound stopped reading new email on Oct 29, 14:02. Reconnect Gmail." No apologies.
- Empty states invite the next step: "No follow-ups due. Applications without a reply for 7 days show up here."
- Estimates are always labelled: a chip reading *Estimate* next to any compensation the posting does not state.

## Visual foundations

- **Ground and surfaces.** Pages sit on `bg`; sections are outlined `surface` Paper with `line` borders. Do not nest Paper inside Paper; use a divider or `surface-sunken` instead.
- **Color is information.** `route` marks progress and the main action; `signal` marks something that needs the owner (follow-up due, reconnect, estimate); `stop` marks failure. The eight statuses use their own `status-*` pairs and nothing else does. Status is never shown by color alone: chips carry the word, and route stops carry the label and count.
- **The route line** is Offerbound's one custom element, built on MUI `Stepper` with a custom connector. It appears in two places, where the content really is a sequence:
  - *Pipeline* (Today, Applications): horizontal stops Applied → Screening → Assessment → Interviewing → Offer, each with its count in `display`; reached stops filled with their `status-*` color, the connector a 4px `line`; terminals Rejected, Withdrawn and Abandoned hang below as a branch.
  - *Application timeline* (application detail): a vertical line with one stop per event, newest first; automatic changes have a filled stop, emails an outlined stop, owner edits a square stop.
- **Type.** One family, Overpass, in the seven styles of the type scale. Use `display` only for counts; one `title` per page; `heading` for sections. Numbers in tables, meters and counts use tabular figures.
- **Spacing.** 8px grid: `space-2` inside Paper, `space-3` between sections and as the desktop page gutter, `space-2` gutter on phones.
- **Radii.** `radius-sm` chips and inputs, `radius-md` buttons and Paper, `radius-lg` dialogs and phone sheets. Nothing else is rounded.
- **Layout.** Permanent nav drawer 240px at ≥ 900px (MUI `md`); collapsed 72px rail from 600 to 899px; bottom navigation with five destinations below 600px. Content max width 1200px.
- **Motion.** MUI's default transitions (≤ 225ms). One custom moment: when an email changes a status, the application's dot moves along the route line to its new stop (400ms, ease-out). Under `prefers-reduced-motion` it jumps.
- **States.** Loading uses MUI `Skeleton` shaped like the content; errors use `Alert severity="error"` inline where the data would be; reconnect and sync problems use a page-wide `Alert severity="warning"` under the top bar.

## Iconography

- Material Symbols through `@mui/icons-material`, **Outlined** variants only, 20px in nav and buttons, 18px inside chips.
- Navigation: Today `TodayOutlined`, Applications `WorkOutline`, Leads `TravelExploreOutlined`, Interviews `EventOutlined`, Review `RuleOutlined`, Settings `SettingsOutlined`. Actions: `SyncOutlined`, `UndoOutlined`, `OpenInNewOutlined` (job posting), `MailOutline` (source email), `BookmarkBorderOutlined` (shortlist), `CloseOutlined` (dismiss).
- No emoji. Icon-only buttons carry an `aria-label` and a tooltip with the same words.
- No logo exists yet: set the name "Offerbound" in Overpass 800 wherever a mark would go.

## Accessibility

- Every text pair in this system meets 4.5:1 in both themes (the usage notes give the ratios); control borders and the focus ring meet 3:1.
- Keyboard: every list supports ↑/↓ or `j`/`k` to move, `Enter` to open. On Leads: `s` shortlist, `d` dismiss, `a` mark applied. On a timeline: `u` undo the focused change. `?` opens the shortcut list. Shortcuts never fire inside text fields.
- Sync status and toasts are announced through an `aria-live="polite"` region.
- Touch targets are at least 44px on phones (MUI `size="medium"` controls below 600px).
