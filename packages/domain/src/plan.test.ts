import { describe, expect, it } from "vitest";
import type {
  ApplicationStatus,
  EmailCategory,
  Extraction,
  IcsEvent,
  LeadStatus,
} from "@offerbound/contracts";
import type { CompanyRef } from "./company.js";
import { jobKey } from "./job-key.js";
import {
  planChanges,
  type ChangePlan,
  type InterviewRef,
  type Operation,
  type OwnerChoice,
  type PlanMessage,
  type PlanSnapshot,
} from "./plan.js";

const SETTINGS = { autoApplyMinConfidence: 0.8 };
const MONTERREY = "America/Monterrey";
const AT = new Date("2026-10-20T15:00:00.000Z");

const company = (id: string, name: string, domains: string[] = []): CompanyRef => ({
  id,
  name,
  normalizedName: name.toLowerCase(),
  aliases: [],
  domains,
  atsSlugs: [],
  groupId: null,
});

type AppSeed = {
  id: string;
  companyId?: string;
  title?: string;
  status?: ApplicationStatus;
  jobKey?: string | null;
  version?: number;
  statusBeforeAbandon?: ApplicationStatus | null;
  followUpDue?: boolean;
  lastCompanyActivityAt?: Date | null;
};

type LeadSeed = {
  id: string;
  companyId?: string;
  title?: string;
  status?: LeadStatus;
  jobKey?: string | null;
  version?: number;
};

type SnapOpts = {
  companies?: CompanyRef[];
  apps?: AppSeed[];
  leads?: LeadSeed[];
  threadLinks?: [string, { applicationId: string | null; leadId: string | null }][];
  interviews?: Record<string, InterviewRef[]>;
  contacts?: { email: string; companyId: string | null }[];
};

const snap = (o: SnapOpts = {}): PlanSnapshot => {
  const companies = o.companies ?? [company("c1", "Northwind Labs", ["northwind.example"])];
  const apps = (o.apps ?? []).map((a) => ({
    id: a.id,
    companyId: a.companyId ?? "c1",
    title: a.title ?? "Backend Engineer",
    status: a.status ?? "applied",
    jobKey: a.jobKey ?? null,
    version: a.version ?? 5,
    statusBeforeAbandon: a.statusBeforeAbandon ?? null,
    followUpDue: a.followUpDue ?? false,
    lastCompanyActivityAt: a.lastCompanyActivityAt ?? null,
  }));
  const leads = (o.leads ?? []).map((l) => ({
    id: l.id,
    companyId: l.companyId ?? "c1",
    title: l.title ?? "Backend Engineer",
    status: l.status ?? "shortlisted",
    jobKey: l.jobKey ?? null,
    version: l.version ?? 4,
  }));
  return {
    threadLinks: new Map(o.threadLinks ?? []),
    applications: apps.map(({ id, companyId, title, status, jobKey }) => ({
      id,
      companyId,
      title,
      status,
      jobKey,
    })),
    leads: leads.map(({ id, companyId, title, status, jobKey }) => ({
      id,
      companyId,
      title,
      status,
      jobKey,
    })),
    companies,
    companyIndex: { companies, contacts: o.contacts ?? [] },
    applicationState: new Map(
      apps.map((a) => [
        a.id,
        {
          version: a.version,
          status: a.status,
          statusBeforeAbandon: a.statusBeforeAbandon,
          followUpDue: a.followUpDue,
          lastCompanyActivityAt: a.lastCompanyActivityAt,
        },
      ]),
    ),
    leadState: new Map(leads.map((l) => [l.id, { version: l.version, status: l.status }])),
    interviews: new Map(Object.entries(o.interviews ?? {})),
    ownerTimezone: MONTERREY,
  };
};

const msg = (over: Partial<PlanMessage> = {}): PlanMessage => ({
  id: "m1",
  threadId: "t1",
  internalDate: AT,
  direction: "inbound",
  fromEmail: "jobs@northwind.example",
  icsEvents: [],
  ...over,
});

const ext = (over: Partial<Extraction> = {}): Extraction => ({
  category: "application_confirmation",
  confidence: 0.95,
  company: { name: "Northwind Labs", websiteDomain: null },
  role: { title: "Backend Engineer", seniority: null },
  jobUrl: null,
  contact: null,
  interview: null,
  assessment: null,
  leads: [],
  summary: "An email.",
  language: "en",
  ...over,
});

const ics = (over: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: null,
  method: "REQUEST",
  start: null,
  end: null,
  timezone: null,
  summary: null,
  location: null,
  url: null,
  descriptionLink: null,
  organizer: null,
  ...over,
});

const interviewOf = (
  over: Partial<NonNullable<Extraction["interview"]>> = {},
): NonNullable<Extraction["interview"]> => ({
  kind: "technical",
  startsAt: null,
  endsAt: null,
  timezone: null,
  meetingUrl: null,
  schedulingUrl: null,
  location: null,
  interviewers: [],
  ...over,
});

const opsOf = <K extends Operation["op"]>(plan: ChangePlan, op: K) =>
  plan.operations.filter((o): o is Extract<Operation, { op: K }> => o.op === op);

