import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SearchRunSchema,
  type ApiErrorBody,
  type SearchLead,
  type SearchResult,
  type Settings,
} from "@offerbound/contracts";
import type { IncomingLead } from "@offerbound/domain";
import { buildTestApp, signIn, testEnv } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import type { RecordingQueue } from "../../test/queue.js";
import { testWorkerCtx } from "../../test/worker.js";
import type { WorkerCtx } from "../deps.js";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { LlmError, type LlmProvider, type LlmUsage, type SearchInput } from "../llm/provider.js";
import { recordLlmCall } from "../llm/record.js";
import { saveSettings } from "../settings/service.js";
import { startWorker } from "../worker.js";
import { ingestLeads } from "./intake.js";
import { markStaleRuns, registerSearchSchedule, requestSearchRun, runSearch } from "./search.js";
import type { LinkFetcher } from "./ssrf.js";

const prisma = testPrisma();
const NOW = new Date("2026-10-01T12:00:00.000Z");
const BRIEF = "Looking for fictional platform roles at fictional firms. Secret-brief-marker-9431.";

beforeEach(async () => {
  await resetDb(prisma);
});

// --- helpers ------------------------------------------------------------------------------------

function settingsWith(target: { min: number; max: number }): Settings {
  return {
    ...DEFAULT_SETTINGS,
    search: { ...DEFAULT_SETTINGS.search, brief: BRIEF, leadTarget: target, enabled: true },
  };
}

async function seedSettings(target: { min: number; max: number }): Promise<Settings> {
  const settings = settingsWith(target);
  await saveSettings(prisma, settings);
  return settings;
}

function searchLead(n: number, over: Partial<SearchLead> = {}): SearchLead {
  return {
    leadRef: `model-ref-${n}`,
    track: "A",
    fitScore: 60 + n,
    fitReason: "Matches the CV",
    gaps: [],
    seniority: "senior",
    workMode: "remote",
    remoteFromHomeCountry: "yes",
    sponsorship: "unknown",
    relocation: "unknown",
    compensation: {
      min: 90000,
      max: 120000,
      currency: "USD",
      period: "year",
      isEstimate: false,
      basis: null,
    },
    eligible: "yes",
    eligibilityReason: null,
    company: `Company ${n}`,
    companyDomain: `company${n}.example`,
    title: `Platform Engineer ${n}`,
    jobUrl: `https://careers.company${n}.example/jobs/${n}`,
    locationText: "Remote",
    country: "MX",
    postedAt: "2026-09-28",
    evidenceUrls: [],
    ...over,
  };
}

const batch = (...leads: SearchLead[]): SearchResult => ({ leads, notes: "" });

type Page = { status?: number; body?: string };

function fetcher(pages: Record<string, Page> = {}) {
  const requested: string[] = [];
  const fetch: LinkFetcher = (url) => {
    requested.push(url);
    const page = pages[url] ?? {};
    return Promise.resolve({
      status: page.status ?? 200,
      finalUrl: url,
      contentType: "text/html; charset=utf-8",
      body: page.body ?? "<html><body><h1>Open role</h1><p>Join us.</p></body></html>",
    });
  };
  return { fetch, requested };
}

function setup(batches: SearchResult[], pages: Record<string, Page> = {}) {
  const fake = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: batches, db: prisma });
  const link = fetcher(pages);
  const ctx = testWorkerCtx({ llm: fake, fetchLink: link.fetch, clock: () => NOW });
  return { ctx, fake, requested: link.requested };
}

/** A provider that answers like `fake`, except `search` calls it replaces. */
function withSearch(
  fake: FakeLlmProvider,
  search: (input: SearchInput, call: number) => ReturnType<LlmProvider["search"]> | null,
): LlmProvider {
  let call = 0;
  return Object.assign(Object.create(fake) as FakeLlmProvider, {
    search(input: SearchInput, ctx?: { searchRunId?: string }) {
      call += 1;
      return search(input, call) ?? fake.search(input, ctx);
    },
  });
}

const searchFailure = (): LlmError =>
  new LlmError("timeout", "The search round timed out.", { retryable: false });

