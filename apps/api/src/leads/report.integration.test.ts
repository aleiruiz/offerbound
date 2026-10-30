import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  MAX_REPORT_CHARS,
  ReportCommitResultSchema,
  ReportPreviewSchema,
  type ReportLead,
  type ReportPreview,
} from "@offerbound/contracts";
import { jobKey, normalizeCompanyName } from "@offerbound/domain";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import type { RecordingQueue } from "../../test/queue.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { LlmError } from "../llm/provider.js";
import { QUEUES } from "../jobs/queues.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const NOW = new Date("2026-10-01T12:00:00.000Z");
const REPORT = "pasted report text for the fake model";

let now = NOW;
let app: FastifyInstance;
let cookie: string;
let queue: RecordingQueue;
let llm: FakeLlmProvider;
let logs: string[];

beforeEach(async () => {
  await resetDb(prisma);
  now = NOW;
  logs = [];
  llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
  const logStream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const built = await buildTestApp({ clock: () => now, llm }, { logStream });
  app = built.app;
  queue = built.deps.queue as RecordingQueue;
  cookie = await signIn(app, built.deps);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const lead = (over: Partial<ReportLead> = {}): ReportLead => ({
  company: "Northwind Labs",
  companyDomain: null,
  title: "Backend Engineer",
  jobUrl: "https://careers.northwind.example/jobs/1",
  locationText: "Remote, Mexico",
  country: "MX",
  workMode: "remote",
  compensationText: null,
  postedAt: null,
  seniority: "senior",
  ...over,
});

function post(url: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/v1${url}`,
    headers: { ...CSRF, cookie },
    payload: payload as object,
  });
}

/** Registers what the fake model answers for `text`, then asks for the preview. */
async function previewOf(leads: ReportLead[], text = REPORT): Promise<ReportPreview> {
  llm.register("parse_report", text, { leads });
  const res = await post("/leads/import/preview", { text });
  expect(res.statusCode).toBe(200);
  return ReportPreviewSchema.parse(res.json());
}

const errorOf = (res: { json: () => unknown }) => ApiErrorBodySchema.parse(res.json()).error;

/** A company with a lead, as if an earlier search or alert had found it. */
async function seedSeenCompany(name: string, jobUrl: string | null, aliases: string[] = []) {
  const company = await prisma.company.create({
    data: {
      name,
      normalizedName: normalizeCompanyName(name),
      aliases,
      createdSource: "gmail",
      createdAt: now,
    },
  });
  const batch = await prisma.intakeBatch.create({ data: { kind: "gmail_message", counts: {} } });
  await prisma.lead.create({
    data: {
      companyId: company.id,
      intakeBatchId: batch.id,
      title: "Older role",
      jobUrl,
      jobKey: jobUrl === null ? null : jobUrl.replace("https://", ""),
      status: "new",
      statusChangedAt: now,
      pipelineState: "ready",
      source: "gmail_alert",
      foundAt: now,
    },
  });
  return company;
}

describe("POST /leads/import/preview", () => {
  it("annotates each row by dry-running planIntake", async () => {
    await seedSeenCompany("Acme Robotics", "https://careers.acme.example/jobs/9");
    const existingUrl = "https://careers.known.example/jobs/5";
    const known = await seedSeenCompany("Known Co", existingUrl);
    await prisma.lead.updateMany({
      where: { companyId: known.id },
      data: { jobKey: jobKey(existingUrl) },
    });

    const preview = await previewOf([
      lead({ company: "Fresh Startup", jobUrl: "https://jobs.fresh.example/1" }),
      lead({ company: "Acme Robotics", jobUrl: "https://careers.acme.example/jobs/10" }),
      lead({ company: "Known Co", title: "Same posting", jobUrl: existingUrl }),
      lead({
        company: "Staffy Inc",
        jobUrl: "https://jobs.staffy.example/2",
        seniority: "staff_plus",
      }),
      // The same posting twice in one report: the first row wins.
      lead({ company: "Twice Ltd", jobUrl: "https://jobs.twice.example/3" }),
      lead({ company: "Twice Ltd", title: "Repeat", jobUrl: "https://jobs.twice.example/3" }),
    ]);

    expect(preview.rows.map((r) => [r.lead.company, r.annotation])).toEqual([
      ["Fresh Startup", "new"],
      ["Acme Robotics", "company_already_seen"],
      ["Known Co", "duplicate"],
      ["Staffy Inc", "excluded_seniority"],
      ["Twice Ltd", "new"],
      ["Twice Ltd", "duplicate"],
    ]);
    expect(new Set(preview.rows.map((r) => r.rowId)).size).toBe(6);
    expect(preview.expiresAt).toBe(new Date(NOW.getTime() + 60 * 60 * 1000).toISOString());
  });

  it("writes only the preview row: no lead, company or batch", async () => {
    await previewOf([lead({ company: "Fresh Startup" })]);
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.company.count()).toBe(0);
    expect(await prisma.intakeBatch.count()).toBe(0);
    expect(await prisma.importPreview.count({ where: { kind: "paste_report" } })).toBe(1);
    expect(queue.sent).toHaveLength(0);
  });

  it("text over 50,000 characters → 413", async () => {
    const res = await post("/leads/import/preview", { text: "x".repeat(MAX_REPORT_CHARS + 1) });
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).code).toBe("too_large");
    // Exactly at the cap is fine.
    const ok = await post("/leads/import/preview", { text: "x".repeat(MAX_REPORT_CHARS) });
    expect(ok.statusCode).toBe(200);
  });

  it("an empty text → 400 validation_failed", async () => {
    for (const text of ["", "   \n "]) {
      const res = await post("/leads/import/preview", { text });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: "validation_failed",
        fields: { text: "required" },
      });
    }
    expect((await post("/leads/import/preview", {})).statusCode).toBe(400);
  });

  it("bounds what the model returned: one line, no control characters, http links only", async () => {
    const preview = await previewOf([
      lead({
        company: "  Zero​width‮ Co\n",
        title: "Line one\nLine two\t" + "t".repeat(500),
        jobUrl: "javascript:alert(1)",
        companyDomain: "not a domain!",
        postedAt: "not a date",
      }),
      lead({ company: "   ", title: "No company" }),
      lead({ company: "No title", title: "​" }),
      lead({ company: "Good Co", jobUrl: "http://jobs.good.example/a", postedAt: "2026-09-30" }),
    ]);
    expect(preview.rows).toHaveLength(2);
    const [first, second] = preview.rows;
    expect(first?.lead.company).toBe("Zerowidth Co");
    expect(first?.lead.title.startsWith("Line one Line two ttt")).toBe(true);
    expect(first?.lead.title).toHaveLength(300);
    expect(first?.lead).toMatchObject({ jobUrl: null, companyDomain: null, postedAt: null });
    expect(second?.lead).toMatchObject({
      jobUrl: "http://jobs.good.example/a",
      postedAt: "2026-09-30",
    });
  });

  it("a model failure → 502 upstream_error, and nothing from the text reaches the logs", async () => {
    const secret = "SECRET-REPORT-CONTENT-9f3a";
    llm.failNext("parse_report", new LlmError("upstream", `echoed ${secret}`, { retryable: true }));
    const res = await post("/leads/import/preview", { text: `Role at ${secret}` });
    expect(res.statusCode).toBe(502);
    expect(errorOf(res).code).toBe("upstream_error");
    expect(res.body).not.toContain(secret);
    expect(logs.join("")).not.toContain(secret);
    expect(await prisma.importPreview.count()).toBe(0);
  });

  it("needs a session and the CSRF header", async () => {
    const noCookie = await app.inject({
      method: "POST",
      url: "/api/v1/leads/import/preview",
      headers: CSRF,
      payload: { text: REPORT },
    });
    expect(noCookie.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/leads/import/preview",
      headers: { cookie },
      payload: { text: REPORT },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("POST /leads/import/commit", () => {
  it("commit creates only the kept rows", async () => {
    const preview = await previewOf([
      lead({ company: "Fresh Startup", jobUrl: "https://jobs.fresh.example/1" }),
      lead({ company: "Second Co", jobUrl: "https://jobs.second.example/1" }),
      lead({ company: "Third Co", jobUrl: "https://jobs.third.example/1" }),
    ]);
    const keep = [preview.rows[0]?.rowId ?? "", preview.rows[2]?.rowId ?? ""];

    const res = await post("/leads/import/commit", {
      previewId: preview.previewId,
      keepRowIds: keep,
    });
    expect(res.statusCode).toBe(202);
    const { batchId } = ReportCommitResultSchema.parse(res.json());

    const batch = await prisma.intakeBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.kind).toBe("paste_report");
    expect(batch.counts).toMatchObject({ received: 2, accepted: 2 });

    const leads = await prisma.lead.findMany({
      where: { intakeBatchId: batchId },
      include: { company: true },
      orderBy: { createdAt: "asc" },
    });
    expect(leads.map((l) => l.company.name)).toEqual(["Fresh Startup", "Third Co"]);
    expect(leads.every((l) => l.source === "paste_report" && l.pipelineState === "checking")).toBe(
      true,
    );
    expect(await prisma.company.count()).toBe(2);

    // One lead_created event per lead, and a link check queued for each.
    const events = await prisma.event.findMany({ where: { type: "lead_created" } });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor === "import" && !e.undoable)).toBe(true);
    const checks = queue.sent.filter((m) => m.name === QUEUES.leadsCheck);
    expect(checks.map((m) => (m.data as { leadId: string }).leadId).sort()).toEqual(
      leads.map((l) => l.id).sort(),
    );

    // The preview is used up.
    expect(await prisma.importPreview.count()).toBe(0);
    const again = await post("/leads/import/commit", {
      previewId: preview.previewId,
      keepRowIds: keep,
    });
    expect(again.statusCode).toBe(404);
  });

  it("intake runs again at commit: a company seen since the preview is set aside", async () => {
    const preview = await previewOf([
      lead({ company: "Late Seen Co", jobUrl: "https://jobs.late.example/1" }),
    ]);
    expect(preview.rows[0]?.annotation).toBe("new");
    await seedSeenCompany("Late Seen Co", "https://jobs.late.example/other");

    const res = await post("/leads/import/commit", {
      previewId: preview.previewId,
      keepRowIds: [preview.rows[0]?.rowId],
    });
    expect(res.statusCode).toBe(202);
    const stored = await prisma.lead.findFirstOrThrow({ where: { source: "paste_report" } });
    expect(stored).toMatchObject({
      status: "suppressed",
      suppressedReason: "company_already_seen",
    });
    expect(queue.sent.filter((m) => m.name === QUEUES.leadsCheck)).toHaveLength(0);
  });

  it("an expired preview → 404", async () => {
    const preview = await previewOf([lead()]);
    now = new Date(NOW.getTime() + 60 * 60 * 1000);
    const res = await post("/leads/import/commit", {
      previewId: preview.previewId,
      keepRowIds: [preview.rows[0]?.rowId],
    });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe("not_found");
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.intakeBatch.count()).toBe(0);
  });

  it("an unknown preview, or a sheet preview, → 404", async () => {
    const sheet = await prisma.importPreview.create({
      data: {
        kind: "sheet_csv",
        payload: { rows: [], errors: [] },
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    for (const previewId of ["not-a-uuid", "00000000-0000-4000-8000-000000000000", sheet.id]) {
      const res = await post("/leads/import/commit", { previewId, keepRowIds: ["r1"] });
      expect(res.statusCode).toBe(404);
    }
    expect(await prisma.importPreview.count({ where: { id: sheet.id } })).toBe(1);
  });

  it("a row id the preview does not hold → 400, nothing is written and the preview stays", async () => {
    const preview = await previewOf([lead()]);
    const res = await post("/leads/import/commit", {
      previewId: preview.previewId,
      keepRowIds: [preview.rows[0]?.rowId, "00000000-0000-4000-8000-000000000000"],
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ code: "validation_failed" });
    expect(await prisma.intakeBatch.count()).toBe(0);
    expect(await prisma.importPreview.count()).toBe(1);
  });

  it("keeping no rows → 400", async () => {
    const preview = await previewOf([lead()]);
    const res = await post("/leads/import/commit", {
      previewId: preview.previewId,
      keepRowIds: [],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /companies/exclusion-list", () => {
  const get = () =>
    app.inject({ method: "GET", url: "/api/v1/companies/exclusion-list", headers: { cookie } });

  it("the exclusion list includes aliases", async () => {
    await seedSeenCompany("Acme Robotics", null, ["Acme", "Acme Inc"]);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe("Acme Robotics\n  Acme\n  Acme Inc\n");
  });

  it("lists group members, newest first, and cleans names", async () => {
    const at = (day: number) => new Date(Date.UTC(2026, 8, day));
    const old = await seedSeenCompany("Oldest Co", null);
    await prisma.company.update({ where: { id: old.id }, data: { createdAt: at(1) } });
    const parent = await seedSeenCompany("Parent Holdings", null, ["Parent"]);
    await prisma.company.update({ where: { id: parent.id }, data: { createdAt: at(10) } });
    // A subsidiary with no lead of its own is listed because its group was seen.
    await prisma.company.create({
      data: {
        name: "Child​ Brand\n",
        normalizedName: "child brand",
        groupId: parent.id,
        createdSource: "manual",
        createdAt: at(5),
      },
    });
    // A company that was never seen is not listed.
    await prisma.company.create({
      data: { name: "Never Seen", normalizedName: "never seen", createdSource: "manual" },
    });

    const res = await get();
    expect(res.body).toBe("Parent Holdings\n  Parent\nChild Brand\nOldest Co\n");
  });

  it("is empty before anything was seen, and needs a session", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    const anon = await app.inject({ method: "GET", url: "/api/v1/companies/exclusion-list" });
    expect(anon.statusCode).toBe(401);
  });
});
