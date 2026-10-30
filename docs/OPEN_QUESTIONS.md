# Offerbound — Open Questions

| | |
|---|---|
| Version | 1.0 (2026-10-29) |

None of these block the specification. Each has a default that lets implementation proceed; *Blocks* says which feature is at risk if the default turns out wrong.

| ID | Question | Default until answered | Owner of the answer | Blocks |
|---|---|---|---|---|
| OQ-1 | Will Google grant `gmail.readonly` to the unverified app in *In production* status (unverified-app screen, then consent)? | Yes. Verified on day 1 with a minimal build before the pipeline is built on it. If not: *Testing* status with the owner as test user and a reconnect every 7 days | Owner (runs the consent once) | F2 |
| OQ-2 | Which OpenAI model per purpose (triage, extraction, ranking, search, CV profile)? | All use MTGRulesLawyer's production model; after the first `pnpm eval:emails` run, each purpose moves to the cheapest model that meets AC-17.4 | Implementation (evaluation results) | — |
| OQ-3 | Where should off-server backup copies go (e.g. object storage)? | None in Release 1; local nightly dumps only | Owner | — |
| OQ-4 | What data-retention settings does the dedicated OpenAI project allow (e.g. zero data retention)? | Default project settings | Owner (when creating the project) | — |
| OQ-5 | When is the ChatGPT sourcing task retired? | Keep it running until the in-app search agent has produced good runs for a few days; meanwhile its reports can be pasted in (F9.4, Should) | Owner | — |
| OQ-6 | What does a search run cost? | Unknown until the first runs; limits default to 3 rounds × 40 web searches; adjust from the run list in Settings | Owner after first runs | — |
| OQ-7 | Should verification use public ATS job APIs (Greenhouse, Lever, Ashby) instead of page heuristics? | Page heuristics in Release 1 | Later | — |
| OQ-8 | Does Google require verifying `northsoftmx.com` in Search Console for the consent screen? | Only if the console asks; a GoDaddy TXT record does it | Owner | F2 setup |
