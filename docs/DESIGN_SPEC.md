# Offerbound — UX/UI Design Specification

| | |
|---|---|
| Status | **Approved** by the owner, 2026-10-29 19:30 (America/Monterrey) |
| Version | 1.0 (2026-10-29) |
| Builds on | [PRD](PRD.md) and [TECHNICAL_SPEC](TECHNICAL_SPEC.md) v1.0 (approved 2026-10-29) |
| Design artifacts (private to the owner) | Design system *Offerbound*: `https://claude.ai/artifact/XCV9KCEakacJz8Am2M3kFx` · Screens canvas *Offerbound Screens*: `https://claude.ai/artifact/GTiG1LqQY9sNiVC3LnFKio` |

This document is the contract for the web app's look and behaviour. The canvas shows the screens; this file says how they are built and why. Where the canvas and this file disagree, this file wins.

---

## 1. Direction

- **Material UI is the base** (DS-1, owner request). Every control is an MUI component. The product's identity comes from one theme — colors, Overpass type, sentence-case buttons, outlined surfaces — not from custom components.
- **One custom element: the route line.** "Offerbound" means bound for an offer, so the pipeline is drawn as a line with stops (Applied → Screening → Assessment → Interviewing → Offer) and an application's history is a vertical line of stops. It is used only where the content really is a sequence (DS-3).
- **Calm, dense, operational.** The owner uses this every morning to decide what to do. Summary before detail, state visible at a glance (chips, flags), no decoration that doesn't carry information.
- **Light and dark.** Both modes from the same tokens; the system setting decides, Settings can override.

## 2. Implementing the design system

### 2.1 Packages (apps/web)

`@mui/material` and `@mui/icons-material` (current stable major at implementation time), `@emotion/react`, `@emotion/styled`, `@fontsource/overpass` (weights 400, 600, 700, 800). Fonts are self-hosted so the CSP in SECURITY §10 (`default-src 'self'`) holds; Emotion's injected styles are covered by the existing `style-src 'self' 'unsafe-inline'`. No other UI library.

### 2.2 Theme

One file, `apps/web/src/theme.ts`, exporting `createOfferboundTheme(mode)`. Values come from the design system's `tokens.json`; the table is the source for the implementation.

| Token | Light | Dark | MUI key / use |
|---|---|---|---|
| `bg` | `#f4f6f3` | `#0e151c` | `palette.background.default` |
| `surface` | `#ffffff` | `#151e27` | `palette.background.paper` |
| `surface-sunken` | `#ecf0ec` | `#1b2631` | table headers, focused list row |
| `ink` | `#16202e` | `#e7ece9` | `palette.text.primary` |
| `ink-muted` | `#4d5866` | `#a7b1ad` | `palette.text.secondary` |
| `line` | `#dce1dc` | `#26313b` | `palette.divider`, Paper borders |
| `line-control` | `#7a8580` | `#6e7b85` | input and outlined-control borders |
| `route` | `#0a7356` | `#4fd1a5` | `palette.primary.main`, focus ring |
| `on-route` | `#ffffff` | `#05281d` | `palette.primary.contrastText` |
| `route-tint` | `#e2f1eb` | `#12352b` | selected nav item, selected filter chip |
| `signal` / `signal-tint` | `#8f5400` / `#fcefd8` | `#f2b24c` / `#3a2a0e` | `palette.warning`, follow-up due, estimates, reconnect |
| `stop` / `stop-tint` | `#b3261e` / `#fbe8e6` | `#ff8a80` / `#3d1a18` | `palette.error` |

Status pairs (`palette.status.<name>` = `{ main, tint }`):

| Status | Light main / tint | Dark main / tint |
|---|---|---|
| Applied | `#2f55a4` / `#e7edf9` | `#9db8f5` / `#1c2a47` |
| Screening | `#6a46a8` / `#f0eaf8` | `#c7aef5` / `#2c2147` |
| Assessment | `#00687a` / `#dff1f4` | `#6fd3e3` / `#0f3036` |
| Interviewing | `route` / `route-tint` | same |
| Offer | `#755600` / `#faf1d3` | `#ebcb5c` / `#362c0a` |
| Accepted | `#0b5e2e` / `#dcf1e3` | `#7ddb9e` / `#133322` |
| Rejected | `#9b2c22` / `#fbe8e6` | `#f5a097` / `#3d1a18` |
| Withdrawn, Abandoned | `#545e6a` / `#eceff2` | `#b4bcc5` / `#232d37` |