const names = (plan: ChangePlan) => plan.operations.map((o) => o.op);

const ASHBY_URL = "https://jobs.ashbyhq.com/quarry/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e34";

const plan = (
  s: PlanSnapshot,
  e: Extraction,
  m: PlanMessage = msg(),
  choice?: OwnerChoice,
): ChangePlan => planChanges(s, m, e, SETTINGS, choice);

describe("planChanges", () => {
  it("an Ashby confirmation for a new company creates the company and an Applied application, links the thread, attaches the email and auto-applies", () => {
    const p = plan(
      snap({ companies: [] }),
      ext({
        company: { name: "Quarry AI", websiteDomain: "quarry.example" },
        jobUrl: ASHBY_URL,
        role: { title: "Platform Engineer", seniority: null },
      }),
      msg({ fromEmail: "no-reply@ashbyhq.com" }),
    );
    expect(names(p)).toEqual([
      "create_company",
      "create_application",
      "link_thread",
      "attach_message",
    ]);
    const [create] = opsOf(p, "create_company");
    expect(create).toMatchObject({ ref: "new:company", company: { name: "Quarry AI" } });
    // The ATS sender domain is never recorded as the company's.
    expect(create?.company.domains).toEqual(["quarry.example"]);
    expect(opsOf(p, "create_application")[0]).toEqual({
      op: "create_application",
      ref: "new:application",
      company: { ref: "new:company" },
      title: "Platform Engineer",
      jobUrl: ASHBY_URL,
      jobKey: jobKey(ASHBY_URL),
      status: "applied",
      appliedAt: AT,
      lastCompanyActivityAt: AT,
      source: "gmail",
    });
    expect(opsOf(p, "link_thread")[0]).toEqual({
      op: "link_thread",
      threadId: "t1",
      application: { ref: "new:application" },
      leadRef: null,
    });
    expect(opsOf(p, "attach_message")[0]).toEqual({
      op: "attach_message",
      application: { ref: "new:application" },
    });
    expect(p.autoApply).toBe(true);
    expect(p.review).toBeNull();
    expect(p.messageOutcome).toBe("applied");
    expect(p.events).toEqual([
      {
        subject: { ref: "new:application" },
        subjectType: "application",
        type: "application_created",
        summary: "Application received by Quarry AI",
        data: { toStatus: "applied" },
      },
    ]);
  });

  it("a confirmation whose job key matches a lead converts the lead instead of creating an application", () => {
    const key = jobKey(ASHBY_URL);
    const p = plan(
      snap({ leads: [{ id: "l1", title: "Platform Engineer", jobKey: key, version: 4 }] }),
      ext({ jobUrl: ASHBY_URL, role: { title: "Platform Engineer", seniority: null } }),
    );
    expect(opsOf(p, "create_application")).toEqual([]);
    expect(opsOf(p, "create_company")).toEqual([]);
    expect(opsOf(p, "convert_lead")).toEqual([
      {
        op: "convert_lead",
        leadId: "l1",
        expectedVersion: 4,
        applicationRef: "new:application",
        status: "applied",
        appliedAt: AT,
      },
    ]);
    expect(opsOf(p, "update_application")[0]).toMatchObject({
      application: { ref: "new:application" },
      expectedVersion: null,
      set: { lastCompanyActivityAt: AT },
    });
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({
      type: "lead_converted",
      subject: { ref: "new:application" },
      data: { leadId: "l1", toStatus: "applied" },
    });
    expect(p.autoApply).toBe(true);
  });

  it("a rejection on Applied → status rejected, lastCompanyActivityAt = internalDate, followUpDue false, one status_changed event", () => {
    const p = plan(
      snap({ apps: [{ id: "a1", version: 5, followUpDue: true }] }),
      ext({ category: "rejection" }),
    );
    expect(opsOf(p, "update_application")).toEqual([
      {
        op: "update_application",
        application: { id: "a1" },
        expectedVersion: 5,
        set: {
          status: "rejected",
          lastCompanyActivityAt: AT,
          followUpDue: false,
          followUpDueSince: null,
        },
      },
    ]);
    expect(p.events).toEqual([
      {
        subject: { id: "a1" },
        subjectType: "application",
        type: "status_changed",
        summary: "Rejected by Northwind Labs",
        data: { fromStatus: "applied", toStatus: "rejected" },
      },
    ]);
    expect(names(p)).toContain("link_thread");
    expect(names(p)).toContain("attach_message");
    expect(p.autoApply).toBe(true);
  });

  it.each([
    [0.79, false],
    [0.8, true],
  ])("confidence %s → autoApply %s", (confidence, expected) => {
    const p = plan(snap({ apps: [{ id: "a1" }] }), ext({ category: "rejection", confidence }));
    expect(p.autoApply).toBe(expected);
    expect(p.confidence).toBe(confidence);
    if (expected) {
      expect(p.review).toBeNull();
    } else {
      expect(p.review).toMatchObject({ kind: "low_confidence", candidates: [] });
      expect(p.review?.reasons).toHaveLength(1);
      // The proposed change is kept for the owner to see.
      expect(opsOf(p, "update_application")[0]?.set.status).toBe("rejected");
    }
  });

  it("a rejection when already Rejected → only an email_received event, no status change", () => {
    const p = plan(
      snap({ apps: [{ id: "a1", status: "rejected" }] }),
      ext({ category: "rejection" }),
    );
    expect(p.events.map((e) => e.type)).toEqual(["email_received"]);
    expect(p.events[0]?.summary).toBe("Email from Northwind Labs");
    expect(opsOf(p, "update_application")[0]?.set).not.toHaveProperty("status");
    expect(p.autoApply).toBe(true);
  });

  it("a confirmation for a Rejected application → review unexpected_transition", () => {
    const p = plan(
      snap({ apps: [{ id: "a1", status: "rejected" }] }),
      ext({ category: "application_confirmation" }),
    );
    expect(p.autoApply).toBe(false);
    expect(p.review).toMatchObject({ kind: "unexpected_transition", candidates: [] });
    expect(p.review?.reasons.join(" ")).toMatch(/rejected/i);
  });

  it("an invite with ics → Interviewing plus a scheduled interview whose times come from the ics, not the extraction", () => {
    const p = plan(
      snap({ apps: [{ id: "a1", status: "screening" }] }),
      ext({
        category: "interview_invite",
        interview: interviewOf({
          kind: "technical",
          startsAt: "2026-10-28T09:00:00-06:00",
          endsAt: "2026-10-28T10:00:00-06:00",
        }),
      }),
      msg({
        icsEvents: [
          ics({
            uid: "uid-9",
            start: "2026-10-27T16:00:00.000Z",
            end: "2026-10-27T17:00:00.000Z",
            timezone: MONTERREY,
          }),
        ],
      }),
    );
    expect(opsOf(p, "update_application")[0]?.set.status).toBe("interviewing");
    expect(opsOf(p, "upsert_interview")).toEqual([
      expect.objectContaining({
        application: { id: "a1" },
        interviewId: null,
        expectedVersion: null,
        ref: "new:interview",
        fields: expect.objectContaining({
          status: "scheduled",
          startsAt: new Date("2026-10-27T16:00:00.000Z"),
          endsAt: new Date("2026-10-27T17:00:00.000Z"),
          icsUid: "uid-9",
        }) as unknown,
      }),
    ]);
    expect(p.events.map((e) => e.type)).toEqual(["status_changed", "interview_created"]);
    expect(p.events[0]).toMatchObject({
      summary: "Moved to Interviewing",
      data: { fromStatus: "screening", toStatus: "interviewing" },
    });
    expect(p.events[1]?.summary).toBe("Interview scheduled for Tue, Oct 27, 10:00");
    expect(p.autoApply).toBe(true);
  });

  it("a recruiter-screen invite without a time → Screening plus a to_schedule interview with the scheduling link", () => {
    const p = plan(
      snap({ apps: [{ id: "a1" }] }),
      ext({
        category: "interview_invite",
        interview: interviewOf({
          kind: "recruiter_screen",
          schedulingUrl: "https://cal.example/book/ana",
        }),
      }),
    );
    expect(opsOf(p, "update_application")[0]?.set.status).toBe("screening");
    expect(opsOf(p, "upsert_interview")[0]).toMatchObject({
      fields: {
        kind: "recruiter_screen",
        status: "to_schedule",
        startsAt: null,
        schedulingUrl: "https://cal.example/book/ana",
      },
    });
    expect(p.events.map((e) => e.type)).toEqual(["status_changed", "interview_created"]);
    expect(p.events[1]?.summary).toBe("Interview to schedule");
  });

  it("Abandoned + status_update_other → reopened to statusBeforeAbandon; Abandoned + rejection → Rejected", () => {
    const s = snap({
      apps: [{ id: "a1", status: "abandoned", statusBeforeAbandon: "interviewing" }],
    });
    const reopened = plan(s, ext({ category: "status_update_other" }));
    expect(opsOf(reopened, "update_application")[0]?.set).toMatchObject({
      status: "interviewing",
      statusBeforeAbandon: null,
      lastCompanyActivityAt: AT,
    });
    expect(reopened.events).toEqual([
      {
        subject: { id: "a1" },
        subjectType: "application",
        type: "reopened",
        summary: "Reopened: Northwind Labs replied",
        data: { fromStatus: "abandoned", toStatus: "interviewing" },
      },
    ]);
    expect(reopened.autoApply).toBe(true);

    const rejected = plan(s, ext({ category: "rejection" }));
    expect(opsOf(rejected, "update_application")[0]?.set).toMatchObject({
      status: "rejected",
      statusBeforeAbandon: null,
    });
    expect(rejected.events.map((e) => e.type)).toEqual(["status_changed"]);
    expect(rejected.autoApply).toBe(true);
  });

  it("Abandoned + an interview invite reopens to the status the email implies", () => {
    const p = plan(
      snap({ apps: [{ id: "a1", status: "abandoned", statusBeforeAbandon: "applied" }] }),
      ext({ category: "interview_invite", interview: interviewOf({ kind: "technical" }) }),
    );
    expect(opsOf(p, "update_application")[0]?.set).toMatchObject({ status: "interviewing" });
    expect(p.events[0]).toMatchObject({
      type: "reopened",
      data: { fromStatus: "abandoned", toStatus: "interviewing" },
    });
  });

  it("an outbound email while followUpDue → follow_up_done with followUpDoneAt = internalDate and increment_daily_follow_ups on the owner-local day", () => {
    // 04:30 UTC on Oct 21 is 22:30 on Oct 20 in Monterrey.
    const sent = new Date("2026-10-21T04:30:00.000Z");
    const p = plan(
      snap({ apps: [{ id: "a1", followUpDue: true, version: 8 }] }),
      ext({ category: "candidate_outbound" }),
      msg({ direction: "outbound", internalDate: sent, fromEmail: "owner@mail.example" }),
    );
    expect(opsOf(p, "update_application")[0]).toEqual({
      op: "update_application",
      application: { id: "a1" },
      expectedVersion: 8,
      set: {
        lastOutboundAt: sent,
        followUpDue: false,
        followUpDueSince: null,
        followUpDoneAt: sent,
      },
    });
    expect(opsOf(p, "increment_daily_follow_ups")).toEqual([
      { op: "increment_daily_follow_ups", day: "2026-10-20" },
    ]);
    expect(p.events).toEqual([
      {
        subject: { id: "a1" },
        subjectType: "application",
        type: "follow_up_done",
        summary: "Followed up by email",
        data: null,
      },
    ]);
  });

  it("an outbound email without a follow-up due only records email_sent", () => {
    const p = plan(
      snap({ apps: [{ id: "a1" }] }),
      ext({ category: "candidate_outbound" }),
      msg({ direction: "outbound" }),
    );
    expect(opsOf(p, "increment_daily_follow_ups")).toEqual([]);
    expect(p.events.map((e) => e.type)).toEqual(["email_sent"]);
    expect(opsOf(p, "update_application")[0]?.set).toEqual({ lastOutboundAt: AT });
  });

  it("an outbound email never changes lastCompanyActivityAt, status or an abandoned application", () => {
    for (const status of ["applied", "abandoned", "rejected"] as const) {
      const p = plan(
        snap({ apps: [{ id: "a1", status, statusBeforeAbandon: "screening" }] }),
        ext({ category: "candidate_outbound" }),
        msg({ direction: "outbound" }),
      );
      const set = opsOf(p, "update_application")[0]?.set ?? {};
      expect(set).not.toHaveProperty("lastCompanyActivityAt");
      expect(set).not.toHaveProperty("status");
      expect(p.events.map((e) => e.type)).toEqual(["email_sent"]);
    }
    // Even a mis-categorised outbound email changes no status.
    const odd = plan(
      snap({ apps: [{ id: "a1" }] }),
      ext({ category: "rejection" }),
      msg({ direction: "outbound" }),
    );
    expect(opsOf(odd, "update_application")[0]?.set).not.toHaveProperty("status");
  });

  it("an older inbound email never moves lastCompanyActivityAt backwards", () => {
    const newer = new Date("2026-10-25T12:00:00.000Z");
    const p = plan(
      snap({ apps: [{ id: "a1", lastCompanyActivityAt: newer }] }),
      ext({ category: "status_update_other" }),
    );
    expect(opsOf(p, "update_application")[0]?.set).not.toHaveProperty("lastCompanyActivityAt");
    const later = plan(
      snap({ apps: [{ id: "a1", lastCompanyActivityAt: new Date("2026-10-01T00:00:00Z") }] }),
      ext({ category: "status_update_other" }),
    );
    expect(opsOf(later, "update_application")[0]?.set.lastCompanyActivityAt).toEqual(AT);
  });

  it("an ambiguous match → review ambiguous_match with candidates; choice attach resolves it to that application", () => {
    const s = snap({
      apps: [
        { id: "a1", title: "Backend Engineer" },
        { id: "a2", title: "Data Analyst", version: 9 },
      ],
    });
    const e = ext({ category: "rejection", role: { title: "Designer", seniority: null } });
    const p = plan(s, e);
    expect(p.autoApply).toBe(false);
    expect(p.review).toMatchObject({
      kind: "ambiguous_match",
      candidates: [
        { id: "a1", label: "Northwind Labs — Backend Engineer (Applied)" },
        { id: "a2", label: "Northwind Labs — Data Analyst (Applied)" },
      ],
    });
    expect(opsOf(p, "update_application")).toEqual([]);

    const chosen = plan(s, e, msg(), { action: "attach", applicationId: "a2" });
    expect(chosen.autoApply).toBe(true);
    expect(chosen.review).toBeNull();
    expect(opsOf(chosen, "update_application")[0]).toMatchObject({
      application: { id: "a2" },
      expectedVersion: 9,
      set: { status: "rejected" },
    });
    expect(opsOf(chosen, "link_thread")[0]).toMatchObject({ application: { id: "a2" } });
  });

  it("a choice of create_new creates the application; timeline_only records the email without changes", () => {
    const s = snap({
      apps: [
        { id: "a1", title: "Backend Engineer" },
        { id: "a2", title: "Data Analyst" },
      ],
    });
    const e = ext({
      category: "application_confirmation",
      role: { title: "Designer", seniority: null },
    });
    const created = plan(s, e, msg(), { action: "create_new" });
    expect(created.autoApply).toBe(true);
    expect(opsOf(created, "create_application")[0]).toMatchObject({
      company: { id: "c1" },
      title: "Designer",
      status: "applied",
    });
    expect(opsOf(created, "create_company")).toEqual([]);

    const none = plan(s, e, msg(), { action: "timeline_only" });
    expect(none.autoApply).toBe(true);
    expect(none.operations).toEqual([]);
    expect(none.events).toEqual([]);
  });

  it("a new company similar to an existing one → a possible_duplicate_company notice and autoApply stays true", () => {
    const p = plan(
      snap(),
      ext({ company: { name: "Northwind Labs Europe", websiteDomain: null } }),
      msg({ fromEmail: "careers@northwind-europe.example" }),
    );
    expect(opsOf(p, "create_company")).toHaveLength(1);
    expect(p.notices).toEqual([
      {
        kind: "possible_duplicate_company",
        company: { ref: "new:company" },
        candidates: [{ id: "c1", label: "Northwind Labs" }],
      },
    ]);
    expect(p.autoApply).toBe(true);
    expect(p.review).toBeNull();
  });

  it("never records an agency sender domain as a new company's domain", () => {
    const p = plan(
      snap({ companies: [] }),
      ext({
        category: "interview_invite",
        company: { name: "Fernhill Systems", websiteDomain: "fernhill.example" },
        contact: {
          name: "Pat Lee",
          email: "pat@talentbridge.example",
          title: null,
          isAgency: true,
        },
        interview: interviewOf({ kind: "recruiter_screen" }),
      }),
      msg({ fromEmail: "Pat Lee <pat@talentbridge.example>" }),
    );
    expect(opsOf(p, "create_company")[0]?.company.domains).toEqual(["fernhill.example"]);
    expect(opsOf(p, "create_contact")).toEqual([
      {
        op: "create_contact",
        email: "pat@talentbridge.example",
        ref: "new:contact",
        name: "Pat Lee",
        title: null,
        isAgency: true,
        company: null,
      },
    ]);
  });

  it("a recruiter at the company's own domain becomes a contact of the new company and the domain is kept", () => {
    const p = plan(
      snap({ companies: [] }),
      ext({
        company: { name: "Fernhill Systems", websiteDomain: null },
        contact: {
          name: "Ana Ruiz",
          email: "ana@fernhill.example",
          title: "Recruiter",
          isAgency: false,
        },
      }),
      msg({ fromEmail: "ana@fernhill.example" }),
    );
    expect(opsOf(p, "create_company")[0]?.company.domains).toEqual(["fernhill.example"]);
    expect(opsOf(p, "create_contact")[0]).toMatchObject({
      email: "ana@fernhill.example",
      company: { ref: "new:company" },
      isAgency: false,
    });
    expect(names(p).indexOf("create_company")).toBeLessThan(names(p).indexOf("create_contact"));
  });

  it("does not create a contact that already exists or that sits on an ATS domain", () => {
    const known = plan(
      snap({ contacts: [{ email: "ana@northwind.example", companyId: "c1" }] }),
      ext({
        category: "rejection",
        contact: { name: "Ana", email: "Ana@Northwind.example", title: null, isAgency: false },
      }),
      msg({ fromEmail: "ana@northwind.example" }),
    );
    expect(opsOf(known, "create_contact")).toEqual([]);
    const ats = plan(
      snap(),
      ext({
        contact: { name: null, email: "no-reply@greenhouse-mail.io", title: null, isAgency: false },
      }),
    );
    expect(opsOf(ats, "create_contact")).toEqual([]);
  });

  it("a job alert → create_leads gmail_alert with each lead's own company name, never the sender", () => {
    const p = plan(
      snap(),
      ext({
        category: "job_alert",
        company: null,
        role: null,
        leads: [
          {
            company: "Fernhill Systems",
            title: "Data Engineer",
            jobUrl: "https://boards.greenhouse.io/fernhill/jobs/123",
            locationText: "Remote",
            country: "MX",
            workMode: "remote",
            compensationText: null,
            postedAt: "2026-10-19T00:00:00Z",
          },
          {
            company: "Quarry AI",
            title: "ML Engineer",
            jobUrl: null,
            locationText: null,
            country: null,
            workMode: "unknown",
            compensationText: "US$9k / month",
            postedAt: null,
          },
        ],
      }),
      msg({ fromEmail: "jobalerts-noreply@linkedin.com" }),
    );
    expect(names(p)).toEqual(["create_leads"]);
    const [op] = opsOf(p, "create_leads");
    expect(op?.source).toBe("gmail_alert");
    expect(op?.leads.map((l) => [l.companyName, l.order, l.ref])).toEqual([
      ["Fernhill Systems", 0, "new:lead:0"],
      ["Quarry AI", 1, "new:lead:1"],
    ]);
    expect(op?.leads[0]).toMatchObject({
      source: "gmail_alert",
      title: "Data Engineer",
      companyDomain: null,
      postedAt: new Date("2026-10-19T00:00:00Z"),
      workMode: "remote",
      contactEmail: null,
      sheetStatus: null,
    });
    expect(op?.leads[1]?.postedAt).toBeNull();
    expect(JSON.stringify(op)).not.toMatch(/linkedin/);
    expect(p.messageOutcome).toBe("applied");
    expect(p.autoApply).toBe(true);
  });

  describe("recruiter outreach", () => {
    const outreach = (over: Partial<Extraction> = {}) =>
      ext({
        category: "recruiter_outreach",
        contact: { name: "Sam Ortiz", email: "sam@fernhill.example", title: null, isAgency: false },
        leads: [
          {
            company: "Fernhill Systems",
            title: "Staff Engineer",
            jobUrl: null,
            locationText: null,
            country: null,
            workMode: "unknown",
            compensationText: null,
            postedAt: null,
          },
        ],
        ...over,
      });

    it("with an active application at the company → attach as email_received, no lead", () => {
      const p = plan(
        snap({ apps: [{ id: "a1", status: "interviewing" }] }),
        outreach({ company: { name: "Northwind Labs", websiteDomain: null } }),
      );
      expect(opsOf(p, "create_leads")).toEqual([]);
      expect(p.events.map((e) => e.type)).toEqual(["email_received"]);
      expect(opsOf(p, "update_application")[0]?.set).not.toHaveProperty("status");
      expect(names(p)).toContain("attach_message");
    });

    it("otherwise → create_leads gmail_recruiter plus a link_thread to the lead", () => {
      const p = plan(
        snap({ companies: [] }),
        outreach({ company: { name: "Fernhill Systems", websiteDomain: null } }),
        msg({ fromEmail: "sam@fernhill.example" }),
      );
      const [op] = opsOf(p, "create_leads");
      expect(op?.source).toBe("gmail_recruiter");
      expect(op?.leads).toHaveLength(1);
      expect(op?.leads[0]).toMatchObject({
        source: "gmail_recruiter",
        companyName: "Fernhill Systems",
        contactEmail: "sam@fernhill.example",
      });
      expect(opsOf(p, "link_thread")).toEqual([
        { op: "link_thread", threadId: "t1", application: null, leadRef: op?.leads[0]?.ref },
      ]);
      expect(opsOf(p, "create_company")).toEqual([]);
      expect(p.autoApply).toBe(true);
    });

    it("a lone rejected or abandoned application is not attached to; the outreach becomes a lead", () => {
      for (const status of ["rejected", "abandoned"] as const) {
        const p = plan(
          snap({ apps: [{ id: "a1", status }] }),
          outreach({ company: { name: "Northwind Labs", websiteDomain: null }, leads: [] }),
        );
        expect(opsOf(p, "update_application")).toEqual([]);
        expect(opsOf(p, "create_leads")[0]?.source).toBe("gmail_recruiter");
        expect(opsOf(p, "create_leads")[0]?.leads[0]).toMatchObject({
          companyName: "Northwind Labs",
          title: "Backend Engineer",
        });
      }
    });

    it("several active applications and no role match → ambiguous_match", () => {
      const p = plan(
        snap({
          apps: [
            { id: "a1", title: "Backend Engineer" },
            { id: "a2", title: "Data Analyst" },
          ],
        }),
        outreach({
          company: { name: "Northwind Labs", websiteDomain: null },
          role: { title: "Designer", seniority: null },
        }),
      );
      expect(p.review?.kind).toBe("ambiguous_match");
      expect(p.review?.candidates).toHaveLength(2);
    });

    it("an outreach with no usable company or role goes to review instead of vanishing", () => {
      const p = plan(snap({ companies: [] }), outreach({ company: null, role: null, leads: [] }));
      expect(p.autoApply).toBe(false);
      expect(p.review?.kind).toBe("low_confidence");
    });
  });

  it("candidate_outbound with no match and not_job_related → messageOutcome triaged_out and no operations", () => {
    const outbound = plan(
      snap({ companies: [] }),
      ext({ category: "candidate_outbound", confidence: 0.4 }),
      msg({ direction: "outbound" }),
    );
    const notJob = plan(snap(), ext({ category: "not_job_related", confidence: 0.4 }));
    for (const p of [outbound, notJob]) {
      expect(p.messageOutcome).toBe("triaged_out");
      expect(p.operations).toEqual([]);
      expect(p.events).toEqual([]);
      expect(p.autoApply).toBe(true);
      expect(p.review).toBeNull();
    }
  });

  it("an interview reschedule updates the matching interview with its version", () => {
    const existing: InterviewRef = {
      id: "i1",
      version: 6,
      kind: "technical",
      status: "scheduled",
      startsAt: new Date("2026-10-27T16:00:00Z"),
      icsUid: "uid-9",
    };
    const p = plan(
      snap({ apps: [{ id: "a1", status: "interviewing" }], interviews: { a1: [existing] } }),
      ext({ category: "interview_reschedule", interview: interviewOf() }),
      msg({
        icsEvents: [
          ics({ uid: "uid-9", start: "2026-10-29T17:00:00.000Z", end: "2026-10-29T18:00:00.000Z" }),
        ],
      }),
    );
    expect(opsOf(p, "upsert_interview")[0]).toMatchObject({
      application: { id: "a1" },
      interviewId: "i1",
      expectedVersion: 6,
    });
    expect(p.events.map((e) => e.type)).toEqual(["interview_updated"]);
    expect(p.events[0]?.summary).toBe("Interview rescheduled to Thu, Oct 29, 11:00");
    expect(opsOf(p, "update_application")[0]?.set).not.toHaveProperty("status");
  });

  it("an interview cancellation cancels the interview and records interview_cancelled", () => {
    const p = plan(
      snap({
        apps: [{ id: "a1", status: "interviewing" }],
        interviews: {
          a1: [
            {
              id: "i1",
              version: 2,
              kind: "technical",
              status: "scheduled",
              startsAt: new Date("2026-10-27T16:00:00Z"),
              icsUid: null,
            },
          ],
        },
      }),
      ext({ category: "interview_cancellation", interview: null }),
    );
    expect(opsOf(p, "cancel_interview")).toEqual([
      { op: "cancel_interview", interviewId: "i1", expectedVersion: 2 },
    ]);
    expect(p.events.map((e) => e.type)).toEqual(["interview_cancelled"]);
    expect(p.events[0]?.summary).toBe("Interview cancelled");
  });

  it("a reschedule for an unknown application → ambiguous_match with no candidates; create_new makes the application", () => {
    const s = snap({ companies: [] });
    const e = ext({
      category: "interview_reschedule",
      interview: interviewOf({ kind: "recruiter_screen", startsAt: "2026-10-28T09:00:00-06:00" }),
    });
    const p = plan(s, e);
    expect(p.review).toMatchObject({ kind: "ambiguous_match", candidates: [] });
    const created = plan(s, e, msg(), { action: "create_new" });
    expect(created.autoApply).toBe(true);
    expect(opsOf(created, "create_application")[0]).toMatchObject({ status: "screening" });
    expect(opsOf(created, "upsert_interview")[0]).toMatchObject({
      application: { ref: "new:application" },
    });
  });

  it("a thread linked to a lead: a confirmation converts it, anything else is a lead event", () => {
    const s = snap({
      leads: [{ id: "l1", status: "new", version: 3 }],
      threadLinks: [["t1", { applicationId: null, leadId: "l1" }]],
    });
    const converted = plan(s, ext({ category: "interview_invite", interview: interviewOf() }));
    expect(opsOf(converted, "convert_lead")[0]).toMatchObject({
      leadId: "l1",
      expectedVersion: 3,
      status: "interviewing",
    });
    const note = plan(s, ext({ category: "status_update_other" }));
    expect(note.operations).toEqual([]);
    expect(note.events).toEqual([
      {
        subject: { id: "l1" },
        subjectType: "lead",
        type: "email_received",
        summary: "Email from Northwind Labs",
        data: null,
      },
    ]);
  });

  it("does not link a thread that is already linked to the application", () => {
    const p = plan(
      snap({
        apps: [{ id: "a1" }],
        threadLinks: [["t1", { applicationId: "a1", leadId: null }]],
      }),
      ext({ category: "status_update_other" }),
    );
    expect(opsOf(p, "link_thread")).toEqual([]);
    expect(opsOf(p, "attach_message")).toHaveLength(1);
  });

  it("no identifiable company on a creating email → ambiguous_match with no candidates", () => {
    const p = plan(snap({ companies: [] }), ext({ company: null }), msg({ fromEmail: null }));
    expect(p.autoApply).toBe(false);
    expect(p.review).toMatchObject({ kind: "ambiguous_match", candidates: [] });
  });

  describe("owner choices", () => {
    it("apply clears low confidence; edit_apply applies the edits; both turn autoApply on", () => {
      const s = snap({ apps: [{ id: "a1" }] });
      const e = ext({ category: "status_update_other", confidence: 0.5 });
      expect(plan(s, e).review?.kind).toBe("low_confidence");
      const applied = plan(s, e, msg(), { action: "apply" });
      expect(applied.autoApply).toBe(true);
      expect(applied.review).toBeNull();

      const edited = plan(s, e, msg(), { action: "edit_apply", edits: { category: "rejection" } });
      expect(edited.autoApply).toBe(true);
      expect(opsOf(edited, "update_application")[0]?.set.status).toBe("rejected");
    });

    it("apply or reopen on an unexpected transition applies it; timeline_only records the email without the status", () => {
      const s = snap({ apps: [{ id: "a1", status: "rejected" }] });
      const e = ext({ category: "interview_invite", interview: interviewOf() });
      expect(plan(s, e).review?.kind).toBe("unexpected_transition");
      for (const action of ["apply", "reopen"] as const) {
        const p = plan(s, e, msg(), { action });
        expect(p.autoApply).toBe(true);
        expect(opsOf(p, "update_application")[0]?.set.status).toBe("interviewing");
        expect(p.events[0]).toMatchObject({
          type: "status_changed",
          summary: "Moved to Interviewing",
        });
      }
      const timeline = plan(s, e, msg(), { action: "timeline_only" });
      expect(timeline.autoApply).toBe(true);
      expect(opsOf(timeline, "update_application")[0]?.set).not.toHaveProperty("status");
      expect(timeline.events.map((x) => x.type)).toEqual(["email_received"]);
      expect(opsOf(timeline, "upsert_interview")).toEqual([]);
    });

    it("attach to an application that raises its own unexpected transition still asks the owner", () => {
      const s = snap({
        apps: [
          { id: "a1", status: "rejected" },
          { id: "a2", title: "Data Analyst" },
        ],
      });
      const p = plan(s, ext({ category: "application_confirmation" }), msg(), {
        action: "attach",
        applicationId: "a1",
      });
      expect(p.review?.kind).toBe("unexpected_transition");
    });

    it("attach to an application missing from the snapshot keeps the ambiguity open", () => {
      const p = plan(
        snap({ apps: [{ id: "a1" }, { id: "a2" }] }),
        ext({ category: "rejection" }),
        msg(),
        {
          action: "attach",
          applicationId: "gone",
        },
      );
      expect(p.autoApply).toBe(false);
      expect(p.review?.kind).toBe("ambiguous_match");
    });
  });

  it("every operation on an existing record carries its expectedVersion", () => {
    const interviewsOf = (): Record<string, InterviewRef[]> => ({
      a1: [
        {
          id: "i1",
          version: 11,
          kind: "technical",
          status: "scheduled",
          startsAt: new Date("2026-10-27T16:00:00Z"),
          icsUid: null,
        },
      ],
    });
    const plans = [
      plan(snap({ apps: [{ id: "a1", version: 3 }] }), ext({ category: "rejection" })),
      plan(
        snap({ apps: [{ id: "a1", version: 3 }], interviews: interviewsOf() }),
        ext({ category: "interview_reschedule", interview: interviewOf() }),
      ),
      plan(
        snap({ apps: [{ id: "a1", version: 3 }], interviews: interviewsOf() }),
        ext({ category: "interview_cancellation", interview: null }),
      ),
      plan(
        snap({ leads: [{ id: "l1", version: 2, jobKey: jobKey(ASHBY_URL) }] }),
        ext({ jobUrl: ASHBY_URL }),
      ),
      plan(
        snap({ apps: [{ id: "a1", version: 3, followUpDue: true }] }),
        ext({ category: "candidate_outbound" }),
        msg({ direction: "outbound" }),
      ),
    ];
    let checked = 0;
    for (const p of plans) {
      for (const op of p.operations) {
        if (op.op === "update_application" && "id" in op.application) {
          expect(typeof op.expectedVersion).toBe("number");
          checked += 1;
        }
        if (op.op === "upsert_interview" && op.interviewId !== null) {
          expect(typeof op.expectedVersion).toBe("number");
          checked += 1;
        }
        if (op.op === "cancel_interview" || op.op === "convert_lead") {
          expect(typeof op.expectedVersion).toBe("number");
          checked += 1;
        }
        if (op.op === "update_application" && "ref" in op.application) {
          expect(op.expectedVersion).toBeNull();
        }
      }
    }
    expect(checked).toBe(7);
  });

  it("is deterministic: the same inputs give a deep-equal plan", () => {
    const make = () =>
      plan(
        snap({
          apps: [
            { id: "a1", status: "screening" },
            { id: "a2", title: "Data Analyst" },
          ],
        }),
        ext({
          category: "interview_invite",
          interview: interviewOf({ startsAt: "2026-10-28T09:00:00-06:00" }),
        }),
        msg({ icsEvents: [ics({ uid: "u", start: "2026-10-27T16:00:00.000Z" })] }),
      );
    expect(make()).toEqual(make());
  });

  it("does not mutate its inputs", () => {
    const s = snap({ apps: [{ id: "a1" }] });
    const e = ext({ category: "rejection" });
    const m = msg();
    const before = JSON.stringify([e, m, [...s.applicationState]]);
    plan(s, e, m);
    expect(JSON.stringify([e, m, [...s.applicationState]])).toBe(before);
  });

  it("a possible-duplicate notice is not raised when the lead's own company is used", () => {
    const key = jobKey(ASHBY_URL);
    const p = plan(
      snap({ leads: [{ id: "l1", jobKey: key }] }),
      ext({ jobUrl: ASHBY_URL, company: { name: "Northwind Labs Europe", websiteDomain: null } }),
    );
    expect(p.notices).toEqual([]);
    expect(opsOf(p, "create_company")).toEqual([]);
  });

  it("categories: assessment, offer and acceptance-free statuses map directly", () => {
    const cats: [EmailCategory, ApplicationStatus][] = [
      ["assessment", "assessment"],
      ["offer", "offer"],
    ];
    for (const [category, status] of cats) {
      const p = plan(snap({ apps: [{ id: "a1" }] }), ext({ category }));
      expect(opsOf(p, "update_application")[0]?.set.status).toBe(status);
      expect(p.events[0]?.summary).toBe(
        `Moved to ${status.charAt(0).toUpperCase()}${status.slice(1)}`,
      );
    }
  });
});
