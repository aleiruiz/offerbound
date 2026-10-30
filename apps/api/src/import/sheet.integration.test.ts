import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  ImportSummarySchema,
  SheetPreviewSchema,
  type ImportSummary,
  type SheetPreview,
} from "@offerbound/contracts";
import { jobKey, normalizeCompanyName } from "@offerbound/domain";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { testWorkerCtx } from "../../test/worker.js";
import { withIntakeLock } from "../db/lock.js";
import { QUEUES } from "../jobs/queues.js";
import { RecordingQueue } from "../../test/queue.js";
import { commitSheet, MAX_SHEET_BYTES } from "./sheet.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const NOW = new Date("2026-10-01T12:00:00.000Z");
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

function multipart(
  content: Buffer,
  field = "file",
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----offerbound-test-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="applications.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { ...CSRF, "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

let app: FastifyInstance;
let cookie: string;
let queue: RecordingQueue;

beforeEach(async () => {
  await resetDb(prisma);
  const built = await buildTestApp({ clock: () => NOW });
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

function upload(content: Buffer, field = "file") {
  const { payload, headers } = multipart(content, field);
  return app.inject({
    method: "POST",
    url: "/api/v1/import/sheet/preview",
    headers: { ...headers, cookie },
    payload,
  });
}

async function preview(content: Buffer): Promise<SheetPreview> {
  const res = await upload(content);
  expect(res.statusCode).toBe(200);
  return SheetPreviewSchema.parse(res.json());
}

function commit(previewId: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/import/sheet/commit",
    headers: { ...CSRF, cookie },
    payload: { previewId },
  });
}

async function commitOk(previewId: string): Promise<ImportSummary> {
  const res = await commit(previewId);
  expect(res.statusCode).toBe(201);
  return ImportSummarySchema.parse(res.json());
}

function errorCode(res: { json: () => unknown }): string {
  return ApiErrorBodySchema.parse(res.json()).error.code;
}

const csv = (rows: string[]): Buffer =>
  Buffer.from(
    [
      "Company,Role,Country,City / modality,Date applied,Status,Salary,Sponsorship / relocation,Job link,Notes",
      ...rows,
    ].join("\n"),
  );

/** A company with one application, as if Gmail sync had already made it. */
async function seedApplication(company: string, title: string): Promise<string> {
  const row = await prisma.company.create({
    data: {
      name: company,
      normalizedName: normalizeCompanyName(company),
      createdSource: "gmail",
    },
  });
  await prisma.application.create({
    data: {
      companyId: row.id,
      title,
      status: "applied",
      statusChangedAt: NOW,
      source: "gmail",
    },
  });
  return row.id;
}

async function seedLead(company: string, title: string, url: string): Promise<void> {
  const row = await prisma.company.create({
    data: { name: company, normalizedName: normalizeCompanyName(company), createdSource: "manual" },
  });
  const batch = await prisma.intakeBatch.create({
    data: {
      kind: "manual",
      counts: { received: 1, duplicates: 0, suppressed: 0, dead: 0, accepted: 1 },
    },
  });
  await prisma.lead.create({
    data: {
      companyId: row.id,
      intakeBatchId: batch.id,
      title,
      jobUrl: url,
      jobKey: jobKey(url),
      statusChangedAt: NOW,
      source: "manual",
    },
  });
}

async function recordCounts() {
  return {
    applications: await prisma.application.count(),
    leads: await prisma.lead.count(),
    companies: await prisma.company.count(),
    batches: await prisma.intakeBatch.count(),
    events: await prisma.event.count(),
  };
}

describe("POST /import/sheet/preview", () => {
  it("the preview counts each target, lists row errors and in-file duplicates, and writes no records", async () => {
    const body = await preview(fixture("sample.csv"));

    expect(body.totalRows).toBe(9);
    expect(body.mappings).toEqual([
      { sheetStatus: "to_research", target: "lead_new", rows: 1 },
      { sheetStatus: "cancelled", target: "lead_dismissed", rows: 1 },
      { sheetStatus: "applied", target: "application_applied", rows: 1 },
      { sheetStatus: "interview", target: "application_interviewing", rows: 1 },
      { sheetStatus: "rejected", target: "application_rejected", rows: 1 },
    ]);
    expect(body.errors.map((e) => e.line)).toEqual([7, 8]);
    expect(body.errors[0]?.message).toContain("YYYY-MM-DD");
    expect(body.duplicatesInFile).toEqual([
      { line: 9, duplicateOfLine: 2, company: "Alder Works Example", role: "backend engineer" },
      { line: 10, duplicateOfLine: 3, company: "Hazel Health Example", role: "Backend Engineer" },
    ]);
    expect(body.existingMatches).toBe(0);
    expect(new Date(body.expiresAt).getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);

    expect(await recordCounts()).toEqual({
      applications: 0,
      leads: 0,
      companies: 0,
      batches: 0,
      events: 0,
    });
    expect(await prisma.importPreview.count()).toBe(1);
    expect(queue.sent).toEqual([]);
  });

  it("a file over 2 MB → 413 too_large", async () => {
    const big = Buffer.concat([fixture("sample.csv"), Buffer.alloc(MAX_SHEET_BYTES, 0x20)]);
    const res = await upload(big);
    expect(res.statusCode).toBe(413);
    expect(errorCode(res)).toBe("too_large");
    expect(await prisma.importPreview.count()).toBe(0);
  });

  it("a file with no Company, Role and Status header → 400 validation_failed", async () => {
    const res = await upload(fixture("no-header.csv"));
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe("validation_failed");
  });

  it("a request without a file field → 400 validation_failed", async () => {
    const { payload, headers } = multipart(fixture("sample.csv"), "document");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/import/sheet/preview",
      headers: { ...headers, cookie },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("a request that is not multipart → 400 validation_failed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/import/sheet/preview",
      headers: { ...CSRF, cookie },
      payload: { file: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe("validation_failed");
  });

  it("without a session → 401", async () => {
    const { payload, headers } = multipart(fixture("sample.csv"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/import/sheet/preview",
      headers,
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("the CV upload still takes its larger files", async () => {
    // Both routes register an upload plugin; the 2 MB cap here must not leak into /cv.
    const { payload, headers } = multipart(Buffer.alloc(3 * 1024 * 1024, 0x20));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv",
      headers: { ...headers, cookie },
      payload,
    });
    expect(res.statusCode).not.toBe(413);
  });
});

describe("POST /import/sheet/commit", () => {
  it("writes applications with imported events and leads with lead_created events", async () => {
    const body = await preview(fixture("sample.csv"));
    const summary = await commitOk(body.previewId);
    expect(summary).toEqual({
      applicationsCreated: 3,
      leadsCreated: 1,
      leadsDismissed: 1,
      skippedExisting: 0,
      skippedDuplicateRows: 2,
      errorRows: 2,
    });

    const apps = await prisma.application.findMany({
      include: { company: true },
      orderBy: { title: "asc" },
    });
    expect(apps.map((a) => [a.company.name, a.status, a.source])).toEqual([
      ["Alder Works Example", "applied", "sheet_import"],
      ["Cedar Robotics Example", "rejected", "sheet_import"],
      ["Birch Systems Example", "interviewing", "sheet_import"],
    ]);
    const alder = apps[0];
    expect(alder).toMatchObject({
      title: "Backend Engineer",
      country: "Mexico",
      locationText: "Remote",
      workMode: "remote",
      notes: "Sent via referral",
      jobKey: jobKey("https://boards.greenhouse.io/alderworks/jobs/1001"),
    });
    expect(alder?.appliedAt?.toISOString()).toBe("2026-10-05T06:00:00.000Z");
    expect(apps[1]?.appliedAt?.toISOString()).toBe("2026-09-02T06:00:00.000Z");
    expect(apps[1]?.workMode).toBe("onsite");
    expect(apps[2]).toMatchObject({
      compensationText: "CAD 120k",
      sponsorshipText: "Visa sponsorship offered",
      workMode: "hybrid",
    });

    const imported = await prisma.event.findMany({ where: { type: "imported" } });
    expect(imported).toHaveLength(3);
    expect(imported.every((e) => e.actor === "import" && !e.undoable)).toBe(true);
    expect(new Set(imported.map((e) => e.applicationId))).toEqual(new Set(apps.map((a) => a.id)));

    const leads = await prisma.lead.findMany({ orderBy: { title: "asc" } });
    expect(leads.map((l) => [l.title, l.status, l.pipelineState, l.dismissedReason])).toEqual([
      ["Analytics Engineer", "new", "checking", null],
      ["Staff Engineer", "dismissed", "ready", "not_pursued_imported"],
    ]);
    expect(leads.every((l) => l.source === "sheet_import")).toBe(true);
    const created = await prisma.event.findMany({ where: { type: "lead_created" } });
    expect(created).toHaveLength(2);
    expect(created.every((e) => e.actor === "import" && !e.undoable && e.leadId !== null)).toBe(
      true,
    );

    const batch = await prisma.intakeBatch.findFirstOrThrow();
    expect(batch.kind).toBe("sheet_import");
    expect(batch.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await prisma.importPreview.count()).toBe(0);
  });

  it("imported records skip the company-seen and one-per-company rules; New leads go to checking; Dismissed leads and applications don't", async () => {
    // Dune already has an application, so a lead there would be "company already seen" elsewhere.
    await seedApplication("Dune Analytics Example", "Support Engineer");
    const body = await preview(
      csv([
        "Dune Analytics Example,Analytics Engineer,Mexico,Remote,,To research,,,https://jobs.ashbyhq.com/duneanalytics/9f9f,",
        "Dune Analytics Example,Data Scientist,Mexico,Remote,,To research,,,https://jobs.ashbyhq.com/duneanalytics/1a1a,",
        "Elm Payments Example,Staff Engineer,USA,Remote,,Cancelled,,,https://jobs.lever.co/elmpayments/bbbb-2222,",
        "Fir Logistics Example,SRE,Mexico,Remote,2026-09-01,Applied,,,,",
      ]),
    );
    await commitOk(body.previewId);

    const leads = await prisma.lead.findMany({ orderBy: { title: "asc" } });
    expect(leads.map((l) => [l.title, l.status, l.pipelineState, l.suppressedReason])).toEqual([
      ["Analytics Engineer", "new", "checking", null],
      ["Data Scientist", "new", "checking", null],
      ["Staff Engineer", "dismissed", "ready", null],
    ]);
    const batch = await prisma.intakeBatch.findFirstOrThrow();
    const checks = queue.sent.filter((s) => s.name === QUEUES.leadsCheck);
    expect(
      checks.map((s) => s.data).sort((a, b) => String(a.leadId).localeCompare(String(b.leadId))),
    ).toEqual(
      leads
        .filter((l) => l.status === "new")
        .map((l) => ({ leadId: l.id, batchId: batch.id }))
        .sort((a, b) => a.leadId.localeCompare(b.leadId)),
    );
    // A sheet batch is never finalized.
    expect(queue.sent.some((s) => s.name === QUEUES.leadsFinalize)).toBe(false);
    expect(await prisma.application.count()).toBe(2);
  });

  it("an unknown preview → 404 not_found", async () => {
    const res = await commit("5f1c1a52-6d5e-4e55-9a31-7d9d3c0c2f10");
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe("not_found");
  });

  it("a malformed preview id → 404 not_found", async () => {
    const res = await commit("not-a-uuid");
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe("not_found");
  });

  it("an expired preview → 404 not_found and writes nothing", async () => {
    const body = await preview(fixture("sample.csv"));
    await prisma.importPreview.update({
      where: { id: body.previewId },
      data: { expiresAt: new Date(NOW.getTime() - 1000) },
    });
    const res = await commit(body.previewId);
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe("not_found");
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.intakeBatch.count()).toBe(0);
  });

  it("a preview commits once; the second commit → 404 not_found", async () => {
    const body = await preview(fixture("sample.csv"));
    await commitOk(body.previewId);
    const again = await commit(body.previewId);
    expect(again.statusCode).toBe(404);
    expect(await prisma.application.count()).toBe(3);
  });

  it("the same file twice → 409 duplicate_import", async () => {
    const body = await preview(fixture("sample.csv"));
    await commitOk(body.previewId);

    const second = await upload(fixture("sample.csv"));
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe("duplicate_import");
  });

  it("two previews of one file: the second commit → 409 duplicate_import and writes nothing more", async () => {
    const first = await preview(fixture("sample.csv"));
    const second = await preview(fixture("sample.csv"));
    await commitOk(first.previewId);
    const before = await recordCounts();

    const res = await commit(second.previewId);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe("duplicate_import");
    expect(await recordCounts()).toEqual(before);
  });

  it("a sheet of applications only still records the file, so it can't be imported twice", async () => {
    const file = csv(["Fir Logistics Example,SRE,Mexico,Remote,2026-09-01,Applied,,,,"]);
    await commitOk((await preview(file)).previewId);
    expect((await upload(file)).statusCode).toBe(409);
  });

  it("rows matching existing records by job key or company + role are skipped and counted", async () => {
    await seedApplication("Alder Works Example", "Backend Engineer");
    await seedLead(
      "Somewhere Else Example",
      "Platform Engineer",
      "https://jobs.lever.co/birchsystems/aaaa-1111",
    );

    const body = await preview(fixture("sample.csv"));
    expect(body.existingMatches).toBe(2);
    expect(body.mappings.reduce((sum, m) => sum + m.rows, 0)).toBe(3);

    const summary = await commitOk(body.previewId);
    expect(summary).toEqual({
      applicationsCreated: 1,
      leadsCreated: 1,
      leadsDismissed: 1,
      skippedExisting: 2,
      skippedDuplicateRows: 2,
      errorRows: 2,
    });
    expect(await prisma.application.count()).toBe(2);
    expect(await prisma.application.count({ where: { source: "sheet_import" } })).toBe(1);
    expect(await prisma.company.findFirst({ where: { name: "Birch Systems Example" } })).toBeNull();
  });

  it("compares with the records again at commit, not as they were at preview", async () => {
    const body = await preview(
      csv(["Fir Logistics Example,SRE,Mexico,Remote,2026-09-01,Applied,,,,"]),
    );
    expect(body.existingMatches).toBe(0);
    await seedApplication("Fir Logistics Example", "sre");

    const summary = await commitOk(body.previewId);
    expect(summary.applicationsCreated).toBe(0);
    expect(summary.skippedExisting).toBe(1);
    expect(await prisma.application.count()).toBe(1);
  });

  it("an imported application reuses a company that exists, by name", async () => {
    const companyId = await seedApplication("Fir Logistics Example", "Driver");
    await commitOk(
      (await preview(csv(["Fir Logistics Example Inc.,SRE,Mexico,Remote,2026-09-01,Applied,,,,"])))
        .previewId,
    );
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.application.count({ where: { companyId } })).toBe(2);
  });

  it("a lost leads.check send still commits and the other checks go out", async () => {
    const body = await preview(
      csv([
        "Dune Analytics Example,Analytics Engineer,Mexico,Remote,,To research,,,https://jobs.ashbyhq.com/duneanalytics/9f9f,",
        "Gum Media Example,Designer,Mexico,Remote,,To research,,,https://jobs.ashbyhq.com/gummedia/1a1a,",
        "Hazel Health Example,Nurse,Mexico,Remote,,To research,,,https://jobs.ashbyhq.com/hazelhealth/2b2b,",
      ]),
    );
    const lossy = new RecordingQueue();
    let calls = 0;
    const send = lossy.send.bind(lossy);
    lossy.send = (...args: Parameters<RecordingQueue["send"]>) =>
      ++calls === 1 ? Promise.reject(new Error("queue down")) : send(...args);

    const summary = await commitSheet(
      testWorkerCtx({ clock: () => NOW, queue: lossy }),
      body.previewId,
    );
    expect(summary.leadsCreated).toBe(3);
    expect(lossy.sent.filter((s) => s.name === QUEUES.leadsCheck)).toHaveLength(2);
    expect(await prisma.lead.count({ where: { pipelineState: "checking" } })).toBe(3);
  });

  it("holds the intake lock while it writes", async () => {
    const body = await preview(fixture("sample.csv"));
    const ctx = testWorkerCtx({ clock: () => NOW });

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withIntakeLock(prisma, async () => {
      locked();
      await held;
    });
    await lockTaken;

    let finished = false;
    const pending = commitSheet(ctx, body.previewId).then((summary) => {
      finished = true;
      return summary;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    expect(await prisma.application.count()).toBe(0);

    release();
    await holder;
    expect((await pending).applicationsCreated).toBe(3);
  });
});
