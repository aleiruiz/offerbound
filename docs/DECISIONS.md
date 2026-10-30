# Offerbound — Decision Log

| | |
|---|---|
| Version | 1.0 (2026-10-29) |
| Specification approval | **Approved** by the owner, 2026-10-29 19:00 (America/Monterrey) — PRD, TECHNICAL_SPEC, DATA_MODEL, SECURITY, DECISIONS, OPEN_QUESTIONS v1.0 |
| UX/UI design approval | **Approved** by the owner, 2026-10-29 19:30 (America/Monterrey) — DESIGN_SPEC v1.0 (DS-1–DS-10), the Offerbound design system and the Offerbound Screens canvas (13 boards, sign-in as revised) |

`D-x` = product decisions made with the owner during discovery (2026-10-29). `S-x` = architecture decisions made while writing the specification. Changing a decided item after approval requires a proposal and the owner's explicit approval; if the specification changes after the design is approved, the affected design decisions are listed for re-approval.

Discovery followed the *grill-me* questioning method (the command itself was not installed): rounds of 3–5 questions with challenges and trade-offs until nothing material was open.

---

## Product decisions (discovery)

| ID | Decision | Why / alternatives considered |
|---|---|---|
| D1 | Name **Offerbound**; repo `aleiruiz/offerbound` | "Job Hunt Journal" was taken; Job/Apply/Hire + Trail/Track/Log names are crowded |
| D2 | *(superseded by D1)* repo `aleiruiz/jobhunt-journal` | Renamed with the product |
| D3 | Discovery and specification with Opus; implementation code with Sonnet | Owner's standing rule |
| D4 | Personal tool + portfolio piece, **not a SaaS**: one user, no sign-up, billing or tenancy | SaaS would require Google restricted-scope verification and an annual security assessment for no real benefit |
| D5 | Google OAuth app stays unverified, published *In production*; the owner clicks through Google's warning once | *Testing* status expires refresh tokens after 7 days; verification is only needed for public apps |
| D6 | Public repo: no secrets, no real emails; synthetic fixtures and screenshots | Repo is public |
| D7 | Hosted on the owner's own domain | Testable by others, though that is not the main goal |
| D8 | Visitors get a demo only | Visitors connecting their own Gmail would bring back the unverified-app screen, the 100-user cap and responsibility for strangers' mail |
| D9 | Owner's instance: real Gmail and OpenAI, no spending cap (cost shown in Settings) | Owner's choice |
| D10 | Hosted on the owner's Hostinger VPS | Already runs MTGRulesLawyer under Coolify |
| D11 | Being useful within days beats completeness | The owner is in an active search |
| D12 | The LinkedIn post is out of scope for now | — |
| D13 | No cost-driven rules pre-filter | At dozens of emails a day, LLM classification costs pennies |
| D14 | Deploy like MTGRulesLawyer: Coolify Compose resource, Postgres in the stack, Coolify proxy for TLS | Proven on this server |
| D15 | Demo and private instance are two resources from one repo; the demo has its own DB and no Google/OpenAI secrets | A demo that holds no credentials cannot leak the owner's data |
| D16 | 8 GB VPS hosts both stacks next to MTGRulesLawyer | ≈ 0.5 GB per stack |
| D17 | DNS at GoDaddy: `A` records `offerbound` and `alei.offerbound` | Owner task |
| D18 | Demo `offerbound.northsoftmx.com`; private `alei.offerbound.northsoftmx.com` | — |
| D19 | Stack: pnpm monorepo, Fastify, Prisma, Postgres 17, zod contracts, React + Vite, Google sign-in limited to the owner, OpenAI | Reuses MTGRulesLawyer's proven backend; web-only product |
| D20 | Leads from job alerts and recruiter outreach are in the MVP | Discovery from the inbox without scraping |
| D21 | Volume: dozens of job-related emails a day; the owner's spreadsheet is the starting point | — |
| D22 | Release 1 in 3 days; the owner reviews full time | — |
| D23 | Leads and applications are separate records; a lead becomes an application when the owner applies | The owner's own rule: leads are not applications |
| D24 | Leads are ranked against owner-defined tracks (stored privately) | Taken from the owner's existing search plan |
| D25 | Spreadsheet *Cancelled* = lead not pursued → imported as dismissed leads | Owner answer |
| D26 | Two-stage email filter: rules, then sender/subject/preview to OpenAI; full body only for job-related mail | Keeps personal mail out of OpenAI |
| D27 | Automatic updates; low-confidence or ambiguous changes go to a review queue; every change undoable | Owner wants automation; the queue prevents silent wrong changes |
| D28 | Follow-up flag after 7 days without a company reply; *Abandoned* after 14; later reply reopens | Owner answer |
| D29 | Today view with daily targets is in the MVP | Owner gave follow-up rules for it |
| D30 | **Job search runs inside Offerbound**: daily agent on OpenAI with web search, driven by an editable brief and the CV, with duplicate rules enforced against the full history | Owner request. Reverses the earlier "no discovery" stance: no scraping is involved, and only a database can enforce "never repeat a company" |
| D31 | CV upload (PDF/DOCX) → profile used by search and ranking to explain fit and gaps | Owner request |
| D32 | CV, brief, compensation thresholds and spreadsheet data live only in the private DB | Public repo |
| D33 | Owner manually reviews the specification and the design. During implementation, PRs are reviewed by subagents and merged when that review approves and CI is green | Owner instruction; it's a demo-grade product |
| D34 | Material UI is the component base for the web app, themed with Offerbound tokens (design phase) | Owner request, 2026-10-29: simpler to build. Details and the theme: DESIGN_SPEC §2 |
| P1 | Release 1 scope as in PRD §5 (Musts, Shoulds with cut order, Later list); public demo moved to Release 1.1 | 3-day limit; the demo serves the parked LinkedIn post. **Confirmed by approving the spec** |
| P2 | Duplicate detection: job link → Gmail thread → company + role; ambiguous → review, never auto-merge | **Confirmed by approving the spec** |
| P3 | Interviews extracted from emails; Offerbound never writes to the calendar | **Confirmed by approving the spec** |
| P4 | One-time CSV import of the spreadsheet; afterwards Offerbound is the source of truth and the sheet is retired | Two-way sync would cost a day. **Confirmed by approving the spec** |

