import {
  decideTransition,
  localMidnightUtc,
  normalizeCompanyName,
  targetStatusFor,
} from "@offerbound/domain";
import type { ApplicationStatus } from "@offerbound/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "../../test/app.js";
import { seedStartedConnection } from "../../test/gmail.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { drainPipeline } from "../../test/pipeline.js";
import { testWorkerCtx } from "../../test/worker.js";
import {
  FIXTURE_BACKFILL_SINCE,
  FIXTURE_OWNER_EMAIL,
  FIXTURE_SEED_APPLICATIONS,
  loadEmailFixtures,
} from "../fixtures/emails.js";
import { loadLeadBatches } from "../fixtures/leads.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { runIncrementalSync } from "../gmail/sync.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import type { LinkFetcher } from "../leads/ssrf.js";
import { fixtureJobTitles, fixtureLinkFetcher } from "../demo/runtime.js";

/**
 * The day-2 exit check (TECHNICAL_SPEC §15, pipeline integration): every fixture email goes from
 * `discovered` to its expected outcome through the real stages, with the fake Gmail client and the
 * fixture-backed fake model. Only the link fetcher is stubbed, to a verified page.
 */

const prisma = testPrisma();
const fixtures = loadEmailFixtures();

/** Every job link in an alert is a live posting that names its job. */
const verifiedPage: LinkFetcher = fixtureLinkFetcher(fixtureJobTitles(fixtures));

/**
 * The mailbox's backfill listing leaves out spam and anything before the backfill start, so the
 * two `skipped` fixtures are not in it. They arrive afterwards through the incremental sync
 * (which does not filter), so that the skip rule R1 itself decides them.
 */
const lateArrivals = fixtures.filter((f) => f.expected.outcome === "skipped");
const client = new FakeGmailClient(fixtures.filter((f) => !lateArrivals.includes(f)));

/**
 * The fixtures that reach model triage when the whole mailbox is backfilled: every message the
 * rules leave to the model (R9), and the messages rules R2 and R6 would have decided had the
 * pipeline learned thread links and company domains first. A backfill triages the backlog before
 * applying any of it, so it learns nothing in time. A test asserts this list exactly, so a change
 * in rule routing (an R4/R5 sender, or outgoing mail, reaching the model) fails it.
 */
const REACHES_MODEL_TRIAGE = [
  "ambiguous-driftwood-software",
  "ambiguous-fairhaven-labs",
  "assessment-arbor-analytics-takehome",
  "assessment-tidewater-labs-exercise",
  "cancel-ics-quarry-ai",
  "cancel-text-ironbark-labs",
  "confirm-company-tidewater-labs",
  "decoy-bank-fernhill",
  "decoy-calendar-dinner",
  "decoy-family-delgado",
  "decoy-linkedin-personal-message",
  "decoy-receipt-corner-bean",
  "decoy-social-pinboard",
  "invite-ics-arbor-analytics-design",
  "invite-ics-northwind-robotics-manager",
  "invite-ics-quarry-ai-technical",
  "invite-link-kestrel-pay",
  "invite-relative-copperline-software",
  "invite-screen-ironbark-labs",
  "offer-arbor-analytics",
  "offer-bramble-studio",
  "outreach-agency-bluefin-talent",
  "outreach-direct-wren-aerospace",
  "outreach-linkedin-message-pinecrest-pharma",
  "outreach-quarry-ai-research",
  "reject-es-halyard-health",
  "reject-lowconf-kittiwake-systems",
  "reject-tidewater-labs",
  "reschedule-ics-quarry-ai",
  "reschedule-text-arbor-analytics",
  "reschedule-text-copperline-software",
];

