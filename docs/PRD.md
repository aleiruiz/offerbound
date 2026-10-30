# Offerbound — Product Requirements

| | |
|---|---|
| Status | **Approved** (2026-10-29) |
| Version | 1.0 (2026-10-29) |
| Companion docs | [TECHNICAL_SPEC](TECHNICAL_SPEC.md) · [DATA_MODEL](DATA_MODEL.md) · [SECURITY](SECURITY.md) · [DECISIONS](DECISIONS.md) · [OPEN_QUESTIONS](OPEN_QUESTIONS.md) |

Requirement IDs (`F-x`, `AC-x.y`) are referenced by the technical spec, the implementation plan and the tests. Decision IDs (`D-x`, `S-x`) live in [DECISIONS](DECISIONS.md).

---

## 1. Summary

Offerbound is a personal job-search command center. It reads the owner's Gmail, recognises recruitment emails, and keeps a record of every application up to date on its own: new applications, status changes, rejections, interview invitations and reschedules. It runs a daily job-search agent that follows a search brief the owner edits and the owner's CV, and it ranks the leads it finds — together with leads arriving as job alerts and recruiter outreach — against the owner's criteria. A **Today** view tells the owner what to do now: follow-ups due, interviews coming up, leads to review, and progress against daily targets.

There are two deployments of the same code:

- **Private instance** — `https://alei.offerbound.northsoftmx.com`. One user (the owner). Real Gmail, real OpenAI calls.
- **Public demo** — `https://offerbound.northsoftmx.com`. No login, synthetic data, faked LLM responses, no Google or OpenAI credentials at all.

Offerbound is a personal tool and a portfolio piece. It is **not** a SaaS: no sign-up, no billing, no multi-tenancy (D4).

## 2. Problem

An active search produces dozens of job-related emails a day across ATS systems (Ashby, Lever, Greenhouse, Workday, Personio…), job alerts and recruiter messages. The owner currently keeps a spreadsheet updated by hand and runs a separate ChatGPT task to source leads. That setup:

1. Drifts out of date — status changes are only recorded when someone copies them from an email.
2. Mixes leads and applications in one table, which makes the pipeline and daily targets hard to read.
3. Cannot reliably enforce the owner's sourcing rule — *never show a company that was already reported* — because the sourcing tool has no access to the full history.
4. Gives no signal about what to do today (who to follow up with, what interview is next).

## 3. Goals and non-goals

### Goals (Release 1)

| ID | Goal | Measured by |
|---|---|---|
| G1 | The application record stays current without manual copying | ≥ 90% of job-related emails in the first week are applied automatically or resolved from the review queue in one click; no missed status change found in a manual spot-check of 20 emails |
| G2 | Leads arrive daily, verified and never duplicated by company | Each scheduled search run yields leads whose company was never seen before; 0 duplicate-company leads reach the *New* list |
| G3 | The owner knows what to do today | Today view shows follow-ups due, interviews in the next 7 days, top leads and daily target progress on one screen |
| G4 | Nothing personal leaks | No personal data in the public repo; demo holds no credentials; non-job emails are never sent in full to OpenAI |
| G5 | Ships in 3 days | Release 1 deployed to the private instance by 2026-11-01 |

### Non-goals

- Multiple users, sign-up, billing, Google app verification (D4, D5).
- Sending email, applying to jobs, or marking anything *Applied* on the owner's behalf (owner rule: nothing is submitted without approval).
- Scraping job boards. The search agent uses OpenAI's web search tool and verifies official links (D30, S-14).
- Writing to Gmail (labels, archiving) or to Google Calendar.
- A mobile app. The web app is responsive.

## 4. Users

| User | Where | What they need |
|---|---|---|
| **Owner** | Private instance | Daily operation of the job search: triage leads, track applications, prepare interviews, keep targets |
| **Visitor** (recruiter, hiring manager) | Public demo | Understand what the product does in under two minutes without signing in |

## 5. Releases and MVP boundaries

### Release 1 — private instance (3 days, target 2026-11-01)

