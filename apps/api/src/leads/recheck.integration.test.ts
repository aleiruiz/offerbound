import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeCompanyName } from "@offerbound/domain";
import { resetDb, testPrisma } from "../../test/db.js";
import { testWorkerCtx } from "../../test/worker.js";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import type { LinkFetcher } from "./link-check.js";
import { runLeadsRecheck } from "./recheck.js";

const prisma = testPrisma();
const NOW = new Date("2026-10-01T12:00:00.000Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await resetDb(prisma);
});

let batchId: string;
beforeEach(async () => {
  const batch = await prisma.intakeBatch.create({
    data: {
      kind: "gmail_message",
      counts: { received: 0, duplicates: 0, suppressed: 0, dead: 0, accepted: 0 },
    },
  });
  batchId = batch.id;
});

async function seedLead(name: string, over: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  const company = await prisma.company.create({
    data: { name, normalizedName: normalizeCompanyName(name), createdSource: "gmail" },
  });
  const created = over.createdAt ?? daysAgo(2);
  return prisma.lead.create({
    data: {
      companyId: company.id,
      intakeBatchId: batchId,
      title: "Senior Backend Engineer",
      jobUrl: `https://jobs.example/${encodeURIComponent(name)}`,
      source: "gmail_alert",
      pipelineState: "ready",
      verification: "verified",
      verifiedAt: daysAgo(2),
      foundAt: created,
      createdAt: created,
      statusChangedAt: created,
      ...over,
    },
  });
}

/** Answers each URL from `pages` (path → page); anything else is a network failure. */
function fetcher(pages: Record<string, { status: number; body?: string }>) {
  const requested: string[] = [];
  const fetch: LinkFetcher = (url) => {
    requested.push(url);
    const page = pages[new URL(url).pathname.slice(1)];
    if (page === undefined) return Promise.reject(new Error("offline"));
    return Promise.resolve({
      status: page.status,
      finalUrl: url,
      contentType: "text/html",
      body: page.body ?? "",
    });
  };
  return { fetch, requested };
}

const OPEN_PAGE = "<h1>Senior Backend Engineer</h1><p>Apply now.</p>";

describe("leads.recheck", () => {
  it("dismisses an open lead whose posting is gone, and keeps the others up to date", async () => {
    const gone = await seedLead("Gone");
    const shortlisted = await seedLead("Shortlisted", { status: "shortlisted" });
    const alive = await seedLead("Alive");
    const shell = await seedLead("Shell");
    const { fetch } = fetcher({
      Gone: { status: 404 },
      Shortlisted: { status: 200, body: "<p>This job is no longer available.</p>" },
      Alive: { status: 200, body: OPEN_PAGE },
      Shell: { status: 200, body: "<h1>Careers</h1><p>Search our open roles.</p>" },
    });
    const ctx = testWorkerCtx({ clock: () => NOW, fetchLink: fetch });

    expect(await runLeadsRecheck(ctx)).toEqual({ checked: 4, closed: 2, expired: 0 });

    const rows = new Map((await prisma.lead.findMany()).map((lead) => [lead.id, lead] as const));
    for (const id of [gone.id, shortlisted.id]) {
      expect(rows.get(id)).toMatchObject({
        status: "dismissed",
        dismissedReason: "posting_closed",
        statusChangedAt: NOW,
        version: 2,
      });
    }
    expect(rows.get(alive.id)).toMatchObject({
      status: "new",
      verification: "verified",
      verifiedAt: NOW,
    });
    expect(rows.get(alive.id)?.pageExcerpt).toContain("Senior Backend Engineer");
    // The page answered, but not with this job: no longer shown as verified.
    expect(rows.get(shell.id)).toMatchObject({ status: "new", verification: "unverified" });
  });

  it("leaves alone leads checked recently, dismissed leads, LinkedIn leads and leads still in intake", async () => {
    await seedLead("Recent", { verifiedAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    await seedLead("Dismissed", { status: "dismissed" });
    await seedLead("LinkedIn", {
      verification: "unverifiable",
      jobUrl: "https://linkedin.com/jobs/view/1",
    });
    await seedLead("Checking", {
      pipelineState: "checking",
      verification: "pending",
      verifiedAt: null,
    });
    const { fetch, requested } = fetcher({});
    const ctx = testWorkerCtx({ clock: () => NOW, fetchLink: fetch });

    expect(await runLeadsRecheck(ctx)).toEqual({ checked: 0, closed: 0, expired: 0 });
    expect(requested).toEqual([]);
  });

  it("skips a lead the owner changed while its page was being fetched", async () => {
    const lead = await seedLead("Raced");
    const fetch: LinkFetcher = async (url) => {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { notes: "mine", version: { increment: 1 } },
      });
      return { status: 404, finalUrl: url, contentType: "text/html", body: "" };
    };
    const ctx = testWorkerCtx({ clock: () => NOW, fetchLink: fetch });

    expect(await runLeadsRecheck(ctx)).toEqual({ checked: 0, closed: 0, expired: 0 });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "new",
      notes: "mine",
    });
  });

  it("dismisses New leads that cannot be confirmed open once they are 30 days old", async () => {
    const oldAlert = await seedLead("Old alert", {
      verification: "unverifiable",
      jobUrl: "https://www.linkedin.com/jobs/view/1",
      createdAt: daysAgo(45),
    });
    const oldPosting = await seedLead("Old posting", {
      verification: "unverifiable",
      jobUrl: null,
      postedAt: daysAgo(40),
    });
    const youngAlert = await seedLead("Young alert", {
      verification: "unverifiable",
      jobUrl: null,
      createdAt: daysAgo(10),
    });
    const verifiedOld = await seedLead("Verified old", {
      createdAt: daysAgo(45),
      verifiedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    const reconsidered = await seedLead("Reconsidered", {
      verification: "unverifiable",
      jobUrl: null,
      createdAt: daysAgo(45),
      statusChangedAt: daysAgo(1),
    });
    const shortlisted = await seedLead("Shortlisted old", {
      status: "shortlisted",
      verification: "unverifiable",
      jobUrl: null,
      createdAt: daysAgo(45),
    });
    const ctx = testWorkerCtx({ clock: () => NOW, fetchLink: fetcher({}).fetch });

    expect(await runLeadsRecheck(ctx)).toEqual({ checked: 0, closed: 0, expired: 2 });

    const status = new Map(
      (await prisma.lead.findMany()).map((l) => [l.id, [l.status, l.dismissedReason]] as const),
    );
    expect(status.get(oldAlert.id)).toEqual(["dismissed", "expired"]);
    expect(status.get(oldPosting.id)).toEqual(["dismissed", "expired"]);
    for (const lead of [youngAlert, verifiedOld, reconsidered]) {
      expect(status.get(lead.id)).toEqual(["new", null]);
    }
    expect(status.get(shortlisted.id)).toEqual(["shortlisted", null]);
  });

  it("is the leads.recheck handler", () => {
    expect(HANDLERS[QUEUES.leadsRecheck]).toBeTypeOf("function");
  });
});