/**
 * The fixture-backed model, plus a verdict for the messages that reach it with none. The fixtures
 * label triage as the replay in the README does: one message at a time, each applied before the
 * next is triaged, so a thread's later messages are decided by rule R2 (and company domains by
 * R6) and carry `llm.triage: null`. In a backfill 14 of them reach the model (the members of
 * {@link REACHES_MODEL_TRIAGE} that have no verdict), and the model says what the fixture expects:
 * job-related. Nothing else is registered, so any other message that reaches the model gets the
 * fixture's own verdict, or the fake's default.
 *
 * What this leaves unproven here: that rules R2 and R6 decide those 14 messages. The rule tests
 * cover that. The routing of every other message is asserted by the list above.
 */
function fakeModel(): FakeLlmProvider {
  const llm = FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: loadLeadBatches() });
  for (const f of fixtures) {
    if (
      f.llm.triage === null &&
      f.expected.triage === "job_related" &&
      REACHES_MODEL_TRIAGE.includes(f.id)
    ) {
      llm.register("triage", { messageId: f.id }, { id: f.id, jobRelated: true, confidence: 0.95 });
    }
  }
  return llm;
}

const model = fakeModel();

function buildCtx() {
  return testWorkerCtx({
    env: testEnv({ OWNER_EMAIL: FIXTURE_OWNER_EMAIL }),
    gmail: fakeGmailFactory(client),
    llm: model,
    fetchLink: verifiedPage,
  });
}

/** Seeds the applications the ambiguous fixtures need, the way a sheet import would (name only). */
async function seedApplications(): Promise<void> {
  const when = new Date("2026-09-15T12:00:00.000Z");
  for (const seed of FIXTURE_SEED_APPLICATIONS) {
    const normalizedName = normalizeCompanyName(seed.company);
    const company =
      (await prisma.company.findUnique({ where: { normalizedName } })) ??
      (await prisma.company.create({
        data: { name: seed.company, normalizedName, createdSource: "sheet_import" },
      }));
    const appliedAt = localMidnightUtc(seed.appliedOn, "America/Monterrey");
    await prisma.application.create({
      data: {
        companyId: company.id,
        title: seed.role,
        status: seed.status,
        statusChangedAt: appliedAt,
        appliedAt,
        lastCompanyActivityAt: appliedAt,
        source: "sheet_import",
        createdAt: when,
      },
    });
  }
}

