import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type EmailFixture, type Ranking } from "@offerbound/contracts";
import { planChanges, type IncomingLead, type PlanSnapshot } from "@offerbound/domain";
import { resetDb, testPrisma } from "../../test/db.js";
import { testWorkerCtx } from "../../test/worker.js";
import type { WorkerCtx } from "../deps.js";
import { loadEmailFixtures } from "../fixtures/emails.js";
import { HANDLERS, type JobInfo } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import type { RecordingQueue } from "../../test/queue.js";
import { LlmError, type LlmUsage } from "../llm/provider.js";
import { runLeadCheck } from "./check.js";
import { runFinalize } from "./finalize.js";
import { enqueueLeadChecks, ingestLeads, type IngestResult } from "./intake.js";
import type { LinkFetcher } from "./ssrf.js";
import { runRankBatch } from "./rank.js";

const prisma = testPrisma();
const NOW = new Date("2026-10-01T12:00:00.000Z");
const SETTINGS = DEFAULT_SETTINGS;
const USAGE: LlmUsage = {
  model: "fake",
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  webSearchCalls: 0,
  latencyMs: 0,
  requestId: null,
};

beforeEach(async () => {
  await resetDb(prisma);
});

// --- helpers ------------------------------------------------------------------------------------

type Page = { status?: number; finalUrl?: string; body?: string };

/** A link fetcher that answers from `pages` by URL and records what it was asked. */
function fetcher(pages: Record<string, Page> = {}) {
  const requested: string[] = [];
  const fetch: LinkFetcher = (url) => {
    requested.push(url);
    const page = pages[url] ?? {};
    return Promise.resolve({
      status: page.status ?? 200,
      finalUrl: page.finalUrl ?? url,
      contentType: "text/html; charset=utf-8",
      body: page.body ?? "<html><body><h1>Open role</h1><p>We build things.</p></body></html>",
    });
  };
  return { fetch, requested };
}

function workerCtx(pages: Record<string, Page> = {}) {
  const link = fetcher(pages);
  const ctx = testWorkerCtx({ fetchLink: link.fetch, clock: () => NOW });
  return { ctx, requested: link.requested };
}

const incoming = (over: Partial<IncomingLead> & { ref: string }): IncomingLead => ({
  order: 0,
  source: "gmail_alert",
  companyName: "Acme Robotics",
  companyDomain: null,
  title: "Backend Engineer",
  jobUrl: `https://careers.example/jobs/${over.ref}`,
  locationText: null,
  country: null,
  workMode: "unknown",
  compensationText: null,
  sponsorshipText: null,
  postedAt: null,
  seniority: null,
  ranking: null,
  verification: null,
  pageExcerpt: null,
  sheetStatus: null,
  notes: null,
  contactEmail: null,
  ...over,
});

function baseRanking(leadRef: string): Ranking {
  return {
    leadRef,
    track: "A",
    fitScore: 70,
    fitReason: "Close match",
    gaps: [],
    seniority: "senior",
    workMode: "remote",
    remoteFromHomeCountry: "yes",
    sponsorship: "unknown",
    relocation: "unknown",
    compensation: {
      min: null,
      max: null,
      currency: null,
      period: null,
      isEstimate: false,
      basis: null,
    },
    eligible: "yes",
    eligibilityReason: null,
  };
}

/** Makes the model rank every lead as `baseRanking` plus what `by` returns for that lead. */
function stubRank(
  ctx: WorkerCtx,
  by: (lead: { leadRef: string; title: string; company: string }) => Partial<Ranking> = () => ({}),
) {
  return vi.spyOn(ctx.llm, "rank").mockImplementation((input) =>
    Promise.resolve({
      output: {
        rankings: input.leads.map((lead) => ({ ...baseRanking(lead.leadRef), ...by(lead) })),
      },
      usage: USAGE,
    }),
  );
}

async function ingest(
  ctx: WorkerCtx,
  leads: IncomingLead[],
  kind: "gmail_message" | "sheet_import" | "manual" | "paste_report" = "gmail_message",
  extra: { messageId?: string } = {},
): Promise<IngestResult> {
  const result = await ctx.prisma.$transaction((tx) =>
    ingestLeads(tx, { kind, ...extra }, leads, { settings: SETTINGS, now: NOW }),
  );
  await enqueueLeadChecks(ctx.queue, result);
  return result;
}

/** Runs the jobs the queue holds, and the jobs those send, in order, as the worker would. */
async function drain(ctx: WorkerCtx & { queue: RecordingQueue }): Promise<void> {
  for (let i = 0; i < ctx.queue.sent.length; i += 1) {
    const job = ctx.queue.sent[i]!;
    if (job.name === QUEUES.leadsCheck) await runLeadCheck(ctx, String(job.data.leadId));
    else if (job.name === QUEUES.leadsRank) await runRankBatch(ctx);
    else if (job.name === QUEUES.leadsFinalize) await runFinalize(ctx, String(job.data.batchId));
  }
}

const sentTo = (ctx: { queue: RecordingQueue }, name: string) =>
  ctx.queue.sent.filter((s) => s.name === name);
const leadsOf = (batchId: string) =>
  prisma.lead.findMany({ where: { intakeBatchId: batchId }, orderBy: { createdAt: "asc" } });
const batchOf = (batchId: string) =>
  prisma.intakeBatch.findUniqueOrThrow({ where: { id: batchId } });

