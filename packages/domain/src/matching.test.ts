import { describe, expect, it } from "vitest";
import type { EmailCategory } from "@offerbound/contracts";
import type { CompanyRef, CompanyResolution } from "./company.js";
import { matchApplication, rolesSimilar, type MatchSnapshot } from "./matching.js";

const company = (id: string, name: string, groupId: string | null = null): CompanyRef => ({
  id,
  name,
  normalizedName: name.toLowerCase(),
  aliases: [],
  domains: [],
  atsSlugs: [],
  groupId,
});

const app = (
  id: string,
  companyId: string,
  title: string,
  status: MatchSnapshot["applications"][number]["status"] = "applied",
  jobKey: string | null = null,
): MatchSnapshot["applications"][number] => ({ id, companyId, title, status, jobKey });

const lead = (
  id: string,
  companyId: string,
  title: string,
  jobKey: string | null = null,
  status: MatchSnapshot["leads"][number]["status"] = "shortlisted",
): MatchSnapshot["leads"][number] => ({ id, companyId, title, status, jobKey });

const snapshot = (over: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  threadLinks: new Map(),
  applications: [],
  leads: [],
  companies: [company("c1", "Northwind Labs"), company("c2", "Fernhill Systems")],
  ...over,
});

const at = (companyId: string): CompanyResolution => ({
  kind: "existing",
  companyId,
  via: "domain",
});

const message = (
  over: Partial<{
    threadId: string;
    jobKey: string | null;
    company: CompanyResolution;
    roleTitle: string | null;
    category: EmailCategory;
  }> = {},
) => ({
  threadId: "t1",
  jobKey: null,
  company: at("c1"),
  roleTitle: "Backend Engineer",
  category: "interview_invite" as EmailCategory,
  ...over,
});