Must:
- F1 Sign-in, F2 Gmail sync, F3 email pipeline, F4 automatic updates with undo, F5 review queue
- F6 applications, F7 follow-up and abandonment timers, F8 interviews
- F9 leads (from emails and import), F10 search agent with editable brief, F11 CV profile, F12 lead ranking
- F13 Today view, F14 sheet import, F15 settings, F17 operations (backups, LLM cost log, evaluation harness)

Should (first to cut if day 3 runs short, in this order):
1. F9.4 paste a ChatGPT report as leads, and the *copy companies already seen* list
2. Merging applications and companies from the UI (the review queue still offers merges)
3. *Delete stored email content* button

### Release 1.1 — public demo

- F16 demo mode, deployed as a second Coolify resource at `offerbound.northsoftmx.com`.

The fake LLM provider and the synthetic fixtures it needs are built in Release 1 for tests, so Release 1.1 is mostly wiring, seeding and deployment.

### Later (explicitly out of Release 1 and 1.1)

Google Calendar sync · reminders or notifications by email or push · drafting or sending follow-up emails · a lead intake API for external tools · multi-user · analytics beyond the pipeline summary · parsing attachments other than calendar invites · salary research beyond what the search agent returns · LinkedIn messages that never reach Gmail · two-way sync with the old spreadsheet · UI languages other than English · off-server backup copies.

## 6. Key user journeys

**J1 — First run (private).** Owner opens the private URL → signs in with Google and grants read-only Gmail access → uploads CV → imports the spreadsheet CSV → pastes the search brief → presses *Start syncing*. Offerbound backfills email from 2026-09-01, attaches it to the imported records and shows progress.

**J2 — A rejection arrives.** Within 5 minutes the email is recognised, matched to its application, the status changes to *Rejected*, and a timeline entry links to the email. The owner can undo it from the timeline.

**J3 — An interview invite with a calendar file arrives.** The application moves to *Interviewing*; an interview is created with the exact time from the invite; it appears on Today under upcoming interviews.

**J4 — Morning routine.** The daily search ran at 07:00. Today shows new leads ranked by track and fit, each with a one-line reason and gaps against the CV. The owner shortlists or dismisses them, applies on the company site, presses *Mark applied* (the lead becomes an application), logs outreach and prep time, and works through follow-ups due.

**J5 — Something ambiguous.** An email mentions a company with two open applications. It lands in the review queue with both candidates; one click attaches it.

**J6 — Visitor (Release 1.1).** Opens the demo, sees a populated Today view, opens an application timeline, presses *Simulate incoming email* and watches the status and timeline change.

## 7. Functional requirements and acceptance criteria

Each acceptance criterion is written to be automated. "Owner" means the authenticated user of the private instance.

### F1 — Sign-in (private instance)

- **AC-1.1** Visiting any page without a session redirects to `/login`, which offers only *Sign in with Google*.
- **AC-1.2** Signing in with the Google account configured as `OWNER_EMAIL` (case-insensitive, `email_verified = true`) creates a session and lands on `/onboarding` if onboarding is incomplete, otherwise `/today`.
- **AC-1.3** Signing in with any other Google account shows *This Offerbound instance is private* and creates no session and no stored tokens.
- **AC-1.4** Sessions last 30 days and are renewed when fewer than 7 days remain; *Sign out* invalidates the session server-side.
- **AC-1.5** Every mutating API request without the header `X-Offerbound-Request: 1` is rejected with `403 csrf_header_missing`.

### F2 — Gmail connection and sync

- **AC-2.1** The Google consent requests exactly `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.readonly`, with offline access.
- **AC-2.2** If the owner declines the Gmail permission, the connection shows *Gmail permission missing* with a *Reconnect* button, and no sync runs.
- **AC-2.3** Sync does not start until the owner presses *Start syncing* (so the sheet import can run first). Pressing it starts a backfill of messages dated on or after `GMAIL_BACKFILL_SINCE` (default 2026-09-01), excluding spam, trash and drafts.
- **AC-2.4** After the backfill, new messages are picked up at most 5 minutes after they arrive (configurable), plus on *Sync now*.
- **AC-2.5** Settings and the Today header show: connection state, last successful sync time, backfill progress (listed / processed), and counts waiting at each pipeline stage.
- **AC-2.6** If Google revokes the token (`invalid_grant`), sync stops, the connection becomes *Needs reconnection*, a banner appears on every page, and reconnecting resumes from the last synced point with no duplicates.
- **AC-2.7** If Gmail reports that the stored history point is too old, sync re-lists messages from one day before the newest processed message; already-processed messages are skipped.
- **AC-2.8** *Disconnect Gmail* revokes the token at Google, deletes stored tokens and stops sync; existing records stay.

