import { describe, expect, it } from "vitest";
import type { Ranking, Seniority } from "@offerbound/contracts";
import type { CompanyRef } from "./company.js";
import { jobKey } from "./job-key.js";
import {
  finalizeBatch,
  planIntake,
  type IncomingLead,
  type IntakeContext,
  type IntakeDecision,
} from "./intake.js";

const company = (id: string, name: string, over: Partial<CompanyRef> = {}): CompanyRef => ({
  id,
  name,
  normalizedName: name.toLowerCase(),
  aliases: [],
  domains: [],
  atsSlugs: [],
  groupId: null,
  ...over,
});

const NORTHWIND = company("c1", "Northwind Labs", { domains: ["northwind.example"] });
const NORTHWIND_CLOUD = company("c2", "Northwind Cloud", { groupId: "c1" });
const QUARRY = company("c3", "Quarry AI");

const DEFAULT_EXCLUDED: Seniority[] = ["junior", "staff_plus", "manager"];

const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
  batchKind: "search_run",
  existingJobKeys: new Set(),
  companyIndex: { companies: [NORTHWIND, NORTHWIND_CLOUD, QUARRY], contacts: [] },
  seenCompanyIds: new Set(),
  excludedSeniorities: DEFAULT_EXCLUDED,
  ...over,
});

let counter = 0;
const lead = (over: Partial<IncomingLead> = {}): IncomingLead => {
  counter += 1;
  return {
    ref: `r${counter}`,
    order: counter,
    source: "gmail_alert",
    companyName: "Fabrikam Systems",
    companyDomain: null,
    title: "Backend Engineer",
    jobUrl: `https://jobs.ashbyhq.com/fabrikam/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e${String(counter).padStart(2, "0")}`,
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
  };
};

const ranking = (eligible: Ranking["eligible"]): Ranking => ({
  leadRef: "x",
  track: null,
  fitScore: 70,
  fitReason: "Fits.",
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
  eligible,
  eligibilityReason: null,
});

const one = (l: IncomingLead, c: IntakeContext = ctx()): IntakeDecision => {
  const [d] = planIntake([l], c);
  if (d === undefined) throw new Error("no decision");
  return d;
};

const stored = (d: IntakeDecision) => {
  if (d.action !== "store") throw new Error(`expected store, got ${d.reason}`);
  return d;
};