/** Row counts of every table, plus the state of every message and lead. */
async function snapshot(): Promise<Record<string, unknown>> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '_prisma_migrations'
    order by tablename`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `select count(*) as n from "public"."${tablename}"`,
    );
    counts[tablename] = Number(rows[0]?.n ?? 0);
  }
  const messages = await prisma.gmailMessage.findMany({
    orderBy: { id: "asc" },
    select: { id: true, state: true, applicationId: true },
  });
  const leads = await prisma.lead.findMany({
    orderBy: { id: "asc" },
    select: { id: true, status: true, pipelineState: true, verification: true, version: true },
  });
  const applications = await prisma.application.findMany({
    orderBy: { id: "asc" },
    select: { id: true, status: true, version: true },
  });
  return { counts, messages, leads, applications };
}

/**
 * The start time each message gave its interview: the `startsAt` it wrote, read from the change
 * set of its interview event (the interview row itself holds only the latest one).
 */
async function interviewStarts(): Promise<Map<string, string | null>> {
  const events = await prisma.event.findMany({
    where: { type: { in: ["interview_created", "interview_updated"] }, messageId: { not: null } },
    select: { messageId: true, changeSet: true },
  });
  const starts = new Map<string, string | null>();
  for (const event of events) {
    const changes = (event.changeSet ?? []) as {
      entity: string;
      after: { startsAt?: string | null } | null;
    }[];
    const interview = changes.find((c) => c.entity === "interview");
    if (event.messageId !== null && interview?.after && "startsAt" in interview.after) {
      starts.set(event.messageId, interview.after.startsAt ?? null);
    }
  }
  return starts;
}

/**
 * The status each company's application ends in, worked out from the fixtures alone: its applied
 * messages in time order, each moving the status the way `targetStatusFor` and `decideTransition`
 * (TECHNICAL_SPEC §6.3) say. A transition that needs review leaves the status where it was.
 * Only partly independent of the pipeline, which uses the same two functions; the interview,
 * outcome and category checks do not share code with it.
 */
function expectedFinalStatus(): Map<string, ApplicationStatus> {
  const status = new Map<string, ApplicationStatus>();
  for (const f of fixtures) {
    const company = f.expected.company;
    if (f.expected.outcome !== "applied" || company === null || f.expected.category === null) {
      continue;
    }
    const extraction = f.llm.extraction;
    const target = targetStatusFor(f.expected.category, extraction?.interview?.kind ?? null);
    const current = status.get(company);
    if (current === undefined) {
      // The first applied message of a company creates its application (§6.4).
      if (f.expected.leads === undefined && f.expected.category !== "recruiter_outreach") {
        status.set(company, target ?? "applied");
      }
      continue;
    }
    if (target !== null && decideTransition(current, target) === "apply") {
      status.set(company, target);
    }
  }
  return status;
}

describe("whole-pipeline fixtures", () => {
  const ctx = buildCtx();

  beforeAll(async () => {
    await resetDb(prisma);
    await seedStartedConnection(prisma, {
      email: FIXTURE_OWNER_EMAIL,
      backfillSince: FIXTURE_BACKFILL_SINCE,
    });
    await seedApplications();
    await drainPipeline(ctx);
    for (const f of lateArrivals) client.add(f);
    await runIncrementalSync(ctx);
    await drainPipeline(ctx);
  });

  it("only the expected fixtures reach model triage", () => {
    const sent = model.calls
      .filter((call) => call.purpose === "triage")
      .flatMap((call) => (call.input as { id: string }[]).map((item) => item.id));
    // Each message is sent to the model once, so rule-decided mail (R4/R5 senders, outgoing mail,
    // promotions) is in neither list.
    expect([...sent].sort()).toEqual([...REACHES_MODEL_TRIAGE].sort());
    // The replay-labelled fixtures that reach it with no verdict: the accommodation's whole scope.
    const unlabelled = REACHES_MODEL_TRIAGE.filter(
      (id) => fixtures.find((f) => f.id === id)?.llm.triage === null,
    );
    expect(unlabelled).toHaveLength(14);
  });

  it("every fixture reaches its expected outcome", async () => {
    const messages = await prisma.gmailMessage.findMany({
      include: { application: { include: { company: true } }, reviewItems: true },
    });
    const stored = new Map(messages.map((m) => [m.id, m]));
    expect(stored.size).toBe(fixtures.length);

    const startedBy = await interviewStarts();
    const finalStatus = expectedFinalStatus();
    const problems: string[] = [];
    const check = (id: string, what: string, expected: unknown, actual: unknown): void => {
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        problems.push(
          `${id}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    };

    for (const f of fixtures) {
      const message = stored.get(f.id);
      if (message === undefined) {
        problems.push(`${f.id}: no message row`);
        continue;
      }
      check(f.id, "outcome", f.expected.outcome, message.state);
      if (f.expected.outcome === "applied") {
        check(f.id, "category", f.expected.category, message.category);
        const company = message.application?.company.name ?? null;
        if (f.expected.company !== null && message.applicationId !== null) {
          check(f.id, "company", f.expected.company, company);
        }
        if (message.application !== null && f.expected.company !== null) {
          check(
            f.id,
            "application status",
            finalStatus.get(f.expected.company) ?? null,
            message.application.status,
          );
        }
      }
      if (
        f.expected.outcome === "applied" &&
        (f.expected.category === "interview_invite" ||
          f.expected.category === "interview_reschedule")
      ) {
        check(
          f.id,
          "interview start",
          f.expected.interviewStart ?? null,
          startedBy.get(f.id) ?? null,
        );
      }
      if (f.expected.reviewKind !== undefined) {
        check(
          f.id,
          "review kind",
          [f.expected.reviewKind],
          message.reviewItems.map((r) => r.kind),
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("job alerts and recruiter outreach become leads", async () => {
    const problems: string[] = [];
    const withLeads = fixtures.filter((x) => x.expected.leads !== undefined);
    expect(withLeads.length).toBe(8);
    for (const f of withLeads) {
      const leads = await prisma.lead.findMany({
        where: { sourceMessageId: f.id },
        include: { company: true },
      });
      if (leads.length !== f.expected.leads) {
        problems.push(`${f.id}: expected ${f.expected.leads} leads, got ${leads.length}`);
      }
    }
    expect(problems).toEqual([]);

    // The lead jobs ran to the end: every lead is checked, ranked and ready, every batch finalized.
    const leads = await prisma.lead.findMany();
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.filter((l) => l.pipelineState !== "ready")).toEqual([]);
    expect(leads.filter((l) => l.rankedAt === null && l.status === "new")).toEqual([]);
    expect(await prisma.intakeBatch.count({ where: { finalizedAt: null } })).toBe(0);
    // Link checks were stubbed to a live page; LinkedIn pages are never fetched (they need a login).
    const verified = leads.filter((l) => l.verification === "verified");
    expect(verified.length).toBeGreaterThan(0);
  });

  it("draining a second time changes nothing", async () => {
    const before = await snapshot();
    await drainPipeline(ctx);
    expect(await snapshot()).toEqual(before);
  });

  it("no triaged-out fixture has stored content", async () => {
    const ids = fixtures
      .filter((f) => f.expected.outcome === "triaged_out" || f.expected.outcome === "skipped")
      .map((f) => f.id);
    const rows = await prisma.gmailMessage.findMany({ where: { id: { in: ids } } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row, row.id).toMatchObject({
        fromEmail: null,
        fromName: null,
        subject: null,
        snippet: null,
        bodyText: null,
        summary: null,
        extraction: null,
        icsEvents: null,
        category: null,
        toEmails: [],
      });
    }
  });
});