async function seedLead(ctx: WorkerCtx, n: number): Promise<string> {
  const lead: IncomingLead = {
    ref: `seed-${n}`,
    order: 0,
    source: "gmail_alert",
    companyName: `Seen ${n}`,
    companyDomain: null,
    title: "Backend Engineer",
    jobUrl: `https://careers.seen${n}.example/jobs/${n}`,
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
  };
  const result = await ctx.prisma.$transaction((tx) =>
    ingestLeads(tx, { kind: "gmail_message" }, [lead], { settings: DEFAULT_SETTINGS, now: NOW }),
  );
  const id = result.leadIds[0];
  if (id === undefined) throw new Error("seed lead was not stored");
  return id;
}

// --- rounds -------------------------------------------------------------------------------------

describe("runSearch rounds", () => {
  it("one round when accepted ≥ min", async () => {
    await seedSettings({ min: 2, max: 3 });
    const { ctx, fake } = setup([batch(searchLead(1), searchLead(2), searchLead(3))]);

    const run = await runSearch(ctx, "manual");

    expect(SearchRunSchema.parse(run)).toMatchObject({
      trigger: "manual",
      status: "succeeded",
      rounds: 1,
      returned: 3,
      accepted: 3,
      error: null,
    });
    expect(run.finishedAt).not.toBeNull();
    expect(fake.calls.filter((c) => c.purpose === "search")).toHaveLength(1);
    expect((fake.calls[0]?.input as SearchInput).wanted).toBe(3);

    // Leads arrive checked and ranked: verified, ready, with the model's ranking.
    const leads = await prisma.lead.findMany({ orderBy: { title: "asc" } });
    expect(leads).toHaveLength(3);
    expect(leads.map((l) => [l.status, l.pipelineState, l.verification, l.source])).toEqual(
      Array(3).fill(["new", "ready", "verified", "search_agent"]),
    );
    expect(leads[0]).toMatchObject({ fitScore: 61, track: "A", compCurrency: "USD" });
    expect(Number(leads[0]?.compMin)).toBe(90000);
    // The batch belongs to the run and is finalized; no async checks are queued.
    const batches = await prisma.intakeBatch.findMany();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ kind: "search_run", searchRunId: run.id });
    expect(batches[0]?.finalizedAt).not.toBeNull();
    expect(ctx.queue.sent).toEqual([]);
    // One timeline event per lead.
    expect(await prisma.event.count({ where: { type: "lead_created" } })).toBe(3);
  });

  it("a second round excludes the first round's companies and asks for max − accepted", async () => {
    await seedSettings({ min: 4, max: 5 });
    const { ctx, fake } = setup([
      batch(searchLead(1), searchLead(2)),
      batch(searchLead(3), searchLead(4), searchLead(5)),
    ]);

    const run = await runSearch(ctx, "schedule");

    const inputs = fake.calls.map((c) => c.input as SearchInput);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => [i.round, i.wanted])).toEqual([
      [1, 5],
      [2, 3],
    ]);
    expect(inputs[0]?.exclusions).toEqual([]);
    const second = inputs[1]?.exclusions.flatMap((g) => g.names) ?? [];
    expect(second.sort()).toEqual(["Company 1", "Company 2"]);
    expect(run).toMatchObject({ status: "succeeded", rounds: 2, returned: 5, accepted: 5 });
  });

  it("stops when a round accepts nothing, and never runs more than 3 rounds", async () => {
    // AC-10.3. Round 2 only repeats round 1's postings: nothing accepted, so the run stops.
    await seedSettings({ min: 10, max: 12 });
    const stopped = setup([batch(searchLead(1)), batch(searchLead(1)), batch(searchLead(2))]);
    const first = await runSearch(stopped.ctx, "manual");
    expect(stopped.fake.calls).toHaveLength(2);
    expect(first).toMatchObject({ status: "partial", rounds: 2, accepted: 1, duplicates: 1 });

    await resetDb(prisma);
    await seedSettings({ min: 10, max: 12 });
    const capped = setup([1, 2, 3, 4, 5].map((n) => batch(searchLead(n))));
    const second = await runSearch(capped.ctx, "manual");
    expect(capped.fake.calls).toHaveLength(3);
    expect(second).toMatchObject({ status: "partial", rounds: 3, accepted: 3 });
  });

  it("respects SEARCH_MAX_ROUNDS", async () => {
    await seedSettings({ min: 10, max: 12 });
    const { ctx, fake } = setup([1, 2, 3, 4].map((n) => batch(searchLead(n))));
    ctx.env = testEnv({ SEARCH_MAX_ROUNDS: "2" });
    const run = await runSearch(ctx, "manual");
    expect(fake.calls).toHaveLength(2);
    expect(run.rounds).toBe(2);
  });

  it("sets rounds when a round starts, so a running run shows its current round", async () => {
    await seedSettings({ min: 2, max: 3 });
    const { ctx, fake } = setup([batch(searchLead(1)), batch(searchLead(2))]);
    const seen: { round: number; rounds: number; status: string }[] = [];
    ctx.llm = withSearch(fake, (input) => {
      return Promise.resolve(null).then(async () => {
        const row = await prisma.searchRun.findFirstOrThrow();
        seen.push({ round: input.round, rounds: row.rounds, status: row.status });
        return fake.search(input);
      });
    });
    await runSearch(ctx, "manual");
    expect(seen).toEqual([
      { round: 1, rounds: 1, status: "running" },
      { round: 2, rounds: 2, status: "running" },
    ]);
  });

  it("discards results without a job link", async () => {
    // AC-10.4
    await seedSettings({ min: 1, max: 3 });
    const { ctx, requested } = setup([
      batch(searchLead(1, { jobUrl: null }), searchLead(2, { jobUrl: "not a url" }), searchLead(3)),
    ]);

    const run = await runSearch(ctx, "manual");

    expect(run).toMatchObject({ returned: 3, accepted: 1 });
    expect(requested).toEqual(["https://careers.company3.example/jobs/3"]);
    const leads = await prisma.lead.findMany({ include: { company: true } });
    expect(leads.map((l) => l.company.name)).toEqual(["Company 3"]);
  });

  it("checks links with a concurrency of 5", async () => {
    await seedSettings({ min: 1, max: 8 });
    const leads = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => searchLead(n));
    let inFlight = 0;
    let peak = 0;
    const { ctx } = setup([batch(...leads)]);
    ctx.fetchLink = async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { status: 200, finalUrl: url, contentType: "text/html", body: "<p>Open</p>" };
    };
    const run = await runSearch(ctx, "manual");
    expect(peak).toBe(5);
    expect(run.accepted).toBe(8);
  });
});