describe("planIntake", () => {
  it("a search-agent lead without a job key is discarded as no_job_key", () => {
    expect(one(lead({ source: "search_agent", jobUrl: null }))).toEqual({
      ref: expect.any(String) as string,
      action: "discard",
      reason: "no_job_key",
    });
    expect(one(lead({ source: "search_agent", jobUrl: "not a url" })).action).toBe("discard");
    // Other sources may store a lead without a link.
    const alert = stored(one(lead({ source: "gmail_alert", jobUrl: null })));
    expect(alert.jobKey).toBeNull();
    expect(alert.status).toBe("new");
  });

  it("a job key already on a lead or application, or earlier in the same batch, is discarded as duplicate", () => {
    const url = "https://jobs.lever.co/fabrikam/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e34";
    const known = one(
      lead({ jobUrl: `${url}?lever-source=LinkedIn` }),
      ctx({ existingJobKeys: new Set([jobKey(url) ?? ""]) }),
    );
    expect(known).toMatchObject({ action: "discard", reason: "duplicate" });

    const first = lead({ jobUrl: url });
    const second = lead({ jobUrl: `${url}/?utm_source=x` });
    const other = lead();
    const decisions = planIntake([first, second, other], ctx());
    expect(decisions.map((d) => d.action)).toEqual(["store", "discard", "store"]);
    expect(decisions[1]).toMatchObject({ reason: "duplicate", ref: second.ref });
  });

  it("the earlier lead by order wins a duplicate even when the list is not sorted", () => {
    const url = "https://jobs.lever.co/fabrikam/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e34";
    const later = lead({ jobUrl: url, order: 5 });
    const earlier = lead({ jobUrl: url, order: 2 });
    const decisions = planIntake([later, earlier], ctx());
    expect(decisions.map((d) => d.action)).toEqual(["discard", "store"]);
  });

  it("a company seen before the batch → suppressed company_already_seen; a group member counts", () => {
    const direct = stored(
      one(lead({ companyName: "Northwind Labs" }), ctx({ seenCompanyIds: new Set(["c1"]) })),
    );
    expect(direct).toMatchObject({
      status: "suppressed",
      suppressedReason: "company_already_seen",
      pipelineState: "ready",
      company: { kind: "existing", companyId: "c1" },
    });
    // c1 is seen; c2 shares its group. The plain, unexpanded set is enough.
    const member = stored(
      one(lead({ companyName: "Northwind Cloud" }), ctx({ seenCompanyIds: new Set(["c1"]) })),
    );
    expect(member).toMatchObject({
      status: "suppressed",
      suppressedReason: "company_already_seen",
    });
    // And the other way round: a seen group member suppresses the root.
    const root = stored(
      one(lead({ companyName: "Northwind Labs" }), ctx({ seenCompanyIds: new Set(["c2"]) })),
    );
    expect(root.suppressedReason).toBe("company_already_seen");
    const unrelated = stored(
      one(lead({ companyName: "Quarry AI" }), ctx({ seenCompanyIds: new Set(["c1"]) })),
    );
    expect(unrelated.status).toBe("new");
  });

  it("recruiter outreach from a seen company → new with companySeenBefore true", () => {
    const d = stored(
      one(
        lead({ source: "gmail_recruiter", companyName: "Northwind Labs" }),
        ctx({ batchKind: "gmail_message", seenCompanyIds: new Set(["c1"]) }),
      ),
    );
    expect(d).toMatchObject({
      status: "new",
      suppressedReason: null,
      companySeenBefore: true,
      pipelineState: "checking",
    });
    const fresh = stored(one(lead({ source: "gmail_recruiter", companyName: "Quarry AI" }), ctx()));
    expect(fresh.companySeenBefore).toBe(false);
  });

  it("sheet_import and manual skip the company-seen rule", () => {
    const seen = new Set(["c1"]);
    const sheet = stored(
      one(
        lead({ source: "sheet_import", companyName: "Northwind Labs" }),
        ctx({ batchKind: "sheet_import", seenCompanyIds: seen }),
      ),
    );
    expect(sheet).toMatchObject({
      status: "new",
      suppressedReason: null,
      companySeenBefore: false,
    });
    const manual = stored(
      one(
        lead({ source: "manual", companyName: "Northwind Labs" }),
        ctx({ batchKind: "manual", seenCompanyIds: seen }),
      ),
    );
    expect(manual).toMatchObject({ status: "new", suppressedReason: null });
    // A paste report is an ordinary batch.
    const paste = stored(
      one(
        lead({ source: "paste_report", companyName: "Northwind Labs" }),
        ctx({ batchKind: "paste_report", seenCompanyIds: seen }),
      ),
    );
    expect(paste.suppressedReason).toBe("company_already_seen");
  });

  it("two leads of a new company in one batch are both stored; finalize decides between them", () => {
    const decisions = planIntake(
      [lead({ companyName: "Contoso Robotics" }), lead({ companyName: "Contoso Robotics" })],
      ctx(),
    );
    expect(decisions.map((d) => stored(d).status)).toEqual(["new", "new"]);
    expect(decisions.map((d) => stored(d).company.kind)).toEqual(["new", "new"]);
  });

  it("seniority staff_plus with the default exclusions → suppressed excluded_seniority", () => {
    const d = stored(one(lead({ seniority: "staff_plus" })));
    expect(d).toMatchObject({
      status: "suppressed",
      suppressedReason: "excluded_seniority",
      pipelineState: "ready",
    });
    expect(stored(one(lead({ seniority: "senior" }))).status).toBe("new");
    expect(
      stored(one(lead({ seniority: "unknown" }), ctx({ excludedSeniorities: ["unknown"] }))).status,
    ).toBe("new");
    expect(stored(one(lead({ seniority: null }))).status).toBe("new");
    expect(
      stored(one(lead({ seniority: "staff_plus" }), ctx({ excludedSeniorities: [] }))).status,
    ).toBe("new");
  });

  it("a search-agent lead ranked eligible 'no' → suppressed ineligible; otherwise new and ready", () => {
    const base = { source: "search_agent" } as const;
    expect(stored(one(lead({ ...base, ranking: ranking("no") })))).toMatchObject({
      status: "suppressed",
      suppressedReason: "ineligible",
      pipelineState: "ready",
    });
    for (const eligible of ["yes", "unknown"] as const) {
      expect(stored(one(lead({ ...base, ranking: ranking(eligible) })))).toMatchObject({
        status: "new",
        suppressedReason: null,
        pipelineState: "ready",
      });
    }
    // The company rule outranks eligibility.
    const seen = stored(
      one(
        lead({ ...base, companyName: "Quarry AI", ranking: ranking("no") }),
        ctx({ seenCompanyIds: new Set(["c3"]) }),
      ),
    );
    expect(seen.suppressedReason).toBe("company_already_seen");
  });

  it("a sheet Cancelled row → dismissed with not_pursued_imported, ready", () => {
    const d = stored(
      one(
        lead({ source: "sheet_import", sheetStatus: "cancelled" }),
        ctx({ batchKind: "sheet_import" }),
      ),
    );
    expect(d).toMatchObject({
      status: "dismissed",
      dismissedReason: "not_pursued_imported",
      suppressedReason: null,
      pipelineState: "ready",
    });
  });

  it("everything else → new and checking", () => {
    for (const l of [
      lead({ source: "gmail_alert" }),
      lead({ source: "sheet_import", sheetStatus: "to_research" }),
      lead({ source: "paste_report" }),
      lead({ source: "manual" }),
    ]) {
      expect(stored(one(l))).toMatchObject({
        status: "new",
        suppressedReason: null,
        dismissedReason: null,
        pipelineState: "checking",
        companySeenBefore: false,
      });
    }
  });

  it("returns one decision per lead, in input order, carrying the job key and company resolution", () => {
    const a = lead({ companyName: "Quarry AI" });
    const b = lead({ source: "search_agent", jobUrl: null });
    const decisions = planIntake([a, b], ctx());
    expect(decisions.map((d) => d.ref)).toEqual([a.ref, b.ref]);
    const first = stored(decisions[0] as IntakeDecision);
    expect(first.jobKey).toBe(jobKey(a.jobUrl ?? ""));
    expect(first.company).toEqual({ kind: "existing", companyId: "c3", via: "name" });
  });

  it("never records an ATS or job-board domain as a new company's domain", () => {
    for (const companyDomain of [
      "rippling.com",
      "dover.com",
      "gem.com",
      "greenhouse.io",
      "linkedin.com",
    ]) {
      const d = stored(one(lead({ companyName: "Initech Labs", companyDomain })));
      expect(d.company).toMatchObject({ kind: "new", company: { domains: [] } });
    }
    const real = stored(
      one(lead({ companyName: "Initech Labs", companyDomain: "initech.example" })),
    );
    expect(real.company).toMatchObject({ kind: "new", company: { domains: ["initech.example"] } });
  });

  it("a bare top-level domain as the company domain matches and records nothing", () => {
    const d = stored(one(lead({ companyName: "Initech Labs", companyDomain: "com" })));
    expect(d.company).toMatchObject({ kind: "new", company: { domains: [] } });
  });

  it("does not mutate its inputs", () => {
    const seenIds = new Set(["c1"]);
    const l = lead({ companyName: "Northwind Cloud" });
    const copy = structuredClone(l);
    planIntake([l], ctx({ seenCompanyIds: seenIds }));
    expect(l).toEqual(copy);
    expect([...seenIds]).toEqual(["c1"]);
  });
});