describe("outgoing mail in a backfill", () => {
  const confirmation = fixtures.find((f) => f.id === "confirm-ashby-quarry-ai");
  const followUp = fixtures.find((f) => f.id === "followup-out-quarry-ai");

  async function backfill(emails: typeof fixtures) {
    await resetDb(prisma);
    await seedStartedConnection(prisma, {
      email: FIXTURE_OWNER_EMAIL,
      backfillSince: FIXTURE_BACKFILL_SINCE,
    });
    const own = testWorkerCtx({
      env: testEnv({ OWNER_EMAIL: FIXTURE_OWNER_EMAIL }),
      gmail: fakeGmailFactory(new FakeGmailClient(emails)),
      llm: FakeLlmProvider.fromFixtures({ emails, leadBatches: [] }),
      fetchLink: verifiedPage,
    });
    await drainPipeline(own);
    return own;
  }

  it("a follow-up to a company created by an older confirmation in the same backfill is applied", async () => {
    if (!confirmation || !followUp) throw new Error("fixtures missing");
    await backfill([confirmation, followUp]);
    const stored = await prisma.gmailMessage.findUniqueOrThrow({ where: { id: followUp.id } });
    expect(stored).toMatchObject({
      state: "applied",
      category: "candidate_outbound",
      triageRule: "R3",
      triageMethod: "rule",
      attempts: 0,
    });
    expect(stored.applicationId).not.toBeNull();
  });

  it("a follow-up to an unknown company is still dropped once everything older is applied", async () => {
    if (!followUp) throw new Error("fixtures missing");
    await backfill([followUp]);
    const stored = await prisma.gmailMessage.findUniqueOrThrow({ where: { id: followUp.id } });
    expect(stored).toMatchObject({ state: "triaged_out", triageRule: "R3", bodyText: null });
    expect(stored.toEmails).toEqual([]);
    expect(stored.subject).toBeNull();
  });
});