const EMPTY_SNAPSHOT: PlanSnapshot = {
  threadLinks: new Map(),
  applications: [],
  leads: [],
  companies: [],
  companyIndex: { companies: [], contacts: [] },
  applicationState: new Map(),
  leadState: new Map(),
  interviews: new Map(),
  ownerTimezone: "America/Monterrey",
};

/** What the planner produces for a fixture email on an empty database: its `create_leads` batch. */
function plannedLeads(fixture: EmailFixture): { source: string; leads: IncomingLead[] } | null {
  const extraction = fixture.llm.extraction;
  if (extraction === null) return null;
  const fromEmail = /<([^>]+)>/.exec(fixture.headers.from)?.[1] ?? fixture.headers.from;
  const plan = planChanges(
    EMPTY_SNAPSHOT,
    {
      id: fixture.id,
      threadId: fixture.threadId,
      internalDate: new Date(fixture.internalDate),
      direction: "inbound",
      fromEmail,
      icsEvents: [],
    },
    extraction,
    { autoApplyMinConfidence: 0.8 },
  );
  const op = plan.operations.find((o) => o.op === "create_leads");
  return op?.op === "create_leads" ? { source: op.source, leads: op.leads } : null;
}

async function seedMessage(db: PrismaClient, id: string): Promise<void> {
  await db.gmailMessage.create({
    data: {
      id,
      threadId: `thread-${id}`,
      internalDate: NOW,
      direction: "inbound",
      labelIds: [],
      toEmails: [],
    },
  });
}

// --- tests --------------------------------------------------------------------------------------

