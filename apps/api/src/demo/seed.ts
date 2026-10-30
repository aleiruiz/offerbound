import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import {
  ActorSchema,
  ApplicationSourceSchema,
  ApplicationStatusSchema,
  CvProfileSchema,
  DEFAULT_SETTINGS,
  EventTypeSchema,
  InterviewKindSchema,
  InterviewStatusSchema,
  LeadStatusSchema,
  SenioritySchema,
  TrackSchema,
  TriStateSchema,
  VerificationSchema,
  WorkModeSchema,
  type EmailFixture,
} from "@offerbound/contracts";
import { jobKey, normalizeCompanyName } from "@offerbound/domain";
import { DateTime } from "luxon";
import { z } from "zod";
import { loadEmailFixtures } from "../fixtures/emails.js";
import { repoRoot } from "../fixtures/root.js";
import { stripQuotedHistory } from "../gmail/dequote.js";
import { toGmailMessage } from "../gmail/fake-client.js";
import { parseFullMessage } from "../gmail/mime.js";

/**
 * `fixtures/demo/seed.json`: the demo's starting data (TECHNICAL_SPEC §12). Fictional companies
 * and people only. Every timestamp in it is written for the moment `anchor` and moves with the
 * reset (`resetDemo`), so the data always looks current. Rows refer to each other by `key`;
 * ids are made when the seed is stored. Email content (sender, subject, body, extraction) is
 * read from the `demo: true` email fixtures named in `messages`, so the corpus stays the single
 * source of fixture text (S-16).
 */

const iso = z.iso.datetime({ offset: true });
const text = z.string();
const key = z.string().min(1);

const CompanySeed = z.strictObject({
  key,
  name: text,
  aliases: z.array(text).default([]),
  domains: z.array(text).default([]),
  websiteDomain: text.nullable().default(null),
});

const ContactSeed = z.strictObject({
  company: key,
  name: text,
  email: text,
  title: text.nullable().default(null),
});

const ApplicationSeed = z.strictObject({
  key,
  company: key,
  title: text,
  jobUrl: text.nullable().default(null),
  status: ApplicationStatusSchema,
  source: ApplicationSourceSchema,
  appliedAt: iso.nullable(),
  statusChangedAt: iso,
  lastCompanyActivityAt: iso.nullable().default(null),
  lastOutboundAt: iso.nullable().default(null),
  followUpDue: z.boolean().default(false),
  followUpDueSince: iso.nullable().default(null),
  workMode: WorkModeSchema.default("unknown"),
  locationText: text.nullable().default(null),
  country: text.nullable().default(null),
  compensationText: text.nullable().default(null),
  notes: text.nullable().default(null),
});

const InterviewSeed = z.strictObject({
  application: key,
  kind: InterviewKindSchema,
  status: InterviewStatusSchema,
  startsAt: iso.nullable().default(null),
  endsAt: iso.nullable().default(null),
  timezoneHint: text.nullable().default(null),
  meetingUrl: text.nullable().default(null),
  schedulingUrl: text.nullable().default(null),
  interviewers: z.array(text).default([]),
  icsUid: text.nullable().default(null),
});

const MessageSeed = z.strictObject({
  /** The `demo: true` email fixture this message is made from. */
  fixture: key,
  application: key,
  /** When it arrived (the fixture's own date is not used). */
  at: iso,
});