// --- prompt input -------------------------------------------------------------------------------

describe("prompt input", () => {
  it("the prompt input lists every seen company name and alias, grouped", async () => {
    // AC-10.3
    await seedSettings({ min: 1, max: 2 });
    const { ctx, fake } = setup([batch(searchLead(9))]);
    await seedLead(ctx, 1);
    await seedLead(ctx, 2);
    await seedLead(ctx, 3);
    const byName = async (name: string) => prisma.company.findFirstOrThrow({ where: { name } });
    const [one, two, three] = [
      await byName("Seen 1"),
      await byName("Seen 2"),
      await byName("Seen 3"),
    ];
    await prisma.company.update({ where: { id: one.id }, data: { aliases: ["Seen One Labs"] } });
    const group = await prisma.company.create({
      data: { name: "Holding", normalizedName: "holding", createdSource: "manual" },
    });
    // Seen 2 and Seen 3 are one corporate group; the group's other member has no lead of its own.
    await prisma.company.update({ where: { id: two.id }, data: { groupId: group.id } });
    await prisma.company.update({ where: { id: three.id }, data: { groupId: group.id } });
    await prisma.company.create({
      data: { name: "Never Reported", normalizedName: "never reported", createdSource: "manual" },
    });

    await runSearch(ctx, "manual");

    const input = fake.calls[0]?.input as SearchInput;
    expect(input.exclusions).toEqual([
      { names: ["Holding", "Seen 2", "Seen 3"] },
      { names: ["Seen 1", "Seen One Labs"] },
    ]);
    expect(input).toMatchObject({
      brief: BRIEF,
      today: "2026-10-01",
      homeCountry: "MX",
      wanted: 2,
      round: 1,
      excludedSeniorities: DEFAULT_SETTINGS.search.excludedSeniorities,
      tracks: DEFAULT_SETTINGS.search.tracks,
    });
  });

  it("passes the run id to the model call so its cost is recorded against the run", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { ctx } = setup([batch(searchLead(1))]);
    const run = await runSearch(ctx, "manual");
    expect(await prisma.llmCall.count({ where: { searchRunId: run.id, purpose: "search" } })).toBe(
      1,
    );
  });
});