describe("lead intake, check, rank and finalize", () => {
  it("a LinkedIn alert with 5 jobs creates 5 leads that end unverifiable, ranked and ready", async () => {
    const fixture = loadEmailFixtures().find((f) => f.id === "alert-linkedin-five-jobs")!;
    const planned = plannedLeads(fixture)!;
    expect(planned.leads).toHaveLength(5);
    const { ctx, requested } = workerCtx();
    stubRank(ctx);
    await seedMessage(prisma, fixture.id);

    const result = await ingest(ctx, planned.leads, "gmail_message", { messageId: fixture.id });
    expect(result.leadIds).toHaveLength(5);
    expect(result.counts).toEqual({
      received: 5,
      duplicates: 0,
      suppressed: 0,
      dead: 0,
      accepted: 5,
    });
    const created = await leadsOf(result.batchId);
    expect(created.map((l) => [l.status, l.pipelineState, l.sourceMessageId])).toEqual(
      Array(5).fill(["new", "checking", fixture.id]),
    );
    expect(sentTo(ctx, QUEUES.leadsCheck)).toHaveLength(5);

    await drain(ctx);

    const done = await leadsOf(result.batchId);
    expect(done).toHaveLength(5);
    for (const lead of done) {
      expect(lead).toMatchObject({
        status: "new",
        pipelineState: "ready",
        verification: "unverifiable",
        fitScore: 70,
      });
      expect(lead.rankedAt).toEqual(NOW);
      expect(lead.verifiedAt).toEqual(NOW);
    }
    // LinkedIn needs a login: nothing was requested.
    expect(requested).toEqual([]);
    // The batch settled once, after the last rank; the finalize is keyed by the batch.
    // (Rank jobs that find nothing left to rank send it again; the key makes that harmless.)
    const finalizes = sentTo(ctx, QUEUES.leadsFinalize);
    expect(finalizes.length).toBeGreaterThanOrEqual(1);
    for (const sent of finalizes) {
      expect(sent).toEqual({
        name: "leads.finalize",
        data: { batchId: result.batchId },
        opts: { singletonKey: result.batchId },
      });
    }
    expect((await batchOf(result.batchId)).finalizedAt).toEqual(NOW);
    expect((await batchOf(result.batchId)).counts).toEqual(result.counts);
  });

  it("a dead link deletes the lead, counts it as dead, and a later posting from that company is not suppressed", async () => {
    const dead = "https://careers.orbit.example/jobs/1";
    const { ctx } = workerCtx({ [dead]: { status: 404 } });
    stubRank(ctx);

    const first = await ingest(ctx, [
      incoming({ ref: "a", companyName: "Orbit Works", jobUrl: dead }),
    ]);
    await drain(ctx);

    expect(await leadsOf(first.batchId)).toEqual([]);
    expect((await batchOf(first.batchId)).counts).toEqual({
      received: 1,
      duplicates: 0,
      suppressed: 0,
      dead: 1,
      accepted: 0,
    });
    // The company is known, but it has no lead, so it does not count as reported.
    expect(await prisma.company.count({ where: { name: "Orbit Works" } })).toBe(1);
    expect(sentTo(ctx, QUEUES.leadsRank)).toEqual([]);

    const second = await ingest(ctx, [
      incoming({
        ref: "b",
        companyName: "Orbit Works",
        jobUrl: "https://careers.orbit.example/jobs/2",
      }),
    ]);
    const [lead] = await leadsOf(second.batchId);
    expect(lead).toMatchObject({
      status: "new",
      suppressedReason: null,
      pipelineState: "checking",
    });
    expect(second.counts.suppressed).toBe(0);
  });

  it("a dead sheet_import lead becomes dismissed with posting_closed", async () => {
    const dead = "https://careers.orbit.example/jobs/closed";
    const { ctx } = workerCtx({ [dead]: { status: 410 } });
    stubRank(ctx);

    const result = await ingest(
      ctx,
      [
        incoming({
          ref: "row-1",
          source: "sheet_import",
          sheetStatus: "to_research",
          companyName: "Orbit Works",
          jobUrl: dead,
        }),
      ],
      "sheet_import",
    );
    await drain(ctx);

    const [lead] = await leadsOf(result.batchId);
    expect(lead).toMatchObject({
      status: "dismissed",
      dismissedReason: "posting_closed",
      pipelineState: "ready",
    });
    expect(sentTo(ctx, QUEUES.leadsRank)).toEqual([]);
    // Sheet batches never finalize.
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toEqual([]);
    expect((await batchOf(result.batchId)).counts).toMatchObject({ dead: 0, accepted: 0 });
  });

  it("ranking stores track, fit score, reason, gaps, seniority, work mode, tri-states and compensation with isEstimate", async () => {
    const { ctx } = workerCtx();
    const longReason = "x".repeat(300);
    stubRank(ctx, () => ({
      track: "B",
      fitScore: 87.4,
      fitReason: longReason,
      gaps: ["Kubernetes", "Go", "Team lead experience", "Fifth gap"],
      seniority: "staff_plus",
      workMode: "hybrid",
      remoteFromHomeCountry: "no",
      sponsorship: "yes",
      relocation: "yes",
      compensation: {
        min: 90000,
        max: 120000.5,
        currency: "usd",
        period: "year",
        isEstimate: true,
        basis: "Typical for the level in this market",
      },
      eligible: "unknown",
      eligibilityReason: "Visa policy is not stated",
    }));
    // staff_plus is excluded by default; allow it for this test.
    await prisma.setting.create({
      data: {
        key: "search",
        value: { ...SETTINGS.search, excludedSeniorities: ["junior"] },
      },
    });

    const result = await ingest(ctx, [incoming({ ref: "a", jobUrl: "https://careers.example/a" })]);
    await drain(ctx);

    const [lead] = await leadsOf(result.batchId);
    expect(lead).toMatchObject({
      status: "new",
      pipelineState: "ready",
      track: "B",
      fitScore: 87,
      fitReason: "x".repeat(160),
      gaps: ["Kubernetes", "Go", "Team lead experience"],
      seniority: "staff_plus",
      workMode: "hybrid",
      remoteFromHomeCountry: "no",
      sponsorship: "yes",
      relocation: "yes",
      compCurrency: "USD",
      compPeriod: "year",
      compIsEstimate: true,
      compBasis: "Typical for the level in this market",
      eligible: "unknown",
      eligibilityReason: "Visa policy is not stated",
    });
    expect(lead?.compMin?.toString()).toBe("90000");
    expect(lead?.compMax?.toString()).toBe("120000.5");
    expect(lead?.rankedAt).toEqual(NOW);
  });

  it("a track the owner has not configured is stored as no track", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx, () => ({ track: "Z" }));
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    await drain(ctx);
    expect((await leadsOf(result.batchId))[0]?.track).toBeNull();
  });

  it("the ranking input includes the page excerpt when the link was verified", async () => {
    const verified = "https://careers.example/verified";
    const blocked = "https://careers.example/blocked";
    const { ctx } = workerCtx({
      [verified]: {
        body: "<html><body><h1>Platform Engineer</h1><p>You will run the Kubernetes fleet.</p></body></html>",
      },
      [blocked]: { status: 403 },
    });
    const rank = stubRank(ctx);
    await prisma.candidateProfile.create({
      data: {
        fileName: "cv.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        textContent: "cv text",
        profile: {
          headline: "Platform engineer",
          yearsExperience: 9,
          coreSkills: ["Go"],
          secondarySkills: [],
          domains: [],
          recentRoles: [],
          leadership: null,
          languages: [],
          location: null,
          workAuthorization: null,
        },
        profileStatus: "ok",
        isActive: true,
      },
    });

    await ingest(ctx, [
      incoming({ ref: "v", order: 0, companyName: "Verified Co", jobUrl: verified }),
      incoming({ ref: "b", order: 1, companyName: "Blocked Co", jobUrl: blocked }),
    ]);
    await drain(ctx);

    expect(rank).toHaveBeenCalledTimes(1);
    const input = rank.mock.calls[0]![0];
    const byCompany = new Map(input.leads.map((l) => [l.company, l]));
    expect(byCompany.get("Verified Co")?.pageExcerpt).toContain("Kubernetes fleet");
    expect(byCompany.get("Blocked Co")?.pageExcerpt).toBeNull();
    expect(input.homeCountry).toBe("MX");
    expect(input.brief).toBe(SETTINGS.search.brief);
    expect(input.tracks).toEqual(SETTINGS.search.tracks);
    expect(input.cvProfile?.headline).toBe("Platform engineer");
    const stored = await prisma.lead.findMany({ orderBy: { createdAt: "asc" } });
    expect(stored.map((l) => l.verification)).toEqual(["verified", "unverified"]);
    expect(stored[0]?.pageExcerpt).toContain("Kubernetes fleet");
  });

  it("ineligible 'no' → suppressed ineligible", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx, () => ({ eligible: "no", eligibilityReason: "Requires a local work permit" }));
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    await drain(ctx);

    const [lead] = await leadsOf(result.batchId);
    expect(lead).toMatchObject({
      status: "suppressed",
      suppressedReason: "ineligible",
      pipelineState: "ready",
      eligible: "no",
      eligibilityReason: "Requires a local work permit",
    });
    expect((await batchOf(result.batchId)).counts).toMatchObject({ suppressed: 1, accepted: 0 });
  });

  it("a seniority the owner excludes, once ranked, → suppressed excluded_seniority", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx, () => ({ seniority: "manager", eligible: "no" }));
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    await drain(ctx);
    const [lead] = await leadsOf(result.batchId);
    expect(lead).toMatchObject({ status: "suppressed", suppressedReason: "excluded_seniority" });
  });

  it("finalize keeps the best lead per company and suppresses the rest as same_company_in_batch", async () => {
    const { ctx } = workerCtx();
    const fit: Record<string, number> = { low: 70, best: 90, mid: 80, other: 10 };
    stubRank(ctx, (lead) => ({ fitScore: fit[lead.title] ?? 0 }));
    const result = await ingest(ctx, [
      incoming({ ref: "1", order: 0, title: "low" }),
      incoming({ ref: "2", order: 1, title: "best" }),
      incoming({ ref: "3", order: 2, title: "mid" }),
      incoming({ ref: "4", order: 3, title: "other", companyName: "Beta Labs" }),
    ]);
    await drain(ctx);

    const byTitle = new Map((await leadsOf(result.batchId)).map((l) => [l.title, l]));
    expect(byTitle.get("best")).toMatchObject({ status: "new", suppressedReason: null });
    expect(byTitle.get("other")).toMatchObject({ status: "new" });
    for (const title of ["low", "mid"]) {
      expect(byTitle.get(title)).toMatchObject({
        status: "suppressed",
        suppressedReason: "same_company_in_batch",
      });
    }
    const batch = await batchOf(result.batchId);
    expect(batch.counts).toEqual({
      received: 4,
      duplicates: 0,
      suppressed: 2,
      dead: 0,
      accepted: 2,
    });
    expect(batch.finalizedAt).toEqual(NOW);
  });

  it("a tie on fit score goes to the newest posting, then to the first one returned", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx, () => ({ fitScore: 80 }));
    const result = await ingest(ctx, [
      incoming({ ref: "1", order: 0, title: "old", postedAt: new Date("2026-09-01T00:00:00Z") }),
      incoming({ ref: "2", order: 1, title: "fresh", postedAt: new Date("2026-09-20T00:00:00Z") }),
      incoming({ ref: "3", order: 2, title: "first", companyName: "Beta Labs" }),
      incoming({ ref: "4", order: 3, title: "second", companyName: "Beta Labs" }),
    ]);
    await drain(ctx);

    const status = new Map((await leadsOf(result.batchId)).map((l) => [l.title, l.status]));
    expect(status.get("fresh")).toBe("new");
    expect(status.get("old")).toBe("suppressed");
    expect(status.get("first")).toBe("new");
    expect(status.get("second")).toBe("suppressed");
  });

  it("when a kept lead turns out dead, the best remaining same-company lead returns to new and is checked", async () => {
    const keptUrl = "https://careers.example/kept";
    const pages: Record<string, Page> = {};
    const { ctx } = workerCtx(pages);
    const fit: Record<string, number> = { kept: 90, runnerUp: 80, third: 70 };
    const rank = stubRank(ctx, (lead) => ({ fitScore: fit[lead.title] ?? 0 }));
    const result = await ingest(ctx, [
      incoming({ ref: "kept", order: 0, title: "kept", jobUrl: keptUrl }),
      incoming({ ref: "runnerUp", order: 1, title: "runnerUp" }),
      incoming({ ref: "third", order: 2, title: "third" }),
    ]);
    await drain(ctx);
    const afterFinalize = new Map((await leadsOf(result.batchId)).map((l) => [l.title, l]));
    expect(afterFinalize.get("kept")?.status).toBe("new");
    expect(afterFinalize.get("runnerUp")?.status).toBe("suppressed");

    // The kept posting is checked again later and is gone.
    pages[keptUrl] = { status: 404 };
    const kept = afterFinalize.get("kept")!;
    await prisma.lead.update({ where: { id: kept.id }, data: { pipelineState: "checking" } });
    ctx.queue.sent.length = 0;
    rank.mockClear();
    await runLeadCheck(ctx, kept.id);

    const byTitle = new Map((await leadsOf(result.batchId)).map((l) => [l.title, l]));
    expect(byTitle.has("kept")).toBe(false);
    expect(byTitle.get("runnerUp")).toMatchObject({
      status: "new",
      suppressedReason: null,
      pipelineState: "checking",
    });
    expect(byTitle.get("third")).toMatchObject({
      status: "suppressed",
      suppressedReason: "same_company_in_batch",
    });
    expect(ctx.queue.sent).toEqual([
      {
        name: "leads.check",
        data: { leadId: byTitle.get("runnerUp")!.id, batchId: result.batchId },
        opts: {},
      },
    ]);
    expect((await batchOf(result.batchId)).counts).toEqual({
      received: 3,
      duplicates: 0,
      suppressed: 1,
      dead: 1,
      accepted: 1,
    });

    // The promoted lead was ranked with the batch, so checking it again does not rank it again.
    await drain(ctx);
    expect((await leadsOf(result.batchId)).find((l) => l.title === "runnerUp")).toMatchObject({
      status: "new",
      pipelineState: "ready",
    });
    expect(rank).not.toHaveBeenCalled();
  });

  it("finalize runs once per batch", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx, (lead) => ({ fitScore: lead.title === "a" ? 90 : 50 }));
    const result = await ingest(ctx, [
      incoming({ ref: "1", order: 0, title: "a" }),
      incoming({ ref: "2", order: 1, title: "b" }),
    ]);
    await drain(ctx);
    const finalizedAt = (await batchOf(result.batchId)).finalizedAt;
    expect(finalizedAt).not.toBeNull();

    // The owner reconsiders the suppressed lead; a repeated job must not undo that.
    const suppressed = (await leadsOf(result.batchId)).find((l) => l.title === "b")!;
    expect(suppressed.status).toBe("suppressed");
    await prisma.lead.update({
      where: { id: suppressed.id },
      data: { status: "new", suppressedReason: null },
    });
    ctx.queue.sent.length = 0;
    await runFinalize(ctx, result.batchId);
    await runFinalize({ ...ctx, clock: () => new Date("2026-10-02T00:00:00Z") }, result.batchId);

    expect((await leadsOf(result.batchId)).map((l) => l.status)).toEqual(["new", "new"]);
    expect((await batchOf(result.batchId)).finalizedAt).toEqual(finalizedAt);
    expect(ctx.queue.sent).toEqual([]);
  });

  it("finalize waits while a lead of the batch is still checking or ranking", async () => {
    const { ctx } = workerCtx();
    const result = await ingest(ctx, [
      incoming({ ref: "1", order: 0 }),
      incoming({ ref: "2", order: 1 }),
    ]);
    await runFinalize(ctx, result.batchId);
    expect((await batchOf(result.batchId)).finalizedAt).toBeNull();
    expect((await leadsOf(result.batchId)).map((l) => l.status)).toEqual(["new", "new"]);
  });

  it("finalize skips sheet and manual batches", async () => {
    const { ctx } = workerCtx();
    for (const kind of ["sheet_import", "manual"] as const) {
      const result = await ingest(
        ctx,
        [
          incoming({
            ref: `${kind}-1`,
            order: 0,
            source: kind === "manual" ? "manual" : "sheet_import",
          }),
          incoming({
            ref: `${kind}-2`,
            order: 1,
            source: kind === "manual" ? "manual" : "sheet_import",
          }),
        ],
        kind,
      );
      await prisma.lead.updateMany({
        where: { intakeBatchId: result.batchId },
        data: { pipelineState: "ready", fitScore: 50 },
      });
      await runFinalize(ctx, result.batchId);
      expect((await leadsOf(result.batchId)).map((l) => l.status)).toEqual(["new", "new"]);
      expect((await batchOf(result.batchId)).finalizedAt).toBeNull();
      await resetDb(prisma);
    }
  });

  it("intake skips duplicates, blank company names and companies already seen, and counts them", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx);
    const first = await ingest(ctx, [
      incoming({
        ref: "1",
        order: 0,
        companyName: "Acme Robotics",
        jobUrl: "https://careers.example/jobs/1",
      }),
    ]);
    await drain(ctx);
    expect(first.counts.accepted).toBe(1);

    const second = await ingest(ctx, [
      // Same posting as an existing lead, with a tracking parameter.
      incoming({ ref: "dup", order: 0, jobUrl: "https://careers.example/jobs/1?utm_source=x" }),
      // No company at all.
      incoming({
        ref: "blank",
        order: 1,
        companyName: "  ",
        jobUrl: "https://careers.example/jobs/2",
      }),
      // A company that already has a lead.
      incoming({ ref: "seen", order: 2, jobUrl: "https://careers.example/jobs/3" }),
      incoming({
        ref: "fresh",
        order: 3,
        companyName: "Beta Labs",
        jobUrl: "https://careers.example/jobs/4",
      }),
    ]);
    expect(second.counts).toEqual({
      received: 4,
      duplicates: 1,
      suppressed: 1,
      dead: 0,
      accepted: 1,
    });
    expect(second.leadIds).toHaveLength(2);
    expect(Object.keys(second.refs).sort()).toEqual(["fresh", "seen"]);
    const stored = await leadsOf(second.batchId);
    expect(
      stored.map((l) => [l.companyId === first.leadIds[0] ? "x" : l.status, l.suppressedReason]),
    ).toEqual(
      expect.arrayContaining([
        ["suppressed", "company_already_seen"],
        ["new", null],
      ]),
    );
    // Only the lead that waits for a check is queued.
    expect(second.checkIds).toEqual([second.refs.fresh]);
    expect(await prisma.company.count()).toBe(2);
  });

  it("one company named by several leads of a batch is created once", async () => {
    const { ctx } = workerCtx();
    const result = await ingest(ctx, [
      incoming({ ref: "1", order: 0, companyName: "Sandpiper AI" }),
      incoming({ ref: "2", order: 1, companyName: "Sandpiper AI, Inc." }),
    ]);
    const companies = await prisma.company.findMany();
    expect(companies.map((c) => c.name)).toEqual(["Sandpiper AI"]);
    expect(companies[0]).toMatchObject({ normalizedName: "sandpiper ai", createdSource: "gmail" });
    expect(result.createdCompanyIds).toEqual([companies[0]!.id]);
    expect(await prisma.lead.count({ where: { companyId: companies[0]!.id } })).toBe(2);
  });

  it("search-agent leads arrive ranked and ready and are never checked", async () => {
    const { ctx } = workerCtx();
    const ranking = { ...baseRanking("r"), fitScore: 91, eligible: "yes" as const };
    const result = await ctx.prisma.$transaction((tx) =>
      ingestLeads(
        tx,
        { kind: "search_run" },
        [
          incoming({
            ref: "r",
            source: "search_agent",
            ranking,
            verification: "verified",
            pageExcerpt: "page",
          }),
          incoming({
            ref: "n",
            order: 1,
            source: "search_agent",
            companyName: "Beta Labs",
            ranking: { ...ranking, eligible: "no" },
          }),
        ],
        { settings: SETTINGS, now: NOW },
      ),
    );
    expect(result.checkIds).toEqual([]);
    const stored = new Map((await leadsOf(result.batchId)).map((l) => [l.companyId, l]));
    const lead = [...stored.values()].find((l) => l.fitScore === 91);
    expect(lead).toMatchObject({
      status: "new",
      pipelineState: "ready",
      verification: "verified",
      pageExcerpt: "page",
      track: "A",
    });
    expect(lead?.rankedAt).toEqual(NOW);
    expect([...stored.values()].find((l) => l.status === "suppressed")).toMatchObject({
      suppressedReason: "ineligible",
    });
  });

  it("runLeadCheck skips a lead that is not being checked", async () => {
    const { ctx, requested } = workerCtx();
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    const id = result.leadIds[0]!;
    await prisma.lead.update({ where: { id }, data: { pipelineState: "ready" } });
    ctx.queue.sent.length = 0;
    await runLeadCheck(ctx, id);
    await runLeadCheck(ctx, "00000000-0000-4000-8000-000000000000");
    expect(requested).toEqual([]);
    // Nothing to check or rank (a settled batch may send its finalize again).
    expect(sentTo(ctx, QUEUES.leadsCheck)).toEqual([]);
    expect(sentTo(ctx, QUEUES.leadsRank)).toEqual([]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).verification).toBe("pending");
  });

  it("a lead with no link is unverified and goes on to ranking", async () => {
    const { ctx, requested } = workerCtx();
    const result = await ingest(ctx, [incoming({ ref: "a", jobUrl: null })]);
    await runLeadCheck(ctx, result.leadIds[0]!);
    expect(requested).toEqual([]);
    expect(
      await prisma.lead.findUniqueOrThrow({ where: { id: result.leadIds[0]! } }),
    ).toMatchObject({
      verification: "unverified",
      pipelineState: "ranking",
    });
    expect(sentTo(ctx, QUEUES.leadsRank)).toHaveLength(1);
  });

  it("the original job link and job key stay as received when the page redirects", async () => {
    const original = "https://tracker.example/click?id=1&utm_source=mail";
    const landing = "https://jobs.ashbyhq.com/acme/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e34";
    const { ctx } = workerCtx({ [original]: { finalUrl: landing } });
    const result = await ingest(ctx, [incoming({ ref: "a", jobUrl: original })]);
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: result.leadIds[0]! } });
    await runLeadCheck(ctx, result.leadIds[0]!);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: result.leadIds[0]! } });
    expect(after.verification).toBe("verified");
    expect(after.jobUrl).toBe(original);
    expect(after.jobKey).toBe(before.jobKey);
    expect(after.jobKey).not.toContain("ashby");
  });

  it("runRankBatch ranks at most 10 leads per call and sends another job for the rest", async () => {
    const { ctx } = workerCtx();
    const rank = stubRank(ctx);
    const leads = Array.from({ length: 12 }, (_, i) =>
      incoming({
        ref: `l${i}`,
        order: i,
        companyName: `Company ${i}`,
        jobUrl: `https://careers.example/jobs/${i}`,
      }),
    );
    const result = await ingest(ctx, leads);
    for (const id of result.checkIds) await runLeadCheck(ctx, id);
    ctx.queue.sent.length = 0;

    await runRankBatch(ctx);
    expect(rank.mock.calls[0]![0].leads).toHaveLength(10);
    expect(await prisma.lead.count({ where: { pipelineState: "ranking" } })).toBe(2);
    expect(sentTo(ctx, QUEUES.leadsRank)).toHaveLength(1);
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toHaveLength(0);

    ctx.queue.sent.length = 0;
    await runRankBatch(ctx);
    expect(rank.mock.calls[1]![0].leads).toHaveLength(2);
    expect(sentTo(ctx, QUEUES.leadsRank)).toHaveLength(0);
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toHaveLength(1);

    // Nothing left to rank: no model call.
    await runRankBatch(ctx);
    expect(rank).toHaveBeenCalledTimes(2);
  });

  it("runRankBatch keeps a lead the model left out in ranking and fails so the job retries", async () => {
    const { ctx } = workerCtx();
    vi.spyOn(ctx.llm, "rank").mockImplementation((input) =>
      Promise.resolve({
        output: { rankings: input.leads.slice(0, 1).map((l) => baseRanking(l.leadRef)) },
        usage: USAGE,
      }),
    );
    const result = await ingest(ctx, [
      incoming({ ref: "a", order: 0, companyName: "Company A" }),
      incoming({ ref: "b", order: 1, companyName: "Company B" }),
    ]);
    for (const id of result.checkIds) await runLeadCheck(ctx, id);
    await expect(runRankBatch(ctx)).rejects.toThrow(/did not rank/);
    const states = (await leadsOf(result.batchId)).map((l) => l.pipelineState).sort();
    expect(states).toEqual(["ranking", "ready"]);
  });

  it("job-alert and recruiter fixtures now become leads", async () => {
    const fixtures = loadEmailFixtures().filter(
      (f) =>
        (f.expected.category === "job_alert" || f.expected.category === "recruiter_outreach") &&
        (f.expected.leads ?? 0) > 0,
    );
    expect(fixtures.length).toBeGreaterThanOrEqual(7);
    for (const fixture of fixtures) {
      await resetDb(prisma);
      const { ctx } = workerCtx();
      stubRank(ctx);
      const planned = plannedLeads(fixture);
      expect(planned, fixture.id).not.toBeNull();
      await seedMessage(prisma, fixture.id);
      const result = await ingest(ctx, planned!.leads, "gmail_message", { messageId: fixture.id });
      await drain(ctx);

      const stored = await leadsOf(result.batchId);
      expect(stored.length, fixture.id).toBe(fixture.expected.leads);
      for (const lead of stored) {
        expect(lead.source, fixture.id).toBe(planned!.source);
        expect(lead.pipelineState, fixture.id).toBe("ready");
        expect(lead.sourceMessageId, fixture.id).toBe(fixture.id);
      }
    }
  });
});