### F3 — Email pipeline (two-stage filter)

- **AC-3.1** Outgoing mail is never sent to OpenAI unless its thread or recipient is already linked to a known company, contact, application or lead.
- **AC-3.2** Messages from known ATS senders, job-alert senders, known company domains, known contacts or already-linked threads are treated as job-related without an LLM call (rule list in TECHNICAL_SPEC §5.3).
- **AC-3.3** Messages in Gmail's Promotions or Forums categories that match no rule are discarded without an LLM call.
- **AC-3.4** All other messages are classified by OpenAI using **only** sender name and address, subject and Gmail's preview text. The message body is fetched only for messages classified as job-related.
- **AC-3.5** For discarded messages Offerbound keeps only the Gmail message id, thread id, date and the decision; sender, subject, preview and body are not stored.
- **AC-3.6** For job-related messages, extraction returns: category, confidence, company, role, job link, contact, interview details, assessment details, leads (for alerts and outreach), and a one-line summary — validated against a strict schema. Invalid output is retried once, then goes to the review queue as *Extraction failed*.
- **AC-3.7** Calendar invitations (`text/calendar` parts) are parsed deterministically; their start/end time, location, link, UID and cancellation take precedence over LLM-extracted values.
- **AC-3.8** Emails are applied to records in the order they were received, even when extraction finishes out of order.
- **AC-3.9** Processing the same message twice never creates duplicate applications, leads, interviews or timeline entries.

### F4 — Automatic updates and undo

- **AC-4.1** A change is applied automatically when extraction confidence ≥ the *auto-apply threshold* (default 0.80), the email matches exactly one record (or legitimately creates one), and the status transition is allowed by the transition table (TECHNICAL_SPEC §6.3). Otherwise a review item is created and nothing changes.
- **AC-4.2** Every automatic change creates a timeline entry with a link to the source email and an *Undo* action.
- **AC-4.3** *Undo* restores every field the change touched and deletes any record it created, provided nothing changed those records since; otherwise it answers *Changed since — edit manually* and changes nothing.
- **AC-4.4** After an undo, the source email appears in the review queue as *Undone change* with *Reprocess* and *Ignore* actions.
- **AC-4.5** An *application received* email for a company+role with no existing record creates an application with status *Applied*; if a lead for the same job link or company+role exists, the lead is converted instead.

### F5 — Review queue

- **AC-5.1** The queue lists open items newest first with: kind, source email summary, proposed change, confidence, and candidates where relevant.
- **AC-5.2** Kinds and actions:

| Kind | Actions |
|---|---|
| Low confidence | Apply · Edit and apply · Dismiss |
| Ambiguous match | Attach to candidate · Create new · Dismiss |
| Unexpected status change | Apply (reopen) · Timeline only |
| Possible duplicate company | Merge · Same group · Keep separate |
| Extraction failed | Retry · Dismiss |
| Undone change | Reprocess · Ignore |

- **AC-5.3** Resolving an item applies its effect through the same code path as automatic changes (so it gets a timeline entry and can be undone).
- **AC-5.4** The open count appears in the navigation and on Today.

### F6 — Applications

- **AC-6.1** List with filters by status (multi-select), *follow-up due*, text search (company, role), and sort by last activity (default), applied date or status.
- **AC-6.2** Detail shows company, role, job link, location, work mode, country, compensation text, sponsorship text, notes, interviews, linked emails (subject, date, summary; full text on demand) and the timeline.
- **AC-6.3** Owner can create an application manually, edit any field, change status to any value (manual changes ignore the transition table), and edit notes.
- **AC-6.4** Statuses: Applied · Screening · Assessment · Interviewing · Offer · Accepted · Rejected · Withdrawn · Abandoned.
- **AC-6.5** *(Should)* Owner can merge two applications; emails, interviews and timeline entries move to the target and the source is deleted.