// --- the run record -----------------------------------------------------------------------------

describe("run record", () => {
  it("records returned, accepted, suppressed, duplicates, dead, web search calls and cost", async () => {
    // AC-10.5
    await seedSettings({ min: 1, max: 5 });
    const { ctx, fake } = setup(
      [
        batch(
          searchLead(1),
          searchLead(2, { jobUrl: null }),
          searchLead(3),
          searchLead(4, { eligible: "no", eligibilityReason: "needs on-site presence" }),
          searchLead(5, { jobUrl: "https://careers.seen1.example/jobs/1" }),
        ),
      ],
      { "https://careers.company3.example/jobs/3": { status: 404 } },
    );
    await seedLead(ctx, 1);
    // A priced call, as the real provider records: 3 web searches + tokens.
    const usage: LlmUsage = {
      model: "gpt-6-luna",
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 500,
      webSearchCalls: 3,
      latencyMs: 10,
      requestId: null,
    };
    ctx.llm = withSearch(fake, (input) => {
      return fake.search(input).then(async (result) => {
        await recordLlmCall(
          prisma,
          { purpose: "search", usage, status: "ok", errorCode: null, searchRunId: await runId() },
          {
            pricing: ctx.env.aiPricing,
            webSearchCostPerCallMicros: ctx.env.webSearchCostPerCallMicros,
          },
        );
        return result;
      });
    });

    const run = await runSearch(ctx, "manual");

    // returned 5; no link 1; dead 1; duplicate 1; ineligible → suppressed 1; accepted 1.
    expect(run).toMatchObject({
      status: "succeeded",
      returned: 5,
      accepted: 1,
      suppressed: 1,
      duplicates: 1,
      dead: 1,
      webSearchCalls: 3,
      // 1000 × 1 + 500 × 4 + 3 × 10000 = 33000 micro-dollars (+ the fake call's 0).
      costMicros: 33_000,
    });
    const stored = await prisma.searchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.costMicros).toBe(33_000n);
    // Dead is also on the batch, next to the other counts.
    const batchRow = await prisma.intakeBatch.findFirstOrThrow({ where: { searchRunId: run.id } });
    expect(batchRow.counts).toMatchObject({ accepted: 1, suppressed: 1, duplicates: 1, dead: 1 });
  });

  it("partial when min isn't reached; a failed round after accepted leads → partial; a failed first round → failed", async () => {
    // Not reached: round 2 repeats round 1.
    await seedSettings({ min: 3, max: 4 });
    const a = setup([batch(searchLead(1)), batch(searchLead(1))]);
    expect(await runSearch(a.ctx, "manual")).toMatchObject({ status: "partial", error: null });

    // A failed round after accepted leads.
    await resetDb(prisma);
    await seedSettings({ min: 3, max: 4 });
    const b = setup([batch(searchLead(1))]);
    b.ctx.llm = withSearch(b.fake, (_input, call) =>
      call === 2 ? Promise.reject(searchFailure()) : null,
    );
    const partial = await runSearch(b.ctx, "manual");
    expect(partial).toMatchObject({ status: "partial", rounds: 2, accepted: 1 });
    expect(partial.error).toBe("llm_timeout: The search round timed out.");
    expect(partial.finishedAt).not.toBeNull();
    // The accepted lead stays, and its batch was finalized.
    expect(await prisma.lead.count()).toBe(1);
    expect((await prisma.intakeBatch.findFirstOrThrow()).finalizedAt).not.toBeNull();

    // A failed first round.
    await resetDb(prisma);
    await seedSettings({ min: 3, max: 4 });
    const c = setup([batch(searchLead(1))]);
    c.ctx.llm = withSearch(c.fake, () => Promise.reject(searchFailure()));
    const failed = await runSearch(c.ctx, "manual");
    expect(failed).toMatchObject({ status: "failed", rounds: 1, accepted: 0 });
    expect(failed.error).toBe("llm_timeout: The search round timed out.");
    expect(await prisma.searchRun.count({ where: { status: "running" } })).toBe(0);
  });

  it("an unexpected error ends the run as failed, with the error's name and nothing else", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { ctx, fake } = setup([batch(searchLead(1))]);
    ctx.llm = withSearch(fake, () => Promise.reject(new TypeError(`leaks ${BRIEF}`)));
    const run = await runSearch(ctx, "manual");
    expect(run).toMatchObject({ status: "failed", error: "search_error: TypeError" });
  });

  it("stores only the brief's hash", async () => {
    // AC-10.6
    await seedSettings({ min: 1, max: 2 });
    const { ctx } = setup([batch(searchLead(1))]);
    const run = await runSearch(ctx, "manual");

    const row = await prisma.searchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.briefHash).toBe(createHash("sha256").update(BRIEF).digest("hex"));
    expect(
      JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v)),
    ).not.toContain("Secret-brief-marker-9431");
    expect(JSON.stringify(run)).not.toContain("Secret-brief-marker-9431");
  });

  it("a run that finds another one running does not start", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { ctx, fake } = setup([batch(searchLead(1))]);
    await prisma.searchRun.create({
      data: { trigger: "manual", status: "running", startedAt: NOW, briefHash: "x" },
    });
    await expect(runSearch(ctx, "schedule")).rejects.toMatchObject({
      status: 409,
      code: "already_running",
    });
    expect(fake.calls).toEqual([]);
  });

  it("a running row older than 30 minutes does not block a new run", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { ctx } = setup([batch(searchLead(1))]);
    const stale = await prisma.searchRun.create({
      data: {
        trigger: "schedule",
        status: "running",
        startedAt: new Date(NOW.getTime() - 31 * 60_000),
        briefHash: "x",
      },
    });
    const run = await runSearch(ctx, "manual");
    expect(run.status).toBe("succeeded");
    expect(await prisma.searchRun.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
      status: "failed",
      error: "interrupted",
    });

    // Run now takes the same path.
    await prisma.searchRun.create({
      data: {
        trigger: "schedule",
        status: "running",
        startedAt: new Date(NOW.getTime() - 45 * 60_000),
        briefHash: "x",
      },
    });
    const queued = await requestSearchRun(ctx, "manual");
    expect(queued.status).toBe("running");
  });

  it("a run still inside its 30 minutes keeps blocking", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { ctx } = setup([batch(searchLead(1))]);
    await prisma.searchRun.create({
      data: {
        trigger: "manual",
        status: "running",
        startedAt: new Date(NOW.getTime() - 29 * 60_000),
        briefHash: "x",
      },
    });
    await expect(runSearch(ctx, "schedule")).rejects.toMatchObject({ code: "already_running" });
  });

  it("a failure before the first round closes the run as failed", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { ctx, fake } = setup([batch(searchLead(1))]);
    const row = await prisma.searchRun.create({
      data: { trigger: "manual", status: "running", startedAt: NOW, briefHash: "x" },
    });
    // Reading the settings fails; everything else reaches the real database.
    const broken = new Proxy(prisma, {
      get: (target, key) =>
        key === "setting"
          ? { findMany: () => Promise.reject(new Error("db down")) }
          : (Reflect.get(target, key) as unknown),
    });
    const run = await runSearch({ ...ctx, prisma: broken }, "manual", row.id);
    expect(run).toMatchObject({ id: row.id, status: "failed", error: "search_error: Error" });
    expect(fake.calls).toEqual([]);
    expect(await prisma.searchRun.count({ where: { status: "running" } })).toBe(0);
  });

  it("counts distinct companies for the stop check, as finalize keeps one lead per company", async () => {
    await seedSettings({ min: 2, max: 3 });
    // Round 1 returns two postings of one company: finalize will keep one, so min is not reached.
    const { ctx, fake } = setup([
      batch(
        searchLead(1),
        searchLead(1, {
          title: "Platform Engineer II",
          jobUrl: "https://careers.company1.example/jobs/11",
        }),
      ),
      batch(searchLead(2)),
    ]);
    const run = await runSearch(ctx, "manual");
    expect(fake.calls).toHaveLength(2);
    expect((fake.calls[1]?.input as SearchInput).wanted).toBe(2);
    expect(run).toMatchObject({ status: "succeeded", rounds: 2, accepted: 2 });
    expect(await prisma.lead.count({ where: { status: "new" } })).toBe(2);
  });
});