describe("redelivered and failing jobs", () => {
  const job = (data: Record<string, unknown>, retryCount = 0): JobInfo => ({
    data,
    retryCount,
    retryLimit: 3,
  });
  const upstream = () => new LlmError("upstream", "upstream", { retryable: true });

  it("a check run again after its sends were dropped sends leads.rank again", async () => {
    const { ctx } = workerCtx();
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    const id = result.leadIds[0]!;
    await runLeadCheck(ctx, id, result.batchId);
    expect(sentTo(ctx, QUEUES.leadsRank)).toHaveLength(1);

    ctx.queue.sent.length = 0; // the worker died before the sends reached the queue
    await runLeadCheck(ctx, id, result.batchId);
    expect(sentTo(ctx, QUEUES.leadsRank)).toHaveLength(1);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id } })).toMatchObject({
      pipelineState: "ranking",
      verification: "verified",
    });
  });

  it("a dead lead's check run again after its sends were dropped checks the lead that replaced it", async () => {
    const keptUrl = "https://careers.example/kept";
    const pages: Record<string, Page> = {};
    const { ctx } = workerCtx(pages);
    stubRank(ctx, (lead) => ({ fitScore: lead.title === "kept" ? 90 : 80 }));
    const result = await ingest(ctx, [
      incoming({ ref: "kept", order: 0, title: "kept", jobUrl: keptUrl }),
      incoming({ ref: "runnerUp", order: 1, title: "runnerUp" }),
    ]);
    await drain(ctx);
    const kept = (await leadsOf(result.batchId)).find((l) => l.title === "kept")!;
    pages[keptUrl] = { status: 404 };
    await prisma.lead.update({ where: { id: kept.id }, data: { pipelineState: "checking" } });
    ctx.queue.sent.length = 0;
    await runLeadCheck(ctx, kept.id, result.batchId);
    const runnerUp = (await leadsOf(result.batchId)).find((l) => l.title === "runnerUp")!;
    expect(runnerUp.pipelineState).toBe("checking");

    ctx.queue.sent.length = 0; // dropped
    await runLeadCheck(ctx, kept.id, result.batchId); // the lead is gone now
    expect(ctx.queue.sent).toEqual([
      { name: "leads.check", data: { leadId: runnerUp.id, batchId: result.batchId }, opts: {} },
    ]);
  });

  it("a rank run again after its finalize was dropped sends leads.finalize, and the batch finishes", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx);
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    await runLeadCheck(ctx, result.leadIds[0]!, result.batchId);
    await runRankBatch(ctx);
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toHaveLength(1);

    ctx.queue.sent.length = 0; // dropped
    await runRankBatch(ctx); // re-delivered: nothing is left to rank
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toEqual([
      {
        name: "leads.finalize",
        data: { batchId: result.batchId },
        opts: { singletonKey: result.batchId },
      },
    ]);
    await runFinalize(ctx, result.batchId);
    expect((await batchOf(result.batchId)).finalizedAt).toEqual(NOW);

    // Finalized: a further re-delivery has nothing left to send.
    ctx.queue.sent.length = 0;
    await runRankBatch(ctx);
    await runLeadCheck(ctx, result.leadIds[0]!, result.batchId);
    expect(ctx.queue.sent).toEqual([]);
  });

  it("a check run again after its finalize was dropped sends leads.finalize", async () => {
    const { ctx } = workerCtx();
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    const id = result.leadIds[0]!;
    await runLeadCheck(ctx, id, result.batchId);
    await prisma.lead.update({ where: { id }, data: { pipelineState: "ready", rankedAt: NOW } });
    ctx.queue.sent.length = 0;
    await runLeadCheck(ctx, id, result.batchId);
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toHaveLength(1);
  });

  it("a failing model call leaves leads waiting while retries remain", async () => {
    const { ctx } = workerCtx();
    vi.spyOn(ctx.llm, "rank").mockRejectedValue(upstream());
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    await runLeadCheck(ctx, result.leadIds[0]!, result.batchId);
    ctx.queue.sent.length = 0;
    await expect(HANDLERS[QUEUES.leadsRank]!(ctx, job({}, 2))).rejects.toThrow("upstream");
    expect((await leadsOf(result.batchId))[0]?.pipelineState).toBe("ranking");
    expect(ctx.queue.sent).toEqual([]);
  });

  it("when ranking fails on its last attempt the leads move on unranked and the batch finishes", async () => {
    const { ctx } = workerCtx();
    vi.spyOn(ctx.llm, "rank").mockRejectedValue(upstream());
    const result = await ingest(ctx, [
      incoming({ ref: "a", order: 0, companyName: "Company A" }),
      incoming({ ref: "b", order: 1, companyName: "Company B" }),
    ]);
    for (const id of result.checkIds) await runLeadCheck(ctx, id, result.batchId);
    ctx.queue.sent.length = 0;

    await expect(HANDLERS[QUEUES.leadsRank]!(ctx, job({}, 3))).rejects.toThrow("upstream");
    const stored = await leadsOf(result.batchId);
    for (const lead of stored) {
      expect(lead).toMatchObject({
        status: "new",
        pipelineState: "ready",
        fitScore: null,
        rankedAt: null,
      });
    }
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toEqual([
      {
        name: "leads.finalize",
        data: { batchId: result.batchId },
        opts: { singletonKey: result.batchId },
      },
    ]);
    await runFinalize(ctx, result.batchId);
    const batch = await batchOf(result.batchId);
    expect(batch.finalizedAt).toEqual(NOW);
    expect(batch.counts).toMatchObject({ accepted: 2, suppressed: 0 });
  });

  it("a lead the model keeps leaving out moves on unranked on the last attempt, the rest keep their rank", async () => {
    const { ctx } = workerCtx();
    vi.spyOn(ctx.llm, "rank").mockImplementation((input) =>
      Promise.resolve({
        output: {
          rankings: input.leads
            .filter((l) => l.company !== "Company B")
            .map((l) => baseRanking(l.leadRef)),
        },
        usage: USAGE,
      }),
    );
    const result = await ingest(ctx, [
      incoming({ ref: "a", order: 0, companyName: "Company A" }),
      incoming({ ref: "b", order: 1, companyName: "Company B" }),
    ]);
    for (const id of result.checkIds) await runLeadCheck(ctx, id, result.batchId);
    ctx.queue.sent.length = 0;

    // Not the last attempt: the job fails and no job of its own is sent for the omitted lead.
    await expect(HANDLERS[QUEUES.leadsRank]!(ctx, job({}, 0))).rejects.toThrow(/did not rank/);
    expect(sentTo(ctx, QUEUES.leadsRank)).toEqual([]);

    await HANDLERS[QUEUES.leadsRank]!(ctx, job({}, 3));
    const stored = await leadsOf(result.batchId);
    expect(stored.map((l) => l.pipelineState)).toEqual(["ready", "ready"]);
    expect(stored.map((l) => l.fitScore)).toEqual([70, null]);
    expect(sentTo(ctx, QUEUES.leadsFinalize).length).toBeGreaterThanOrEqual(1);
  });

  it("the page text sent for ranking is capped at 8,000 characters", async () => {
    const { ctx } = workerCtx();
    const rank = stubRank(ctx);
    const result = await ingest(ctx, [incoming({ ref: "a", pageExcerpt: "p".repeat(20_000) })]);
    // A stored excerpt longer than the link check allows (written by another path).
    await prisma.lead.update({
      where: { id: result.leadIds[0]! },
      data: { pipelineState: "ranking", pageExcerpt: "p".repeat(20_000) },
    });
    await runRankBatch(ctx);
    expect(rank.mock.calls[0]![0].leads[0]?.pageExcerpt).toHaveLength(8000);
  });
});