describe("finalizeBatch", () => {
  const item = (
    id: string,
    over: Partial<Parameters<typeof finalizeBatch>[0][number]> = {},
  ): Parameters<typeof finalizeBatch>[0][number] => ({
    id,
    companyId: "c1",
    status: "new",
    fitScore: 50,
    postedAt: null,
    order: 0,
    ...over,
  });

  it("finalize keeps the highest fit per company; ties go to the newest postedAt, then the lowest order", () => {
    // Highest fit wins.
    expect(
      finalizeBatch([
        item("a", { fitScore: 60 }),
        item("b", { fitScore: 82 }),
        item("c", { fitScore: 75 }),
      ]),
    ).toEqual({ suppressIds: ["a", "c"] });
    // Equal fit: the newest posting wins.
    expect(
      finalizeBatch([
        item("a", { postedAt: new Date("2026-10-01T00:00:00Z") }),
        item("b", { postedAt: new Date("2026-10-05T00:00:00Z") }),
        item("c", { postedAt: null }),
      ]),
    ).toEqual({ suppressIds: ["a", "c"] });
    // Equal fit and date: the lowest order wins.
    expect(
      finalizeBatch([item("a", { order: 3 }), item("b", { order: 1 }), item("c", { order: 2 })]),
    ).toEqual({ suppressIds: ["a", "c"] });
  });

  it("decides each company on its own and leaves single leads alone", () => {
    const result = finalizeBatch([
      item("a", { companyId: "c1", fitScore: 90 }),
      item("b", { companyId: "c2", fitScore: 40 }),
      item("c", { companyId: "c1", fitScore: 70 }),
    ]);
    expect(result).toEqual({ suppressIds: ["c"] });
    expect(finalizeBatch([])).toEqual({ suppressIds: [] });
  });

  it("only leads still new compete; a missing score loses to any score", () => {
    expect(
      finalizeBatch([
        item("a", { fitScore: 99, status: "suppressed" }),
        item("b", { fitScore: null }),
        item("c", { fitScore: 10 }),
        item("d", { fitScore: 95, status: "dismissed" }),
      ]),
    ).toEqual({ suppressIds: ["b"] });
  });
});