### F7 — Follow-up and abandonment timers

- **AC-7.1** For applications in Applied, Screening, Assessment or Interviewing, the *company clock* is the time of the latest email from the company, else the applied date, else the creation time.
- **AC-7.2** When the company clock is ≥ 7 days old (configurable), the application is flagged *Follow-up due* and appears on Today.
- **AC-7.3** *Mark followed up* (or sending an email to the company, detected from Sent mail) clears the flag and counts toward today's follow-up target; the flag returns 7 days after the follow-up if the company still has not replied.
- **AC-7.4** When the company clock is ≥ 14 days old (configurable), status becomes *Abandoned* automatically (timeline entry, undoable). Follow-ups sent by the owner do **not** reset this clock.
- **AC-7.5** Any later email from the company reopens an abandoned application to the status the email implies, or to the status it had before abandonment.
- **AC-7.6** Timers are evaluated at least every 15 minutes, and only once the Gmail backfill has finished and no email older than one hour is still waiting in the pipeline, so imported or backfilled applications are never abandoned before their emails are applied.

### F8 — Interviews

- **AC-8.1** Interview invitations create interviews with kind, start, end, original time zone, meeting link, location and interviewer names; invites without a time (e.g. a scheduling link) create an interview *To schedule* with the link.
- **AC-8.2** Reschedule emails update the matching interview (same calendar UID, else nearest upcoming interview of the application); cancellations mark it *Cancelled*.
- **AC-8.3** Interviews whose end time (or start + 60 min) has passed become *Completed* automatically.
- **AC-8.4** Interviews page lists upcoming (ascending) and past (descending); times display in the owner's time zone (`America/Monterrey`).
- **AC-8.5** Owner can add an interview manually and keep prep notes per interview.

### F9 — Leads

- **AC-9.1** Leads come from: the search agent (F10), job-alert emails, recruiter-outreach emails, the sheet import, pasted reports (Should) and manual entry.
- **AC-9.2** Lead statuses: New · Shortlisted · Dismissed · Applied (converted) · Suppressed.
- **AC-9.3** Intake rules for every batch of incoming leads. Rules 1, 2 and 4 apply when the lead arrives; rule 5 once the lead is ranked; rule 3 once every lead of the batch is checked and ranked. Manual entries and the sheet import skip rules 2 and 3.
  1. A lead whose canonical job link already exists on any lead or application is discarded (counted, not stored).
  2. A lead whose company — or any company in the same group — already has any lead or application is stored as *Suppressed — company already seen*. **Exception:** leads from recruiter outreach are never suppressed for this reason; they are flagged *Company already seen*.
  3. Within one batch (one search run, one alert email, one pasted report) only the best-fitting lead per company is kept; the rest are *Suppressed — same company in batch*.
  4. Leads whose seniority is in the excluded list (default: junior, staff and above, non-hands-on manager) are *Suppressed — excluded seniority*.
  5. Leads ranked ineligible (F12) are *Suppressed — ineligible*.
- **AC-9.4** *(Should)* *Import report*: owner pastes a text report (e.g. from ChatGPT); Offerbound parses it into leads, shows a preview annotated with what each intake rule would do, and creates only the rows the owner keeps checked.
- **AC-9.5** *(Should)* *Copy companies already seen* puts a plain-text list of every known company name and alias on the clipboard.
- **AC-9.6** *Mark applied* converts a lead into an application (status Applied, applied now) and links both. Offerbound never converts a lead without the owner's action or an *application received* email.
- **AC-9.7** Suppressed leads are visible in a *Suppressed* tab with the reason, and *Reconsider* moves them back to New.
- **AC-9.8** Each lead's job link is checked: reachable and not showing a *closed* marker → *Verified*; unreachable (404/410) or closed → *Dead* (discarded and counted, so the company does not count as reported; imported leads are kept as Dismissed — *Posting closed* — because they are history); hosts that require login (LinkedIn) → *Unverifiable*; other failures → *Unverified*. New leads appear in the New list only after this check.