// --- stale runs and schedule --------------------------------------------------------------------

describe("markStaleRuns", () => {
  it("markStaleRuns fails runs older than 30 minutes", async () => {
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const old = await prisma.searchRun.create({
      data: { trigger: "schedule", status: "running", startedAt: minutesAgo(31), briefHash: "x" },
    });
    // The partial unique index allows one running row, so the recent one comes after the sweep.
    const count = await markStaleRuns(prisma, NOW);
    expect(count).toBe(1);
    const row = await prisma.searchRun.findUniqueOrThrow({ where: { id: old.id } });
    expect(row).toMatchObject({ status: "failed", error: "interrupted" });
    expect(row.finishedAt).toEqual(NOW);

    const recent = await prisma.searchRun.create({
      data: { trigger: "manual", status: "running", startedAt: minutesAgo(10), briefHash: "x" },
    });
    expect(await markStaleRuns(prisma, NOW)).toBe(0);
    expect((await prisma.searchRun.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe(
      "running",
    );
  });
});

describe("registerSearchSchedule", () => {
  it("registerSearchSchedule schedules '0 7 * * *' in America/Monterrey when enabled and unschedules when disabled", async () => {
    const queue = testWorkerCtx().queue;
    await registerSearchSchedule(
      queue,
      { ...DEFAULT_SETTINGS.search, enabled: true },
      "America/Monterrey",
    );
    expect(queue.schedules).toEqual([
      { name: "search.run", cron: "0 7 * * *", tz: "America/Monterrey" },
    ]);

    await registerSearchSchedule(
      queue,
      { ...DEFAULT_SETTINGS.search, enabled: false },
      "America/Monterrey",
    );
    expect(queue.schedules).toEqual([]);
    expect(queue.unscheduled).toEqual(["search.run"]);
  });

  it("uses the minute and hour of the run time", async () => {
    const queue = testWorkerCtx().queue;
    await registerSearchSchedule(
      queue,
      { ...DEFAULT_SETTINGS.search, enabled: true, runTime: "18:05" },
      "America/Monterrey",
    );
    expect(queue.schedules[0]?.cron).toBe("5 18 * * *");
  });
});

// --- worker start ---------------------------------------------------------------------------------

describe("worker start", () => {
  it("fails interrupted runs and registers the daily search when enabled", async () => {
    await seedSettings({ min: 1, max: 2 });
    const stale = await prisma.searchRun.create({
      data: {
        trigger: "schedule",
        status: "running",
        startedAt: new Date(NOW.getTime() - 40 * 60_000),
        briefHash: "x",
      },
    });
    const worker = await startWorker(testWorkerCtx({ clock: () => NOW }));
    try {
      const rows = await prisma.$queryRaw<{ name: string; cron: string; timezone: string }[]>`
        select name, cron, timezone from pgboss.schedule where name = 'search.run'`;
      expect(rows).toEqual([
        { name: "search.run", cron: "0 7 * * *", timezone: "America/Monterrey" },
      ]);
      expect(await prisma.searchRun.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
        status: "failed",
        error: "interrupted",
      });
    } finally {
      await worker.stop();
      await prisma.$executeRaw`delete from pgboss.schedule where name = 'search.run'`;
    }
  });
});

// --- routes and the job -------------------------------------------------------------------------

describe("search routes and job", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appWithQueue(overrides: Parameters<typeof buildTestApp>[0] = {}) {
    const built = await buildTestApp({ clock: () => NOW, ...overrides });
    apps.push(built.app);
    const cookie = await signIn(built.app, built.deps);
    const call = (method: "GET" | "POST", url: string) =>
      built.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { cookie, "x-offerbound-request": "1" },
      });
    return { ...built, call, queue: built.deps.queue as RecordingQueue };
  }

  it("a second Run now while one runs → 409 already_running", async () => {
    // AC-10.2
    await seedSettings({ min: 1, max: 2 });
    const { call, queue } = await appWithQueue();

    const first = await call("POST", "/search/run");
    expect(first.statusCode).toBe(202);
    expect(SearchRunSchema.parse(first.json())).toMatchObject({
      trigger: "manual",
      status: "running",
      rounds: 0,
    });
    expect(queue.sent).toEqual([
      {
        name: "search.run",
        data: { runId: first.json<{ id: string }>().id, trigger: "manual" },
        opts: {},
      },
    ]);

    const second = await call("POST", "/search/run");
    expect(second.statusCode).toBe(409);
    expect(second.json<ApiErrorBody>().error.code).toBe("already_running");
    expect(queue.sent).toHaveLength(1);
    expect(await prisma.searchRun.count()).toBe(1);
  });

  it("a Run now whose job cannot be queued ends the run as failed and frees the next one", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { call, queue } = await appWithQueue();
    queue.failSendWith = new Error("queue down");

    const res = await call("POST", "/search/run");
    expect(res.statusCode).toBe(500);
    const row = await prisma.searchRun.findFirstOrThrow();
    expect(row).toMatchObject({ status: "failed", error: "could not queue the search" });

    queue.failSendWith = null;
    expect((await call("POST", "/search/run")).statusCode).toBe(202);
  });

  it("the queued job runs the run that Run now created", async () => {
    await seedSettings({ min: 1, max: 2 });
    const { call, queue, deps } = await appWithQueue();
    const created = (await call("POST", "/search/run")).json<{ id: string }>();

    const { ctx } = setup([batch(searchLead(1))]);
    const job = queue.sent[0];
    const handler = HANDLERS[QUEUES.searchRun];
    expect(handler).toBeDefined();
    await handler?.(
      { ...ctx, prisma: deps.prisma },
      { data: job?.data ?? {}, retryCount: 0, retryLimit: 0 },
    );

    const row = await prisma.searchRun.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ status: "succeeded", accepted: 1, trigger: "manual" });
    expect(await prisma.searchRun.count()).toBe(1);
  });

  it("a scheduled job starts a scheduled run, skips quietly while one runs, and skips when disabled", async () => {
    const { ctx } = setup([batch(searchLead(1)), batch(searchLead(2))]);
    const handler = HANDLERS[QUEUES.searchRun];
    const job = { data: {}, retryCount: 0, retryLimit: 0 };

    // Disabled in settings: a stale schedule does nothing.
    await saveSettings(prisma, {
      ...settingsWith({ min: 1, max: 2 }),
      search: { ...settingsWith({ min: 1, max: 2 }).search, enabled: false },
    });
    await handler?.(ctx, job);
    expect(await prisma.searchRun.count()).toBe(0);

    await seedSettings({ min: 1, max: 2 });
    await handler?.(ctx, job);
    expect(await prisma.searchRun.findFirstOrThrow()).toMatchObject({
      trigger: "schedule",
      status: "succeeded",
    });

    await prisma.searchRun.create({
      data: { trigger: "manual", status: "running", startedAt: NOW, briefHash: "x" },
    });
    await expect(handler?.(ctx, job)).resolves.toBeUndefined();
    expect(await prisma.searchRun.count()).toBe(2);
  });

  it("GET /search/runs lists the last 14 runs, newest first", async () => {
    const { call } = await appWithQueue();
    for (let i = 0; i < 16; i += 1) {
      await prisma.searchRun.create({
        data: {
          trigger: "schedule",
          status: "succeeded",
          startedAt: new Date(NOW.getTime() - i * 3_600_000),
          finishedAt: NOW,
          briefHash: "x",
          accepted: i,
          costMicros: 1_250n,
        },
      });
    }
    const res = await call("GET", "/search/runs");
    expect(res.statusCode).toBe(200);
    const runs = SearchRunSchema.array().parse(res.json());
    expect(runs).toHaveLength(14);
    expect(runs.map((r) => r.accepted)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(runs[0]).toMatchObject({ costMicros: 1250, startedAt: NOW.toISOString() });
  });

  it("needs a session", async () => {
    const built = await buildTestApp();
    apps.push(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: "/api/v1/search/runs",
    });
    expect(res.statusCode).toBe(401);
  });
});

// Resolves the id of the run that is running now (the model call has no handle on it).
async function runId(): Promise<string> {
  return (await prisma.searchRun.findFirstOrThrow({ where: { status: "running" } })).id;
}