Every text pair passes WCAG AA (≥ 5.0:1 in both modes; computed values are in the design system's usage notes). Control borders and the focus ring are ≥ 3.5:1.

Typography (`typography`): `fontFamily: "Overpass", "Segoe UI", system-ui, sans-serif`; `h3` → display 32/36 800 (counts only); `h4` → title 24/32 700 (one per page); `h6` → heading 18/24 700; `body1` 15/22 400; `subtitle2` and `button` → label 14/20 600, `textTransform: none`; `caption` 13/18 400. Global `font-variant-numeric: tabular-nums` on tables, meters and counts. The `overline` variant is not used (no uppercase labels).

Shape and spacing: `shape.borderRadius: 6`; chips and inputs 4; dialogs and phone sheets 12. `spacing: 8`.

Component defaults (`theme.components`):

| Component | Defaults |
|---|---|
| `MuiButton` | `disableElevation`; one `contained` per view for its main action; `outlined` secondary; `text` tertiary and row actions |
| `MuiPaper` | in-page sections `variant="outlined"`; only Menu, Popover, Dialog, Snackbar float (shadow `0 8px 24px` at 16% ink, 55% black in dark) |
| `MuiChip` | `size="small"`, radius 4, weight 600; status chips use the soft status pair |
| `MuiTextField`, `MuiSelect` | `size="small"`, `variant="outlined"`, border `line-control` |
| `MuiTable` | header row `surface-sunken` with `ink-muted` label text; row height ≥ 52px for lists people scan |
| `MuiTabs` | indicator `route`, sentence-case labels, count badges as plain small text |
| `MuiTooltip` | `arrow`; explains disabled controls and shows absolute dates for relative times |
| `MuiCssBaseline` | `:focus-visible { outline: 2px solid route; outline-offset: 2px }` on all interactive elements |

### 2.3 Icons

`@mui/icons-material` Outlined variants only: Today `TodayOutlined`, Applications `WorkOutline`, Leads `TravelExploreOutlined`, Interviews `EventOutlined`, Review `RuleOutlined`, Settings `SettingsOutlined`; actions `SyncOutlined`, `UndoOutlined`, `OpenInNewOutlined`, `MailOutline`, `BookmarkBorderOutlined`, `CloseOutlined`, `VideocamOutlined`. 20px in nav and buttons, 18px in chips. No emoji. Icon-only buttons have `aria-label` and a matching tooltip. The canvas uses hand-drawn stand-ins for these icons.

## 3. Information architecture

| Destination | Route | Nav badge | Purpose |
|---|---|---|---|
| Today | `/today` (home) | — | What to do now (F13) |
| Applications | `/applications`, `/applications/:id` | open count | Pipeline records and timelines (F6) |
| Leads | `/leads?tab=new\|shortlisted\|applied\|dismissed\|suppressed` | new count | Review and act on leads (F9–F12) |
| Interviews | `/interviews?tab=upcoming\|past` | upcoming count | Agenda and prep (F8) |
| Review | `/review?tab=open\|resolved` | open count (amber badge) | Decisions the automation needs (F5) |
| Settings | `/settings/:section` | — | Gmail, Job search, CV, Daily targets, Timers, Automation, Import, AI usage, Data (F15) |
| Sign in | `/login` | — | Private instance only (F1) |
| Onboarding | `/onboarding` | — | First run: CV → import → brief → start syncing |

The nav footer always shows Gmail sync status with *Sync now* (AC-2.5). Analytics in Release 1 is the pipeline summary on Today (AC-13.4); there is no separate analytics page (PRD §5, Later).

## 4. Layout and responsive behaviour

| Width (MUI breakpoint) | Shell |
|---|---|
| ≥ 900px (`md`+) | Permanent left drawer 240px; content max width 1200px with 32px side padding |
| 600–899px (`sm`) | Collapsed 72px rail (icons + tooltips); content full width, 24px padding |
| < 600px (`xs`) | Top app bar with page title and *Sync now*; bottom navigation with Today, Applications, Leads, Review (badge), More (Interviews, Settings); 16px padding; controls `size="medium"` for 44px targets |

- Two-column screens (Today, Application detail) are a 2:1 flex row that stacks to one column below `md`; the narrower column moves below.
- Tables keep their columns and scroll horizontally inside their Paper; the page body never scrolls sideways.
- Filter chip rows and toolbars wrap.
- Dialogs become full-screen below `sm`.

## 5. Screens

Artboard names refer to the canvas. "AC" references are to the PRD.

### 5.1 Today — artboard *Today*, phone *Today on a phone (dark)*

Header: title, date, *Run search now* (outlined). Then, in order:
1. **Pipeline** (route line, §6.2): counts per stage, closed branch (Rejected, Withdrawn, Abandoned), response rate and interview rate in one caption line (AC-13.4). Each stop links to Applications filtered by that status.
2. **Today's targets**: five meters — Applications, New leads, Outreach, Follow-ups, Interview prep — value, target range, `LinearProgress`. Manual logging buttons on Outreach (+1 message) and Prep (+15, +30, +60) (AC-13.1, 13.2).
3. Left column: **Follow-ups due** (oldest first, *Mark followed up* + *Open*), **Needs your review** (first 3 items, link to queue), **Top new leads** (5, same row anatomy as Leads). Right column: **Next 7 days** interviews, with *To schedule* items on a `signal-tint` band (AC-13.3).

### 5.2 Applications — artboard *Applications*

Search field, sort select, *Follow-up due only* switch, status filter chips (multi-select, counts, colored dot plus word), table: Company and role, Status (chip plus *Follow-up due* chip), Last reply from company (relative, absolute below), Next interview, Applied. *Add application* opens a dialog (company, role, job link, status, applied date, notes). *Show more* paginates by cursor (AC-6.1, 6.3).

### 5.3 Application detail — artboard *Application detail*

Breadcrumb, company as title, role, chips (status, work mode, track). Status `Select` (manual changes allowed for any status, AC-6.3), *Open posting*, overflow menu (Merge into…, Withdraw). Main column: **Next interview** (time in Monterrey time plus the invite's original zone, interviewers, call link, prep notes) and **Timeline** (§6.3) with *Undo* and *View email* per entry (AC-4.2, 4.3). Side column: **Details** (`dl`: job posting, location, compensation with *Estimate* chip, contact, applied, last reply, source) and **Notes** (autosaved, AC-6.2). *View email* opens a side sheet with the stored plain-text body.

### 5.4 Leads — artboard *Leads*

Main action *Run search now* (contained). Caption with the last run's result. Tabs: New, Shortlisted, Applied, Dismissed, Suppressed (counts). Track filter chips; sort *Track, then fit* (default) or *Newest first* (AC-12.4). Lead row anatomy (§6.4). Keyboard focus is shown as a `surface-sunken` row with a 2px `route` outline; the shortcut hint sits under the list (§9.3). Suppressed tab rows show the reason chip and *Reconsider* (AC-9.7).

### 5.5 Review — artboard *Review queue*

Open and Resolved tabs. One outlined Paper per item: kind chip (*Which application?*, *Not sure*, *Unexpected change*, *Same company?*, *Couldn't read*, *Undone change*), the question as the heading, the email summary on `surface-sunken` with *Show the email*, then the kind's body — radio candidates, a status change shown as *old chip → new chip*, a confidence meter in `signal` with the threshold in words — and the actions from AC-5.2. Nothing changes until an action is chosen.

### 5.6 Interviews — artboard *Interviews*

Upcoming and Past tabs. *To schedule* first, on a `signal-tint` band, with *Pick a time*. Then day groups (`surface-sunken` day headers) with time, kind, company and role, interviewers, call link, *Prep notes* (opens the prep notes field in a side sheet) and *Open application*. Chips for *Tomorrow* and *Rescheduled*. *Add interview* dialog (AC-8.4, 8.5).

### 5.7 Settings — artboards *Settings: Gmail*, *Settings: job search and CV*

Section list on the left (stacks above on phones). Mocked sections:
- **Gmail**: connection chip, account, last check, *Sync now*, *Disconnect Gmail* (`stop` text button with a confirmation dialog), first-sync progress, five pipeline counts in plain words (the *Waiting for your review* count links to Review), and *What Offerbound reads* in plain language (AC-2.5, 2.8; SECURITY §3).
- **Job search**: daily switch, run time, lead target range, search brief (`TextField multiline`, character count of 12,000), tracks table (key, name, priority), excluded levels as filter chips, *Run search now*, *Save changes*; **CV** profile summary with skills chips and *Replace CV*; **Recent runs** table (AC-10.1, 10.5, 11.3).

Not mocked, built with the same patterns: **Daily targets** (pairs of number fields per target), **Timers** (follow-up days, abandon days with the rule in a caption), **Automation** (auto-apply threshold `Slider` 0.50–0.99 with the value in words, ignored senders as a chip input), **Import** (the onboarding import step reused, plus the paste-a-report importer when built), **AI usage** (month-to-date cost, a table by purpose, a 30-day bar chart drawn as a simple SVG with token colors), **Data** (*Delete stored email content* with a typed confirmation).

### 5.8 Onboarding — artboard *Onboarding*

Four-step `Stepper` (this content is a sequence, so numbers are right): Upload your CV, Import your spreadsheet, Write your search brief, Start syncing Gmail. Only the last step is required. The import step shows the file, a mapping preview table (status in your sheet → what it becomes → rows), skipped rows in a warning Alert, and *Import N rows* (contained) (AC-14.1–14.5, S-23). The last step explains what will be read and has *Start syncing* (contained), then shows the first-sync progress state.

### 5.9 Sign in — artboard *Sign in*

The one expressive screen (DS-10). Left, about three fifths of the width: a full-height `ink` panel. Across its top runs a band of identity colors (Applied blue, Screening purple, route green, signal amber), crossed by the route line with a stop per stage and a large Offer terminus. Below the band sits the logo at display size and one line of copy. The logo is the owner-approved concept B ("destino"), the lockup in its dark variant, not a text wordmark: `apps/web/src/assets/brand/lockup-dark.svg`, rendered by `apps/web/src/components/Logo.tsx` at `clamp(220px, 40vw, 560px)` wide (the other forms and files are listed in `docs/design/README.md`, Iconography). Overpass 900 stays in use for the *Offer* stop label on the route line. On load, a marker rides the line once from Applied to Offer (§8). Right: the quiet part — instance address, "Welcome back", one full-width contained *Sign in with Google* button (text only, no Google logo artwork), a box explaining the read-only scope and the expected unverified-app warning, and a link to the public demo. Below 640px the panel stacks on top, and only the Applied and Offer labels stay. The wrong-account error is on the States board (AC-1.1, 1.3).

### 5.10 Public demo (Release 1.1)

Same screens with a dark top banner: *Demo with made-up data. Everything resets every hour.* plus *Simulate an incoming email*. Free-text controls are disabled with a tooltip saying why (AC-16.6). The simulated email animates the route line (§8).

## 6. Components

### 6.1 Status chip

MUI `Chip size="small"`, ground `status-<name>-tint`, text `status-<name>`, label = status word. Abandoned adds a 1px dashed `status-closed` border so it differs from Withdrawn in shape too. Flags use the same chip shape: *Follow-up due*, *To schedule*, *Estimate*, *Company seen before* (`signal` pair); *Verified posting* (`route` pair); *Unverified posting*, *LinkedIn only, not checked* (neutral pair).

### 6.2 Route line: pipeline

Built on MUI `Stepper` (`alternativeLabel`, custom `StepConnector` 4px `line`, custom `StepIcon`). Stop = 24px disc in the stage's status color with a 4px ring of the surface; a stage with 0 items is a hollow disc. Under each stop: count in `display`, stage name in the status color (`label` weight). Every stop is a link to Applications filtered by that stage. The closed branch sits below the first stop: an L-shaped connector, the word *Closed*, then Rejected, Withdrawn and Abandoned chips with counts. Horizontal scroll below 640px of available width; on phones the stops shrink to 16px with 20px counts.

### 6.3 Route line: application timeline

An ordered list (`<ol>`) with a 3px `line` rail drawn by each item's pseudo-element (no MUI Lab dependency). Newest first. Stop shapes encode the source, never color alone:

| Stop | Meaning |
|---|---|
| Filled disc in the new status's color | Automatic change (undoable) |
| Ring (3px `ink-muted` border) | Email received or sent |
| Filled square | The owner's own action |
| Ring square | Lead found / imported |

Each entry: date and time (caption), a sentence starting with what happened in bold, the reason or source (caption), then *Undo* and *View email* text buttons. An entry that can no longer be undone says so in a caption instead of showing a disabled button.

### 6.4 Lead row

Fit score (24/28 800) with "fit" beneath; company (600) and title (muted) on one line; chips: track, work mode, verification, compensation (stated amount in neutral, estimate as a separate *Estimate* `signal` chip); one-sentence reason; caption with gaps and source. Actions on the right: *Shortlist* (outlined), *Mark applied* (text), dismiss (icon), open posting (icon) or view recruiter email (icon). Rows are separated by dividers inside one Paper, not separate cards.

### 6.5 Other patterns

- **Target meter**: label, value in `display` with the range in caption, 6px `LinearProgress`, optional quick-log buttons or a caption.
- **Follow-up row**: company, role and the reason in plain words ("Applied Oct 20, no reply for 9 days"), *Mark followed up* + *Open*.
- **Interview row**: time column (18/24 700), kind, company and role, interviewers, call link, actions.
- **Sync status**: dot plus text in the nav footer (`aria-live="polite"`); a warning Alert below the top bar when Gmail needs reconnecting.
- **Snackbar**: dark (`ink` ground) with one text action, usually *Undo*; 6 seconds; announced politely.

## 7. States

| Where | Empty | Loading | Error |
|---|---|---|---|
| Today | Each section has its own empty line ("No follow-ups due. Applications without a reply for 7 days show up here.") | Skeletons shaped like each section | Inline error Alert in the failing section with *Try again*; other sections still render |
| Applications | "No applications yet" with *Import spreadsheet* and *Start syncing Gmail* | 5 skeleton rows | Inline error Alert replacing the table |
| Leads | New: "No new leads. The next search runs at 07:00." with *Run search now* | Skeleton rows; a running search shows the progress card | Inline error Alert; a failed run shows its error in Recent runs |
| Review | "Nothing to review. Changes Offerbound is sure about are applied on their own." | Skeletons | Inline error Alert |
| Interviews | "No interviews coming up." | Skeletons | Inline error Alert |
| Application detail | Timeline always has at least the creation entry | Skeleton header and timeline | Full-page error with *Back to applications* when not found (404) |
| Global | — | First sync progress card on Today and Settings, Gmail | Reconnect banner on every page; wrong-account error on Sign in |

Copy rules for states: say what happened and what to do; never apologise; empty states name the next action.

## 8. Motion

MUI's default transitions (≤ 225ms) for menus, dialogs, tabs and snackbars. One custom moment: when a status changes while the owner is looking (live sync or the demo's *Simulate an incoming email*), the application's marker slides along the pipeline line to its new stop (400ms ease-out) and the new timeline entry fades in. With `prefers-reduced-motion: reduce`, both jump without animation. No entrance animations on page load, with one exception: on Sign in, the marker rides the route line from Applied to the Offer terminus once (2.6s, starting after 0.4s). With reduced motion, it starts at Offer.

## 9. Accessibility

Target: WCAG 2.2 AA.

### 9.1 Visual

- Contrast as in §2.2 for both modes. Status is always shown as a word (chips) or label (route stops), never by color alone; Abandoned and Withdrawn also differ in border style.
- Focus: 2px `route` outline with 2px offset on every interactive element, including table row links and chips.
- Text resizes to 200% without loss; layouts reflow down to 320px wide.

### 9.2 Semantics

- Landmarks: `nav` (main navigation and settings sections), `main`, `aside` for the side column.
- One `h1` per page (the page title); sections use `h2`.
- Tables are real `<table>` elements with `scope="col"` headers. Tabs use MUI `Tabs` (`role="tablist"`). Filter chips are toggle buttons with `aria-pressed`. Meters use `role="progressbar"` with values. The review confidence uses `role="meter"`.
- Sync status, search progress and snackbars are in `aria-live="polite"` regions; error banners use `role="alert"`.
- `lang="en"` on the document; dates are written out ("Fri, Oct 30") and use a 24-hour clock in the owner's time zone.

### 9.3 Keyboard

| Where | Keys |
|---|---|
| Any list (applications, leads, review, interviews) | `j` / `k` or ↓ / ↑ move focus, `Enter` opens |
| Leads | `s` shortlist, `d` dismiss, `a` mark applied, `o` open posting |
| Timeline | `u` undo the focused entry |
| Anywhere | `g` then `t`/`a`/`l`/`i`/`r` go to Today, Applications, Leads, Interviews, Review; `?` opens the shortcut dialog |

Shortcuts never fire while typing in a field, and each one has a visible button doing the same thing.

### 9.4 Touch

Below 600px every target is at least 44 × 44px; row actions that don't fit move into a `⋯` menu.

## 10. Copy

- Sentence case everywhere; no uppercase labels; no exclamation marks; no emoji.
- The fixed vocabulary is in the design system README (Shortlist, Dismiss, Reconsider, Mark applied, Mark followed up, Undo, Sync now, Reconnect Gmail, Run search now, Replace CV). The result repeats the verb: *Mark applied* → "Marked as applied".
- Automatic changes are statements with their source ("Moved to Interviewing … From an email with a calendar invite. Confidence 96%."). Uncertain ones are questions ("Is this a rejection from Quarry AI?").
- Numbers: counts as digits; compensation as `US$9.5–11k / month`, `€95–110k / year`; times `10:00–11:00`; dates `Oct 27`, `Fri, Oct 30`; relative times ("2 days ago") with the absolute date in a tooltip or caption.
- Internal names never appear in the UI: no *triage*, *extraction*, *job key*, *pipeline state*, *intake batch*.

## 11. Traceability

| Screen | Acceptance criteria |
|---|---|
| Sign in | AC-1.1, 1.3 |
| Onboarding | AC-2.3, 11.1–11.3, 14.1–14.5 |
| Today | AC-2.5, 5.4, 7.2, 13.1–13.4 |
| Applications | AC-6.1, 6.3, 6.4, 7.2 |
| Application detail | AC-4.2–4.4, 6.2, 6.3, 6.5, 8.1, 8.5 |
| Leads | AC-9.2, 9.6–9.8, 10.2, 12.2–12.4 |
| Review | AC-5.1–5.3 |
| Interviews | AC-8.1–8.5 |
| Settings | AC-2.5, 2.8, 10.1, 10.5, 11.3, 11.4, 15.1–15.3 |
| States board | AC-2.6, 3.6, 4.3, 9.7, 1.3, 16.3 |
| Demo banner | AC-16.3, 16.4, 16.6 |

## 12. Design decisions

| ID | Decision | Why / trade-off |
|---|---|---|
| DS-1 | Material UI as the component base, themed with Offerbound tokens | Owner request for simplicity; implementation becomes configuration. The cost is a recognisable MUI feel, offset by the theme and the route line |
| DS-2 | Overpass as the only typeface, self-hosted | A signage face fits "bound for an offer"; one family keeps it simple; self-hosting keeps the CSP strict |
| DS-3 | The route line is the only custom component, used only for true sequences | Spends the identity in one place; avoids decorating non-sequential content |
| DS-4 | Outlined surfaces, no in-page shadows | Dense daily tool; shadows reserved for things that float |
| DS-5 | Soft status chips with words; Abandoned dashed | Accessible without relying on color; eight statuses stay legible |
| DS-6 | `signal` (amber) means "needs you": follow-ups, estimates, review counts, reconnect | One attention color; error red stays for failures only, never for the Rejected status |
| DS-7 | Keyboard-first lists with visible buttons for every shortcut | The owner reviews 20–30 leads a day |
| DS-8 | Bottom navigation with five destinations on phones; rail on tablets | MUI-standard responsive navigation |
| DS-9 | Fictional companies and people in all mockups and demo data | Keeps the canvas and demo shareable; no real company is shown with invented outcomes |
| DS-10 | Sign in is the one expressive screen: the cover's color band and route line at full scale, display-size logo (the approved concept B lockup), one animated moment | Owner feedback (2026-10-29): the first version was too plain. It's the first thing a visitor to the instance sees and has no working content to compete with |

## 13. Changes to the approved specification

None of substance. TECHNICAL_SPEC §2 left the web app's visual system to this phase; this document adds the MUI, Emotion and Fontsource packages to `apps/web` and nothing else. No API, data model or security change is needed (the CSP already allows Emotion's inline styles, and fonts are self-hosted).