## Architecture decisions (specification)

| ID | Decision | Alternatives and trade-off |
|---|---|---|
| S-1 | Reuse MTGRulesLawyer's backend conventions (pnpm 9, Node 22, Prisma 6.19, Fastify, zod contracts, OpenAI Responses API wrapper) | New stack would show breadth but cost days |
| S-2 | Background work on **pg-boss** in a separate `worker` service | Redis/BullMQ adds a service; Coolify scheduled tasks lack retries and per-message jobs |
| S-3 | One origin: Caddy serves the SPA and proxies `/api` | Separate API subdomain needs CORS and cross-site cookies |
| S-4 | CSRF via required custom header + `SameSite=Lax` | Token-based CSRF is more code for no gain with same-origin + custom header |
| S-5 | Single-tenant schema (no `user_id`) | Multi-tenant columns would serve a SaaS that is out of scope (D4) |
| S-6 | Only `gmail.readonly`; no labels written | Writing labels needs `gmail.modify` for little value |
| S-7 | Pure `packages/domain` computes **change plans**; the worker executes them | Mixing rules with DB code makes them hard to test and impossible to preview in the review queue |
| S-8 | One Postgres advisory lock for all pipeline/intake writes; optimistic `version` for owner edits | Fine-grained locking is error-prone; volume is tiny |
| S-9 | Effects applied in Gmail date order behind a watermark | Applying out of order can regress statuses (rejection before confirmation) |
| S-10 | Auto-apply at confidence ≥ 0.80 and only for transitions in a fixed table | Pure confidence lets the model regress statuses; pure table ignores uncertainty |
| S-11 | Calendar files parsed deterministically; they override LLM times | LLM time parsing is the most error-prone field |
| S-12 | Canonical `job_key` per ATS for identity, unique across leads and across applications | URL equality misses tracking parameters and ATS variants |
| S-13 | Leads with dead links are deleted, so their companies do not count as "already seen" | Keeping them would suppress a later live posting from the same company |
| S-14 | Search uses OpenAI's hosted web search tool; results need an official link that passes an SSRF-guarded link check | Scraping job boards breaks terms of service; ATS public APIs are a later improvement (OQ-7) |
| S-15 | Lead ranking is an LLM call with the brief and CV profile; estimated compensation is always labelled | Rules-only ranking can't read free-text briefs |
| S-16 | One set of synthetic fixtures drives unit tests, the evaluation harness and the demo; `FakeLlmProvider` replays them | Separate datasets drift |
| S-17 | Demo uses a shared DB with free-text writes blocked and an hourly reset | Per-visitor sandboxes add complexity; a frontend-only mock would not exercise the real pipeline |
| S-18 | Google tokens encrypted in the app (AES-256-GCM) | DB-level encryption alone exposes tokens in dumps |
| S-19 | Nightly local `pg_dump`, 14 days | Off-server copies deferred (OQ-3) |
| S-20 | Model configurable per purpose; default is MTGRulesLawyer's production model; the evaluation picks cheaper models per purpose | Hard-coding a model ties cost to code changes |
| S-21 | Recruiter outreach is exempt from "company already seen" (flagged instead) | A recruiter writing to the owner is real interest, unlike a sourced posting |
| S-22 | Follow-ups are detected from Sent mail to a known company and also loggable by hand; they do not reset the abandonment clock | D28 measures silence from the company |
| S-23 | Spreadsheet import runs before Gmail sync (sync waits for *Start syncing*) | Otherwise backfilled emails would create records the import then duplicates |