### F10 — Search agent

- **AC-10.1** Settings has a *Job search* section with: the search brief (free text, up to 12,000 characters), tracks (key, label, priority 1–3), excluded seniorities, daily lead target (min/max, default 20–30), run time (default 07:00 owner time), and an enable switch.
- **AC-10.2** When enabled, a run happens once a day at the configured time; *Run now* starts one immediately unless one is already running.
- **AC-10.3** A run gives OpenAI (with the web search tool) the brief, the CV profile, the tracks and the full list of companies already seen (names, aliases, groups). It may take up to 3 rounds to reach the target, adding each round's companies to the exclusion list, and stops early when a round returns nothing new. It never pads results to reach the target.
- **AC-10.4** Every result passes the intake rules (F9.3) and link check (F9.8). Results without an official job link are discarded.
- **AC-10.5** Each run is recorded with: trigger, status, rounds, counts (returned, accepted, suppressed, duplicates, dead), web search calls and cost. The last 14 runs are listed in Settings with errors.
- **AC-10.6** The repo ships a generic placeholder brief; the owner's brief exists only in the private database.

### F11 — CV profile

- **AC-11.1** Owner uploads a PDF or DOCX up to 5 MB. Text is extracted; files with no extractable text are rejected with a message.
- **AC-11.2** OpenAI turns the text into a profile: headline, years of experience, core skills, secondary skills, domains, recent roles, leadership scope, languages, location and work-authorisation notes.
- **AC-11.3** The profile is shown read-only with *Replace CV*. Only the extracted text and profile are stored, not the file.
- **AC-11.4** The search agent and lead ranking use the latest profile; replacing the CV does not re-rank existing leads unless the owner presses *Re-rank new leads*.

### F12 — Lead ranking

- **AC-12.1** Every lead not produced by the search agent is ranked after intake (the agent ranks its own) using the brief, the CV profile and the tracks, plus the job page text when the link check fetched it.
- **AC-12.2** Ranking returns: track (one of the configured keys, or none), fit score 0–100, one-line fit reason, gaps against the CV, seniority, work mode, remote eligibility from the owner's home country (`HOME_COUNTRY`), sponsorship, relocation, compensation range with currency and period, whether compensation is an estimate, and eligibility (yes/no/unknown with reason).
- **AC-12.3** Estimated compensation is always labelled *Estimate* in the UI.
- **AC-12.4** The New list sorts by track priority, then fit score (descending), then found date (newest first).

### F13 — Today

- **AC-13.1** Shows, for the owner's current local day: new leads found vs lead target, applications marked applied vs target (default 8–12), outreach logged vs target (default 5), follow-ups done vs target (default 3–5), interview prep minutes vs target (default 90).
- **AC-13.2** Outreach and prep time are logged manually with one tap (+1 outreach; +15/+30/+60 minutes prep); follow-ups count automatically (AC-7.3).
- **AC-13.3** Lists: follow-ups due (oldest first), interviews in the next 7 days, top 5 new leads, review queue count with the first 3 items, Gmail sync status.
- **AC-13.4** Pipeline summary: count per application status, response rate (applications with any company reply beyond the automatic acknowledgement ÷ applications), interview rate (applications that reached Screening or later ÷ applications).

### F14 — Spreadsheet import

- **AC-14.1** Owner uploads a CSV export of the *Applications* tab. The header row is found automatically (it is the first row containing *Company*, *Role* and *Status*), so title rows above it are ignored.
- **AC-14.2** Mapping: *To research* → New lead; *Cancelled* → Dismissed lead (reason *Not pursued — imported*); *Applied* → application Applied; *Interview* → application Interviewing; *Rejected* → application Rejected. Unknown statuses are reported as errors and skipped.
- **AC-14.3** Columns map to: Company, Role, Country, City / modality → location, Date applied (YYYY-MM-DD, owner time zone), Salary → compensation text, Sponsorship / relocation → sponsorship text, Job link, Notes. Notes are kept as notes and not parsed.
- **AC-14.4** A preview shows counts per target, rows with errors, and duplicates inside the file; nothing is written until *Import*.
- **AC-14.5** Importing the same file twice is refused; rows matching existing records by canonical link, or same company and a similar role (word overlap ≥ 0.6, as email matching), are skipped and counted.
- **AC-14.6** Imported New leads go through the link check and ranking; imported Dismissed leads and applications do not. Imported records are **not** subject to the company-already-seen or one-per-company rules (they are the history).