describe("matchApplication", () => {
  it("a linked thread wins over everything else", () => {
    const s = snapshot({
      threadLinks: new Map([["t1", { applicationId: "a-linked", leadId: null }]]),
      applications: [
        app("a-linked", "c2", "Data Analyst"),
        app("a-key", "c1", "Backend Engineer", "applied", "key-1"),
        app("a-co", "c1", "Backend Engineer"),
      ],
    });
    expect(matchApplication(s, message({ jobKey: "key-1" }))).toEqual({
      kind: "application",
      applicationId: "a-linked",
      via: "thread",
    });
  });

  it("a thread linked to a lead is a lead thread", () => {
    const s = snapshot({
      threadLinks: new Map([["t1", { applicationId: null, leadId: "l1" }]]),
      applications: [app("a1", "c1", "Backend Engineer")],
    });
    expect(matchApplication(s, message())).toEqual({ kind: "lead_thread", leadId: "l1" });
  });

  it("the job key matches before the company", () => {
    const s = snapshot({
      applications: [
        app("a-co", "c1", "Backend Engineer"),
        app("a-key", "c2", "Platform Engineer", "interviewing", "key-1"),
      ],
    });
    expect(matchApplication(s, message({ jobKey: "key-1" }))).toEqual({
      kind: "application",
      applicationId: "a-key",
      via: "job_key",
    });
  });

  it("one non-terminal application at the company → it; a rejected one counts; accepted and withdrawn don't", () => {
    const only = (status: MatchSnapshot["applications"][number]["status"]) =>
      matchApplication(
        snapshot({ applications: [app("a1", "c1", "Something Else", status)] }),
        message(),
      );
    for (const status of ["applied", "interviewing", "offer", "rejected", "abandoned"] as const) {
      expect(only(status)).toEqual({ kind: "application", applicationId: "a1", via: "company" });
    }
    for (const status of ["accepted", "withdrawn"] as const) {
      expect(only(status)).toEqual({ kind: "create", convertLeadId: null });
    }
    // A terminal sibling does not make a single open application ambiguous.
    const s = snapshot({
      applications: [
        app("a-open", "c1", "Backend Engineer"),
        app("a-done", "c1", "Backend Engineer", "withdrawn"),
      ],
    });
    expect(matchApplication(s, message())).toMatchObject({
      kind: "application",
      applicationId: "a-open",
    });
  });

  it("several applications → the single one with role Jaccard ≥ 0.6", () => {
    const s = snapshot({
      applications: [
        app("a1", "c1", "Backend Engineer"),
        app("a2", "c1", "Senior Data Analyst Intern"),
      ],
    });
    expect(matchApplication(s, message({ roleTitle: "Senior Backend Engineer" }))).toEqual({
      kind: "application",
      applicationId: "a1",
      via: "company",
    });
  });

  it("two pass the role check → ambiguous with both; none pass → ambiguous with every candidate", () => {
    const two = snapshot({
      applications: [
        app("a1", "c1", "Backend Engineer", "applied"),
        app("a2", "c1", "Backend Engineer", "screening"),
        app("a3", "c1", "Designer", "rejected"),
      ],
    });
    expect(matchApplication(two, message())).toEqual({
      kind: "ambiguous",
      candidates: [
        { id: "a1", label: "Northwind Labs — Backend Engineer (Applied)" },
        { id: "a2", label: "Northwind Labs — Backend Engineer (Screening)" },
      ],
    });
    const none = snapshot({
      applications: [app("a1", "c1", "Designer"), app("a3", "c1", "Support Lead", "rejected")],
    });
    expect(matchApplication(none, message())).toEqual({
      kind: "ambiguous",
      candidates: [
        { id: "a1", label: "Northwind Labs — Designer (Applied)" },
        { id: "a3", label: "Northwind Labs — Support Lead (Rejected)" },
      ],
    });
    // No extracted role: nothing can pass.
    expect(matchApplication(two, message({ roleTitle: null }))).toMatchObject({
      kind: "ambiguous",
      candidates: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
    });
  });

  it("an application at another company in the same group matches", () => {
    const s = snapshot({
      companies: [company("c1", "Northwind Labs"), company("c3", "Northwind Cloud", "c1")],
      applications: [app("a3", "c3", "Backend Engineer")],
    });
    expect(matchApplication(s, message({ company: at("c1") }))).toEqual({
      kind: "application",
      applicationId: "a3",
      via: "company",
    });
    expect(matchApplication(s, message({ company: at("c3") }))).toMatchObject({
      kind: "application",
      applicationId: "a3",
    });
  });

  it("no application and a creating category → create; a lead with the same job key → create with convertLeadId", () => {
    const creating: EmailCategory[] = [
      "application_confirmation",
      "rejection",
      "interview_invite",
      "assessment",
      "offer",
    ];
    for (const category of creating) {
      expect(matchApplication(snapshot(), message({ category }))).toEqual({
        kind: "create",
        convertLeadId: null,
      });
    }
    const s = snapshot({
      leads: [lead("l-other", "c2", "Platform Engineer"), lead("l-key", "c2", "Whatever", "key-9")],
    });
    // The job key wins even when the company could not be resolved.
    expect(
      matchApplication(
        s,
        message({
          jobKey: "key-9",
          company: { kind: "none" },
          category: "application_confirmation",
        }),
      ),
    ).toEqual({ kind: "create", convertLeadId: "l-key" });
  });

  it("a lead at the company with role Jaccard ≥ 0.6 → create with convertLeadId", () => {
    const s = snapshot({
      leads: [
        lead("l-far", "c1", "Designer"),
        lead("l-applied", "c1", "Backend Engineer", null, "applied"),
        lead("l-near", "c1", "Backend Engineer", null, "new"),
        lead("l-elsewhere", "c2", "Backend Engineer"),
      ],
    });
    expect(matchApplication(s, message({ category: "application_confirmation" }))).toEqual({
      kind: "create",
      convertLeadId: "l-near",
    });
    expect(
      matchApplication(s, message({ category: "application_confirmation", roleTitle: "Chef" })),
    ).toEqual({ kind: "create", convertLeadId: null });
    expect(
      matchApplication(s, message({ category: "application_confirmation", roleTitle: null })),
    ).toEqual({ kind: "create", convertLeadId: null });
  });

  it("a reschedule for an unknown application → ambiguous with no candidates", () => {
    for (const category of [
      "interview_reschedule",
      "interview_cancellation",
      "status_update_other",
    ] as const) {
      expect(matchApplication(snapshot(), message({ category }))).toEqual({
        kind: "ambiguous",
        candidates: [],
      });
    }
  });

  it("categories that follow their own path find nothing → none", () => {
    for (const category of [
      "job_alert",
      "not_job_related",
      "candidate_outbound",
      "recruiter_outreach",
    ] as const) {
      expect(matchApplication(snapshot(), message({ category }))).toEqual({ kind: "none" });
    }
    // But an existing application still wins for outbound and outreach.
    const s = snapshot({ applications: [app("a1", "c1", "Backend Engineer")] });
    expect(matchApplication(s, message({ category: "candidate_outbound" }))).toMatchObject({
      kind: "application",
      applicationId: "a1",
    });
  });
  describe("recruiter outreach attaches only to an active application (TECHNICAL_SPEC §6.4)", () => {
    const outreach = (s: MatchSnapshot, over: Parameters<typeof message>[0] = {}) =>
      matchApplication(s, message({ category: "recruiter_outreach", ...over }));

    it("a lone rejected or abandoned application at the company is not matched", () => {
      for (const status of ["rejected", "abandoned", "accepted", "withdrawn"] as const) {
        const s = snapshot({ applications: [app("a1", "c1", "Backend Engineer", status)] });
        expect(outreach(s)).toEqual({ kind: "none" });
      }
    });

    it("a lone active application is matched", () => {
      for (const status of [
        "applied",
        "screening",
        "assessment",
        "interviewing",
        "offer",
      ] as const) {
        const s = snapshot({ applications: [app("a1", "c1", "Backend Engineer", status)] });
        expect(outreach(s)).toEqual({ kind: "application", applicationId: "a1", via: "company" });
      }
    });

    it("closed applications are ignored when counting the open ones", () => {
      const s = snapshot({
        applications: [
          app("a-closed", "c1", "Backend Engineer", "rejected"),
          app("a-open", "c1", "Data Analyst", "interviewing"),
        ],
      });
      expect(outreach(s)).toEqual({ kind: "application", applicationId: "a-open", via: "company" });
    });

    it("several active applications still go through the role check, then ambiguity", () => {
      const s = snapshot({
        applications: [
          app("a1", "c1", "Backend Engineer"),
          app("a2", "c1", "Data Analyst", "screening"),
          app("a3", "c1", "Backend Engineer", "rejected"),
        ],
      });
      expect(outreach(s)).toEqual({ kind: "application", applicationId: "a1", via: "company" });
      expect(outreach(s, { roleTitle: "Designer" })).toMatchObject({
        kind: "ambiguous",
        candidates: [{ id: "a1" }, { id: "a2" }],
      });
    });

    it("a job key hit on a closed application does not attach the outreach", () => {
      const s = snapshot({
        applications: [app("a1", "c2", "Platform Engineer", "rejected", "key-1")],
      });
      expect(outreach(s, { jobKey: "key-1", company: at("c1") })).toEqual({ kind: "none" });
    });

    it("a linked thread still wins whatever the status", () => {
      const s = snapshot({
        threadLinks: new Map([["t1", { applicationId: "a1", leadId: null }]]),
        applications: [app("a1", "c1", "Backend Engineer", "rejected")],
      });
      expect(outreach(s)).toMatchObject({
        kind: "application",
        applicationId: "a1",
        via: "thread",
      });
    });
  });
});

describe("rolesSimilar", () => {
  it("is true for the same words in another order, ignoring case, accents and punctuation", () => {
    expect(rolesSimilar("Senior Backend Engineer", "Backend Engineer, Senior")).toBe(true);
    expect(rolesSimilar("Ingeniero de Datos", "ingeniero  de datos")).toBe(true);
  });

  it("is true at the 0.6 word-overlap threshold and false just under it", () => {
    // 3 shared of 5 distinct words = 0.6
    expect(rolesSimilar("Senior Backend Engineer", "Senior Backend Engineer Remote Payments")).toBe(
      true,
    );
    // 2 shared of 5 distinct words = 0.4
    expect(rolesSimilar("Backend Engineer", "Senior Backend Developer Remote")).toBe(false);
  });

  it("is false for different roles and for titles with no words", () => {
    expect(rolesSimilar("Product Designer", "Senior Backend Engineer")).toBe(false);
    expect(rolesSimilar("", "Backend Engineer")).toBe(false);
    expect(rolesSimilar("---", "!!!")).toBe(false);
  });
});
