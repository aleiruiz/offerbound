import { describe, expect, it } from "vitest";
import { SearchResultSchema } from "@offerbound/contracts";
import { jobKey, normalizeCompanyName } from "@offerbound/domain";
import { loadLeadBatches } from "./leads.js";

describe("lead batch fixtures", () => {
  const batches = loadLeadBatches();

  it("loads at least 3 batches of 10 valid search leads, in file order", () => {
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const batch of batches) {
      expect(SearchResultSchema.safeParse(batch).success).toBe(true);
      expect(batch.leads).toHaveLength(10);
    }
  });

  it("gives every lead an official URL with a job key, and no company twice", () => {
    const companies = new Set<string>();
    const keys = new Set<string>();
    for (const lead of batches.flatMap((b) => b.leads)) {
      expect(lead.jobUrl, lead.company).not.toBeNull();
      const key = jobKey(lead.jobUrl ?? "");
      expect(key, lead.jobUrl ?? "").not.toBeNull();
      keys.add(key ?? "");
      companies.add(normalizeCompanyName(lead.company));
      expect(lead.evidenceUrls.length).toBeGreaterThan(0);
    }
    expect(companies.size).toBe(batches.length * 10);
    expect(keys.size).toBe(batches.length * 10);
  });

  it("covers the variety the intake and ranking tests need", () => {
    const leads = batches.flatMap((b) => b.leads);
    expect(new Set(leads.map((l) => l.workMode)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(leads.map((l) => l.seniority)).size).toBeGreaterThanOrEqual(4);
    expect(leads.some((l) => l.eligible === "no")).toBe(true);
    expect(leads.some((l) => l.compensation.isEstimate)).toBe(true);
    expect(leads.some((l) => l.compensation.min === null)).toBe(true);
    expect(leads.some((l) => l.seniority === "junior" || l.seniority === "manager")).toBe(true);
  });

  it("uses only .example hosts and the ATS hosts of TECHNICAL_SPEC §5.3", () => {
    const ats = ["jobs.ashbyhq.com", "jobs.lever.co", "boards.greenhouse.io", "apply.workable.com"];
    const hosts = (urls: (string | null)[]): string[] =>
      urls.flatMap((u) => (u === null ? [] : [new URL(u).hostname]));
    for (const lead of batches.flatMap((b) => b.leads)) {
      for (const host of hosts([lead.jobUrl, ...lead.evidenceUrls])) {
        expect(host.endsWith(".example") || ats.includes(host), host).toBe(true);
      }
      if (lead.companyDomain !== null) expect(lead.companyDomain.endsWith(".example")).toBe(true);
    }
  });
});