### F15 — Settings

Sections: Gmail connection (F2) · Job search (F10) · CV (F11) · Daily targets (F13) · Timers (follow-up days, abandon days) · Automation (auto-apply threshold 0.50–0.99, sender ignore list) · Import (F14, F9.4) · AI usage · Data.

- **AC-15.1** *AI usage* shows month-to-date cost and calls by purpose (triage, extraction, ranking, search, report parsing, CV) and a 30-day daily total.
- **AC-15.2** *(Should)* *Delete stored email content* removes all stored email bodies, previews and subjects; records and timelines stay.
- **AC-15.3** Settings are validated; invalid values are rejected with field-level messages.

### F16 — Public demo (Release 1.1)

- **AC-16.1** With `APP_MODE=demo`, the server refuses to start if any Google, OpenAI, token-encryption or owner variable is set.
- **AC-16.2** No sign-in. Every page works with seeded synthetic data using fictional companies only; dates are shifted so the data always looks current.
- **AC-16.3** A banner says *Demo — synthetic data, resets every hour*. Data resets hourly.
- **AC-16.4** *Simulate incoming email* feeds the next synthetic email through the real pipeline with the fake LLM provider, so the visitor sees the status, interview or lead change and the timeline entry.
- **AC-16.5** *Run search now* returns synthetic leads through the real intake rules.
- **AC-16.6** Free-text inputs (notes, brief, CV upload, imports, manual records) are disabled with a tooltip; status changes, shortlist/dismiss, undo and review actions work.
- **AC-16.7** Mutating requests are limited to 30 per minute per IP.

### F17 — Operations

- **AC-17.1** `/health` answers 200 when the process is up; `/ready` answers 200 only when the database and job queue are reachable.
- **AC-17.2** Every OpenAI call is logged with purpose, model, tokens, web search calls, latency, status and computed cost.
- **AC-17.3** Nightly database backup on the private instance at 03:30 owner time, 14 days retained, restore procedure documented.
- **AC-17.4** `pnpm eval:emails` runs the email pipeline against labelled synthetic fixtures with the real OpenAI provider and prints per-category precision/recall and field accuracy. Release 1 ships when: job-related recall ≥ 98%, category accuracy ≥ 90%, company match ≥ 90%, interview start time exact ≥ 95% for calendar invites and ≥ 85% for plain-text invites.
- **AC-17.5** CI runs lint, type checks, unit and integration tests, build and a secret scan on every pull request; merging requires green CI and an approving review from a review subagent (D33).

## 8. Assumptions

- A1 Dozens of job-related emails per day; total mailbox volume is low enough that the 5-minute incremental sync is cheap (D13, D21).
- A2 The Google OAuth client stays unverified and "In production"; the owner clicks through Google's unverified-app screen once (D5). Verified on day 1 — see OQ-1.
- A3 OpenAI cost on the private instance is not capped (D9) but is visible (AC-15.1).
- A4 The owner reviews spec and design; implementation PRs are reviewed by subagents (D33).

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Three days is tight for this scope | Late or partial Release 1 | Milestones ordered so the email pipeline lands first; *Should* items cut in the order in §5; demo already moved to 1.1 |
| Google blocks the unverified restricted-scope consent | No Gmail sync | Test consent on day 1 before building on it; fallback is *Testing* status with weekly reconnection (OQ-1) |
| Wrong automatic change | Bad data, lost trust | Confidence threshold, transition table, review queue, undo on every change, evaluation bar (AC-17.4) |
| Search agent returns stale or invented postings | Wasted time | Official-link requirement, link check, *never pad* instruction, run metrics |
| Personal data in the public repo | Privacy breach | Generic seeds, `private/` folder git-ignored, secret scan in CI, SECURITY §6 |