describe("lead job handlers", () => {
  const job = (data: Record<string, unknown>): JobInfo => ({ data, retryCount: 0, retryLimit: 2 });

  it("registers leads.check, leads.rank and leads.finalize", () => {
    for (const name of [QUEUES.leadsCheck, QUEUES.leadsRank, QUEUES.leadsFinalize]) {
      expect(HANDLERS[name], name).toBeTypeOf("function");
    }
  });

  it("leads.check, leads.rank and leads.finalize run the jobs", async () => {
    const { ctx } = workerCtx();
    stubRank(ctx);
    const result = await ingest(ctx, [incoming({ ref: "a" })]);
    ctx.queue.sent.length = 0;
    await HANDLERS[QUEUES.leadsCheck]!(ctx, job({ leadId: result.leadIds[0] }));
    expect(sentTo(ctx, QUEUES.leadsRank)).toHaveLength(1);
    await HANDLERS[QUEUES.leadsRank]!(ctx, job({}));
    expect(sentTo(ctx, QUEUES.leadsFinalize)).toHaveLength(1);
    await HANDLERS[QUEUES.leadsFinalize]!(ctx, job({ batchId: result.batchId }));
    expect((await batchOf(result.batchId)).finalizedAt).toEqual(NOW);
  });

  it("a job without an id does nothing", async () => {
    const { ctx } = workerCtx();
    await HANDLERS[QUEUES.leadsCheck]!(ctx, job({}));
    await HANDLERS[QUEUES.leadsFinalize]!(ctx, job({ batchId: 7 }));
    expect(ctx.queue.sent).toEqual([]);
  });
});
