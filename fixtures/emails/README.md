# Email fixtures

Fifty fictional emails that label the whole email pipeline: triage rules, LLM triage, extraction, matching, status changes, interviews and leads. They follow TECHNICAL_SPEC §15.

Nothing here is real. Companies and people are invented and live on `.example` domains. The only real domains are the ATS and job-alert senders from TECHNICAL_SPEC §5.3 (`ashbyhq.com`, `hire.lever.co`, `greenhouse-mail.io`, `myworkday.com`, `personio.de`, `workablemail.com`, `linkedin.com`, `indeed.com`, `glassdoor.com`, `wellfound.com`), which carry no personal data.

## The owner

Every inbound fixture is addressed to one fictional owner, and every outbound fixture is sent from them:

```
OWNER_EMAIL = mateo.salgado@owner.example
```

The constant is exported as `FIXTURE_OWNER_EMAIL` from `apps/api/src/fixtures/emails.ts`. Pass it as the owner address wherever the pipeline needs one. The owner works in Monterrey (UTC−6, all year).

## File format

One JSON file per email, named `<id>.json`, validated by `EmailFixtureSchema` (`@offerbound/contracts`). Load them with `loadEmailFixtures()` from `apps/api/src/fixtures/emails.ts`; they come back sorted by `internalDate`, then `id`.

- `internalDate` is an ISO 8601 UTC string. `headers.date` is the same instant in RFC 2822 form. A fake Gmail client converts `internalDate` to whatever the API needs.
- `bodyText` and `bodyHtml` are optional. Some fixtures have only HTML, and the Arbor Analytics interview invite has only an `ics` part with no text at all.
- `ics` is the text of the `text/calendar` part, with CRLF line endings.
- `expected.interviewStart` is UTC (`...Z`). `llm.extraction` times carry the offset the email states.
- `llm.triage` is `null` whenever a triage rule decides. `llm.extraction` is `null` for emails that never reach extraction (decoys and skipped messages). Every `llm.extraction` is exactly what `ExtractionSchema` accepts and equals the outcome the fake provider should reproduce.
- Copperline Software's emails state "EST", a fixed UTC−5 offset, even though New York is on UTC−4 in October. The fixtures keep the email's literal instant (`-05:00`) and use the IANA fixed zone `EST` as `timezone`, so the hint matches the offset. The extraction does not guess a daylight-saving zone.
- `outreach-quarry-ai-research` expects `leads: 0` because it attaches to Quarry AI's open application instead of creating a lead.
- `expected.jobKey` is `jobKey()` of the extraction's `jobUrl`, and is present only when there is one.

## How `expected.triage` was decided

The tests replay the fixtures in order and ask `triageByRules` for each one, with lookups built from what the earlier fixtures taught the pipeline:

- A fixture whose outcome is `applied` links its thread (rule R2), except job alerts.
- It also adds its sender's registrable domain and the extraction's `company.websiteDomain` to the known company domains (rules R3 and R6). Recruiter outreach and outbound mail add no domains.
- No contacts and no ignore list. Backfill starts 2026-09-01 in the owner's time zone (`FIXTURE_BACKFILL_SINCE`).

If a rule decides, `llm.triage` is `null`. If the decision is `llm` (R9), `llm.triage` holds the verdict, with `confidence` 0.70 or higher when `jobRelated` is false so the message is dropped rather than sent on to extraction. Decoys marked `CATEGORY_PROMOTIONS` are the R8 cases.

## Seed applications

The pipeline never creates a second application for a company, so the two ambiguous fixtures need applications that exist before they run. `FIXTURE_SEED_APPLICATIONS` (same module) lists them: two open applications each at Driftwood Software and Fairhaven Labs, with different roles. The pipeline test seeds them the way a sheet import would, by name and without domains. That is why the ambiguous senders go through LLM triage.

## The mix

| Group                     | Count | Fixtures                                                                                                                                                                             |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application confirmations | 6     | Ashby (Quarry AI), Lever (Kestrel Pay), Greenhouse (Arbor Analytics), Workday (Northwind Robotics), Personio (Lumen Health), company domain (Tidewater Labs)                         |
| Rejections                | 6     | Kestrel Pay, Northwind Robotics, Tidewater Labs, Lumen Health (Spanish), Halyard Health (Spanish), Kittiwake Systems (confidence 0.72, expects a `low_confidence` review)            |
| Interview invites         | 6     | Quarry AI, Northwind Robotics and Arbor Analytics with ics; Kestrel Pay with a scheduling link only; Ironbark Labs recruiter screen; Copperline Software with "next Tuesday 3pm EST" |
| Reschedules               | 3     | Quarry AI (ics), Arbor Analytics, Copperline Software                                                                                                                                |
| Cancellations             | 2     | Quarry AI (ics `METHOD:CANCEL`), Ironbark Labs                                                                                                                                       |
| Assessments               | 3     | Arbor Analytics, Tidewater Labs, Saltmarsh Analytics (Workable)                                                                                                                      |
| Offers                    | 2     | Arbor Analytics, Bramble Studio                                                                                                                                                      |
| Recruiter outreach        | 4     | Wren Aerospace (direct), Bluefin Talent (agency), Pinecrest Pharma (LinkedIn messaging), Quarry AI (attaches to its open application, no lead)                                       |
| Job alerts                | 4     | LinkedIn (5 jobs), Indeed (3), Glassdoor (3), Wellfound (2 jobs at Sandpiper AI)                                                                                                     |
| Owner follow-ups          | 2     | Quarry AI (new thread, known company domain), Copperline Software (same thread)                                                                                                      |
| Ambiguous                 | 2     | Driftwood Software, Fairhaven Labs: expect `needs_review` with `ambiguous_match`                                                                                                     |
| Decoys                    | 8     | Bank, careers newsletter, course marketing, family, receipt, social notification, personal LinkedIn message, unrelated calendar invite                                               |
| Skipped                   | 2     | A spam-labelled message and one dated before the backfill start (rule R1)                                                                                                            |

Nineteen fixtures carry `demo: true`, spread across categories.

## Threads

Confirmations share a thread with the messages that follow them, so thread links are exercised:

- Quarry AI: confirmation, invite, reschedule, cancellation
- Kestrel Pay: confirmation, invite, rejection
- Arbor Analytics: confirmation, assessment, invite, reschedule, offer
- Northwind Robotics: confirmation, invite, rejection
- Lumen Health: confirmation, rejection
- Tidewater Labs: confirmation, assessment, rejection
- Ironbark Labs and Copperline Software: invite, then cancellation or reschedule and follow-up

## Adding a fixture

Keep the replay honest. After adding one, run `pnpm --filter @offerbound/api test:unit -- fixtures`: the tests recompute which rule decides each fixture, check `expected.jobKey`, validate `llm.extraction` and check the mix counts.