const EventSeed = z.strictObject({
  application: key.optional(),
  lead: key.optional(),
  type: EventTypeSchema,
  actor: ActorSchema,
  at: iso,
  summary: text,
  /** A message from `messages`, by fixture id. */
  message: key.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const LeadSeed = z.strictObject({
  key,
  company: key,
  title: text,
  jobUrl: text,
  locationText: text.nullable().default(null),
  country: text.nullable().default(null),
  workMode: WorkModeSchema,
  remoteFromHomeCountry: TriStateSchema.default("unknown"),
  sponsorship: TriStateSchema.default("unknown"),
  relocation: TriStateSchema.default("unknown"),
  compensationText: text.nullable().default(null),
  seniority: SenioritySchema,
  track: text.nullable(),
  fitScore: z.number().int().min(0).max(100),
  fitReason: text,
  gaps: z.array(text).default([]),
  status: LeadStatusSchema,
  dismissedReason: text.nullable().default(null),
  verification: VerificationSchema.default("verified"),
  pageExcerpt: text.nullable().default(null),
  postedAt: iso.nullable().default(null),
  foundAt: iso,
});

export const SeedSchema = z.strictObject({
  /** The moment the timestamps below describe; `resetDemo` moves them by `now − anchor`. */
  anchor: iso,
  onboardingCompletedAt: iso,
  settings: z.strictObject({
    brief: text,
    tracks: z.array(TrackSchema).optional(),
    leadTarget: z.strictObject({ min: z.number().int(), max: z.number().int() }).optional(),
  }),
  profile: CvProfileSchema,
  /** The emails *Simulate an incoming email* walks through, in order (fixture ids). */
  mailbox: z.strictObject({ order: z.array(key).min(1) }),
  companies: z.array(CompanySeed),
  contacts: z.array(ContactSeed).default([]),
  applications: z.array(ApplicationSeed),
  interviews: z.array(InterviewSeed).default([]),
  messages: z.array(MessageSeed).default([]),
  threadLinks: z.array(z.strictObject({ thread: key, application: key })).default([]),
  events: z.array(EventSeed),
  searchRun: z.strictObject({ startedAt: iso, finishedAt: iso }),
  leads: z.array(LeadSeed),
});
export type Seed = z.infer<typeof SeedSchema>;

/** Reads and validates the seed. A relative path is resolved from the repository root. */
export function loadSeed(path = "fixtures/demo/seed.json"): Seed {
  const absolute = isAbsolute(path) ? path : resolve(repoRoot(), path);
  const parsed = SeedSchema.safeParse(JSON.parse(readFileSync(absolute, "utf8")));
  if (!parsed.success) throw new Error(`Invalid demo seed: ${parsed.error.message}`);
  assertConsistent(parsed.data);
  return parsed.data;
}

/** Cross-references that the schema cannot check; a typo fails here instead of at the insert. */
function assertConsistent(seed: Seed): void {
  const companies = new Set(seed.companies.map((c) => c.key));
  const applications = new Set(seed.applications.map((a) => a.key));
  const leads = new Set(seed.leads.map((l) => l.key));
  const fixtures = new Set(seed.messages.map((m) => m.fixture));
  const fail = (what: string): never => {
    throw new Error(`Invalid demo seed: ${what}`);
  };
  for (const c of seed.contacts)
    if (!companies.has(c.company)) fail(`contact company ${c.company}`);
  for (const a of seed.applications) if (!companies.has(a.company)) fail(`application ${a.key}`);
  for (const l of seed.leads) if (!companies.has(l.company)) fail(`lead ${l.key}`);
  for (const i of seed.interviews) if (!applications.has(i.application)) fail("interview");
  for (const m of seed.messages) if (!applications.has(m.application)) fail(`message ${m.fixture}`);
  for (const t of seed.threadLinks) if (!applications.has(t.application)) fail("thread link");
  for (const e of seed.events) {
    if ((e.application === undefined) === (e.lead === undefined)) fail("event needs one subject");
    if (e.application !== undefined && !applications.has(e.application)) fail("event application");
    if (e.lead !== undefined && !leads.has(e.lead)) fail("event lead");
    if (e.message !== undefined && !fixtures.has(e.message)) fail(`event message ${e.message}`);
  }
  // History is in the past of the anchor (an interview may lie ahead of it).
  const anchor = Date.parse(seed.anchor);
  const stamps = [
    ...seed.events.map((e) => e.at),
    ...seed.messages.map((m) => m.at),
    ...seed.leads.map((l) => l.foundAt),
    ...seed.applications.flatMap((a) => [a.appliedAt, a.statusChangedAt]),
  ];
  for (const stamp of stamps) {
    if (stamp !== null && Date.parse(stamp) > anchor) fail(`${stamp} is after the anchor`);
  }
}

/** Splits `"Name <a@b.example>"`-style output of the header parser into what the columns hold. */
function messageColumns(fixture: EmailFixture) {
  const parsed = parseFullMessage(toGmailMessage(fixture));
  const body = stripQuotedHistory(parsed.textBody);
  return {
    fromEmail: parsed.headers.fromEmail,
    fromName: parsed.headers.fromName,
    toEmails: parsed.headers.to,
    subject: parsed.headers.subject,
    snippet: fixture.snippet,
    bodyText: body,
  };
}

/**
 * An interview time moved with the seed: the date follows the shift, the time of day stays what
 * the seed says in the owner's time zone ("10:00" does not become "01:37"). An interview that
 * lay ahead of the anchor stays ahead of the moved clock (the first such time at or after the
 * plain shift); one in its past stays behind.
 */
export function shiftWallClock(
  authored: string,
  anchor: string,
  deltaMs: number,
  tz: string,
): Date {
  const original = DateTime.fromISO(authored, { zone: tz });
  const moved = DateTime.fromMillis(original.toMillis() + deltaMs, { zone: tz });
  let snapped = moved.set({
    hour: original.hour,
    minute: original.minute,
    second: original.second,
    millisecond: original.millisecond,
  });
  const ahead = Date.parse(authored) >= Date.parse(anchor);
  if (ahead && snapped < moved) snapped = snapped.plus({ days: 1 });
  if (!ahead && snapped > moved) snapped = snapped.minus({ days: 1 });
  return snapped.toJSDate();
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Stores the seed, every timestamp moved by `deltaMs` (interview times keep their time of day in
 * `timezone`, see `shiftWallClock`). Expects empty application tables (see
 * `resetDemo`). Runs inside the caller's transaction.
 */
export async function storeSeed(
  tx: Prisma.TransactionClient,
  seed: Seed,
  deltaMs: number,
  timezone: string,
  fixtures: readonly EmailFixture[] = loadEmailFixtures(),
): Promise<void> {
  const at = (value: string): Date => new Date(Date.parse(value) + deltaMs);
  const atOrNull = (value: string | null): Date | null => (value === null ? null : at(value));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const ids = {
    company: new Map<string, string>(),
    application: new Map<string, string>(),
    lead: new Map<string, string>(),
  };
  const idOf = (kind: keyof typeof ids, k: string): string => {
    const id = ids[kind].get(k);
    if (id === undefined) throw new Error(`Invalid demo seed: unknown ${kind} ${k}`);
    return id;
  };
  for (const c of seed.companies) ids.company.set(c.key, randomUUID());
  for (const a of seed.applications) ids.application.set(a.key, randomUUID());
  for (const l of seed.leads) ids.lead.set(l.key, randomUUID());

  // The settings: the defaults with the demo's search brief, and onboarding already done.
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.search.brief = seed.settings.brief;
  if (seed.settings.tracks) settings.search.tracks = seed.settings.tracks;
  if (seed.settings.leadTarget) settings.search.leadTarget = seed.settings.leadTarget;
  await tx.setting.createMany({
    data: [
      ...(["search", "dailyTargets", "timers", "automation"] as const).map((k) => ({
        key: k,
        value: settings[k],
      })),
      {
        key: "onboarding",
        value: { completedAt: at(seed.onboardingCompletedAt).toISOString() },
      },
    ],
  });

  await tx.company.createMany({
    data: seed.companies.map((c) => ({
      id: idOf("company", c.key),
      name: c.name,
      normalizedName: normalizeCompanyName(c.name),
      aliases: c.aliases,
      domains: c.domains,
      websiteDomain: c.websiteDomain,
      createdSource: "demo_seed",
    })),
  });
  await tx.contact.createMany({
    data: seed.contacts.map((c) => ({
      companyId: idOf("company", c.company),
      name: c.name,
      email: c.email,
      title: c.title,
    })),
  });

  const run = await tx.searchRun.create({
    data: {
      trigger: "manual",
      status: "succeeded",
      startedAt: at(seed.searchRun.startedAt),
      finishedAt: at(seed.searchRun.finishedAt),
      rounds: 1,
      returned: seed.leads.length,
      accepted: seed.leads.length,
      webSearchCalls: 0,
      costMicros: 0,
      briefHash: sha256(seed.settings.brief),
    },
  });
  const batch = await tx.intakeBatch.create({
    data: {
      kind: "search_run",
      searchRunId: run.id,
      counts: {
        received: seed.leads.length,
        duplicates: 0,
        suppressed: 0,
        dead: 0,
        accepted: seed.leads.length,
      },
      createdAt: at(seed.searchRun.startedAt),
      finalizedAt: at(seed.searchRun.finishedAt),
    },
  });

  await tx.application.createMany({
    data: seed.applications.map((a) => ({
      id: idOf("application", a.key),
      companyId: idOf("company", a.company),
      title: a.title,
      jobUrl: a.jobUrl,
      jobKey: a.jobUrl === null ? null : jobKey(a.jobUrl),
      locationText: a.locationText,
      country: a.country,
      workMode: a.workMode,
      compensationText: a.compensationText,
      status: a.status,
      statusChangedAt: at(a.statusChangedAt),
      appliedAt: atOrNull(a.appliedAt),
      lastCompanyActivityAt: atOrNull(a.lastCompanyActivityAt),
      lastOutboundAt: atOrNull(a.lastOutboundAt),
      followUpDue: a.followUpDue,
      followUpDueSince: atOrNull(a.followUpDueSince),
      source: a.source,
      notes: a.notes,
      createdAt: at(a.appliedAt ?? a.statusChangedAt),
    })),
  });

  await tx.lead.createMany({
    data: seed.leads.map((l) => ({
      id: idOf("lead", l.key),
      companyId: idOf("company", l.company),
      intakeBatchId: batch.id,
      title: l.title,
      jobUrl: l.jobUrl,
      jobKey: jobKey(l.jobUrl),
      locationText: l.locationText,
      country: l.country,
      workMode: l.workMode,
      remoteFromHomeCountry: l.remoteFromHomeCountry,
      sponsorship: l.sponsorship,
      relocation: l.relocation,
      compensationText: l.compensationText,
      seniority: l.seniority,
      track: l.track,
      fitScore: l.fitScore,
      fitReason: l.fitReason,
      gaps: l.gaps,
      eligible: "yes" as const,
      status: l.status,
      statusChangedAt: at(l.foundAt),
      pipelineState: "ready" as const,
      dismissedReason: l.dismissedReason,
      verification: l.verification,
      verifiedAt: at(l.foundAt),
      pageExcerpt: l.pageExcerpt,
      rankedAt: at(l.foundAt),
      source: "search_agent" as const,
      postedAt: atOrNull(l.postedAt),
      foundAt: at(l.foundAt),
      createdAt: at(l.foundAt),
    })),
  });

  await tx.interview.createMany({
    data: seed.interviews.map((i) => {
      const startsAt =
        i.startsAt === null ? null : shiftWallClock(i.startsAt, seed.anchor, deltaMs, timezone);
      const length =
        i.startsAt !== null && i.endsAt !== null
          ? Date.parse(i.endsAt) - Date.parse(i.startsAt)
          : null;
      return {
        applicationId: idOf("application", i.application),
        kind: i.kind,
        status: i.status,
        startsAt,
        endsAt:
          startsAt !== null && length !== null
            ? new Date(startsAt.getTime() + length)
            : atOrNull(i.endsAt),
        timezoneHint: i.timezoneHint,
        meetingUrl: i.meetingUrl,
        schedulingUrl: i.schedulingUrl,
        interviewers: i.interviewers,
        icsUid: i.icsUid,
      };
    }),
  });

  await tx.gmailMessage.createMany({
    data: seed.messages.map((m) => {
      const fixture = fixtureById.get(m.fixture);
      const extraction = fixture?.llm.extraction;
      if (!fixture || !extraction) {
        throw new Error(
          `Invalid demo seed: ${m.fixture} is not an email fixture with an extraction`,
        );
      }
      return {
        id: m.fixture,
        threadId: fixture.threadId,
        internalDate: at(m.at),
        direction: fixture.labels.includes("SENT") ? ("outbound" as const) : ("inbound" as const),
        labelIds: fixture.labels,
        state: "applied" as const,
        triageMethod: "rule" as const,
        triageRule: "R4",
        category: extraction.category,
        extractConfidence: extraction.confidence,
        // The seeded emails name no dates, so their extraction needs no shift.
        extraction: extraction,
        summary: extraction.summary,
        applicationId: idOf("application", m.application),
        discoveredAt: at(m.at),
        processedAt: at(m.at),
        ...messageColumns(fixture),
      };
    }),
  });

  await tx.threadLink.createMany({
    data: seed.threadLinks.map((t) => ({
      threadId: t.thread,
      applicationId: idOf("application", t.application),
    })),
  });

  const eventData = seed.events.map((e) => ({
    applicationId: e.application === undefined ? null : idOf("application", e.application),
    leadId: e.lead === undefined ? null : idOf("lead", e.lead),
    type: e.type,
    actor: e.actor,
    occurredAt: at(e.at),
    createdAt: at(e.at),
    messageId: e.message ?? null,
    summary: e.summary,
    data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
    // Seeded history is not undoable: undo restores a record from the change set it was written
    // with, and the seed has none. Events from *Simulate an incoming email* are undoable.
    undoable: false,
  }));
  await tx.event.createMany({ data: eventData });

  await tx.candidateProfile.create({
    data: {
      fileName: "demo-cv.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
      textContent: "Synthetic profile for the demo.",
      profile: seed.profile,
      profileStatus: "ok",
      model: "fake",
      isActive: true,
    },
  });
}
