import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EmailFixtureSchema,
  ExtractionSchema,
  type EmailCategory,
  type EmailFixture,
} from "@offerbound/contracts";
import {
  ATS_DOMAINS,
  JOB_ALERT_SENDERS,
  JOB_BOARD_DOMAINS,
  bareAddress,
  isNonCompanyDomain,
  jobKey,
  registrableDomain,
  triageByRules,
  type TriageLookups,
} from "@offerbound/domain";
import {
  FIXTURE_BACKFILL_SINCE,
  FIXTURE_OWNER_EMAIL,
  FIXTURE_SEED_APPLICATIONS,
  loadEmailFixtures,
} from "./emails.js";

const fixtures = loadEmailFixtures();

const byCategory = (category: EmailCategory): EmailFixture[] =>
  fixtures.filter((f) => f.expected.category === category);

const count = (list: EmailFixture[], predicate: (f: EmailFixture) => boolean): number =>
  list.filter(predicate).length;

/**
 * The state the pipeline has built up when a fixture arrives: the fixtures are processed in
 * order, and each one that is applied links its thread and teaches the pipeline its company's
 * domains (TECHNICAL_SPEC §6.2, §6.4). Seed applications are name-only, so they add no domains.
 */
function replay(
  source: readonly EmailFixture[] = fixtures,
): { fixture: EmailFixture; lookups: TriageLookups }[] {
  const linkedThreadIds = new Set<string>();
  const companyDomains = new Set<string>();
  const steps: { fixture: EmailFixture; lookups: TriageLookups }[] = [];
  for (const fixture of source) {
    steps.push({
      fixture,
      lookups: {
        linkedThreadIds: new Set(linkedThreadIds),
        contactEmails: new Set(),
        companyDomains: new Set(companyDomains),
        ignoreList: [],
      },
    });
    const extraction = fixture.llm.extraction;
    if (fixture.expected.outcome !== "applied" || extraction === null) continue;
    if (extraction.category === "job_alert") continue;
    linkedThreadIds.add(fixture.threadId);
    if (fixture.labels.includes("SENT") || extraction.category === "recruiter_outreach") continue;
    const sender = registrableDomain(fixture.headers.from);
    for (const domain of [sender, extraction.company?.websiteDomain ?? null]) {
      if (domain !== null && !isNonCompanyDomain(domain)) companyDomains.add(domain);
    }
  }
  return steps;
}

/** Replays `source` in order and checks each fixture's llm.triage / expected.triage against the rules. */
function expectTriageMatchesRules(source: readonly EmailFixture[]): void {
  for (const { fixture: f, lookups } of replay(source)) {
    const decision = triageByRules(
      {
        labelIds: f.labels,
        internalDate: new Date(f.internalDate),
        backfillSince: FIXTURE_BACKFILL_SINCE,
        threadId: f.threadId,
        from: f.headers.from,
        to: f.headers.to,
        cc: f.headers.cc ?? [],
        ownerEmail: FIXTURE_OWNER_EMAIL,
      },
      lookups,
    );
    if (decision.decision === "llm") {
      const triage = f.llm.triage;
      expect(triage, `${f.id} needs an llm.triage`).not.toBeNull();
      expect(triage?.id).toBe(f.id);
      const proceeds = triage?.jobRelated === true || (triage?.confidence ?? 1) < 0.7;
      expect(f.expected.triage, f.id).toBe(proceeds ? "job_related" : "triaged_out");
    } else {
      expect(f.llm.triage, `${f.id} is decided by ${decision.rule}`).toBeNull();
      expect(f.expected.triage, f.id).toBe(decision.decision);
    }
  }
}

describe("email fixtures", () => {
  it("loads at least 48 fixtures and every one validates", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(48);
    for (const f of fixtures) expect(EmailFixtureSchema.safeParse(f).success).toBe(true);
    const sorted = [...fixtures].sort(
      (a, b) => a.internalDate.localeCompare(b.internalDate) || a.id.localeCompare(b.id),
    );
    expect(fixtures.map((f) => f.id)).toEqual(sorted.map((f) => f.id));
  });

  it("matches the §15 mix", () => {
    const confirmations = byCategory("application_confirmation");
    expect(confirmations).toHaveLength(6);
    const senderDomain = (f: EmailFixture): string | null => registrableDomain(f.headers.from);
    for (const ats of [
      "ashbyhq.com",
      "lever.co",
      "greenhouse-mail.io",
      "myworkday.com",
      "personio.de",
    ]) {
      expect(count(confirmations, (f) => senderDomain(f) === ats)).toBe(1);
    }
    expect(count(confirmations, (f) => !ATS_DOMAINS.includes(senderDomain(f) ?? ""))).toBe(1);

    const rejections = byCategory("rejection");
    expect(rejections).toHaveLength(6);
    expect(count(rejections, (f) => f.llm.extraction?.language === "es")).toBe(2);

    const invites = byCategory("interview_invite");
    expect(invites).toHaveLength(6);
    expect(count(invites, (f) => f.ics !== undefined)).toBe(3);
    expect(
      count(
        invites,
        (f) =>
          f.llm.extraction?.interview?.schedulingUrl != null &&
          f.llm.extraction.interview.startsAt === null,
      ),
    ).toBe(1);
    expect(count(invites, (f) => f.llm.extraction?.interview?.kind === "recruiter_screen")).toBe(1);
    expect(count(invites, (f) => /next Tuesday 3pm EST/.test(f.bodyText ?? ""))).toBe(1);

    expect(byCategory("interview_reschedule")).toHaveLength(3);
    expect(byCategory("interview_cancellation")).toHaveLength(2);
    expect(byCategory("assessment")).toHaveLength(3);
    expect(byCategory("offer")).toHaveLength(2);

    const outreach = byCategory("recruiter_outreach");
    expect(outreach).toHaveLength(4);
    expect(count(outreach, (f) => f.llm.extraction?.contact?.isAgency === true)).toBe(1);
    expect(
      count(outreach, (f) => bareAddress(f.headers.from) === "messages-noreply@linkedin.com"),
    ).toBe(1);

    const alerts = byCategory("job_alert");
    expect(alerts).toHaveLength(4);
    const alertLeads = (f: EmailFixture): number => f.llm.extraction?.leads.length ?? 0;
    expect(
      count(
        alerts,
        (f) => bareAddress(f.headers.from).endsWith("@linkedin.com") && alertLeads(f) === 5,
      ),
    ).toBe(1);
    expect(count(alerts, (f) => bareAddress(f.headers.from).endsWith("@indeed.com"))).toBe(1);
    expect(count(alerts, (f) => bareAddress(f.headers.from).endsWith("@glassdoor.com"))).toBe(1);
    expect(
      count(alerts, (f) => {
        const leads = f.llm.extraction?.leads ?? [];
        return leads.length === 2 && leads[0]?.company === leads[1]?.company;
      }),
    ).toBe(1);
    for (const f of alerts) expect(f.expected.leads).toBe(alertLeads(f));

    const followUps = byCategory("candidate_outbound");
    expect(followUps).toHaveLength(2);
    for (const f of followUps) expect(f.labels).toContain("SENT");

    const ambiguous = fixtures.filter((f) => f.expected.reviewKind === "ambiguous_match");
    expect(ambiguous).toHaveLength(2);

    const decoys = fixtures.filter(
      (f) => f.expected.outcome === "triaged_out" && f.expected.category === null,
    );
    expect(decoys).toHaveLength(8);
    for (const f of decoys) expect(f.llm.extraction).toBeNull();

    expect(fixtures.filter((f) => f.expected.outcome === "skipped")).toHaveLength(2);
  });

  it("shares threads between confirmations and later messages", () => {
    const confirmationThreads = new Set(
      byCategory("application_confirmation").map((f) => f.threadId),
    );
    for (const category of ["rejection", "interview_invite", "interview_reschedule"] as const) {
      const shared = byCategory(category).filter((f) => confirmationThreads.has(f.threadId));
      expect(shared.length, category).toBeGreaterThan(0);
    }
    for (const f of fixtures) {
      if (
        confirmationThreads.has(f.threadId) &&
        f.expected.category !== "application_confirmation"
      ) {
        const first = fixtures.find((g) => g.threadId === f.threadId);
        expect(first?.expected.category).toBe("application_confirmation");
      }
    }
  });

  it("every llm.extraction passes ExtractionSchema and every llm.triage is null when a rule decides", () => {
    for (const f of fixtures) {
      if (f.llm.extraction !== null) {
        expect(ExtractionSchema.safeParse(f.llm.extraction).success, f.id).toBe(true);
      }
    }
    expectTriageMatchesRules(fixtures);
  });

  it("replaying only the demo fixtures matches their expected triage", () => {
    const demo = fixtures.filter((f) => f.demo);
    expect(demo.length).toBeGreaterThanOrEqual(12);
    expectTriageMatchesRules(demo);
  });

  it("derives expected.jobKey from the fixture's job URL", () => {
    let withKey = 0;
    for (const f of fixtures) {
      const url = f.llm.extraction?.jobUrl ?? null;
      if (url === null) {
        expect(f.expected.jobKey, f.id).toBeUndefined();
      } else {
        expect(f.expected.jobKey, f.id).toBe(jobKey(url));
        withKey += 1;
      }
    }
    expect(withKey).toBeGreaterThanOrEqual(7);
  });

  it("keeps expected outcomes consistent with the extraction", () => {
    for (const f of fixtures) {
      const { expected, llm } = f;
      const extraction = llm.extraction;
      if (expected.triage !== "job_related") {
        expect(extraction, f.id).toBeNull();
        expect(expected.category, f.id).toBeNull();
        expect(["triaged_out", "skipped"], f.id).toContain(expected.outcome);
        continue;
      }
      expect(extraction, f.id).not.toBeNull();
      if (extraction === null) continue;
      expect(expected.category, f.id).toBe(extraction.category);
      expect(expected.company, f.id).toBe(extraction.company?.name ?? null);
      expect(expected.role, f.id).toBe(extraction.role?.title ?? null);
      expect(extraction.summary.length, f.id).toBeLessThanOrEqual(140);
      if (expected.reviewKind === "low_confidence") {
        expect(expected.outcome).toBe("needs_review");
        expect(extraction.confidence, f.id).toBeLessThan(0.8);
      } else if (expected.reviewKind === "ambiguous_match") {
        expect(expected.outcome).toBe("needs_review");
        expect(extraction.confidence, f.id).toBeGreaterThanOrEqual(0.8);
      } else {
        expect(expected.outcome, f.id).toBe("applied");
        expect(extraction.confidence, f.id).toBeGreaterThanOrEqual(0.8);
      }
      const startsAt = extraction.interview?.startsAt ?? null;
      if (["interview_invite", "interview_reschedule"].includes(extraction.category) && startsAt) {
        expect(expected.interviewStart, f.id).toBe(new Date(startsAt).toISOString());
      } else {
        expect(expected.interviewStart, f.id).toBeUndefined();
      }
      if (extraction.category === "job_alert") expect(expected.leads, f.id).toBeDefined();
    }
    const lowConfidence = fixtures.filter((f) => f.expected.reviewKind === "low_confidence");
    expect(lowConfidence).toHaveLength(1);
    expect(lowConfidence[0]?.expected.category).toBe("rejection");
    expect(lowConfidence[0]?.llm.extraction?.confidence).toBe(0.72);
  });

  it("seeds two applications for each ambiguous fixture's company", () => {
    const ambiguous = fixtures.filter((f) => f.expected.reviewKind === "ambiguous_match");
    for (const f of ambiguous) {
      const seeds = FIXTURE_SEED_APPLICATIONS.filter((s) => s.company === f.expected.company);
      expect(seeds, f.id).toHaveLength(2);
      expect(new Set(seeds.map((s) => s.role)).size).toBe(2);
    }
  });

  it("uses only .example domains apart from §5.3 ATS and alert senders", () => {
    const alertHosts = JOB_ALERT_SENDERS.map((s) => registrableDomain(s));
    const allowed = new Set<string>([
      ...ATS_DOMAINS.filter((d) => d !== "rippling.com"),
      ...JOB_BOARD_DOMAINS,
      ...alertHosts.filter((d): d is string => d !== null),
      "linkedin.com",
    ]);
    const hostAllowed = (host: string): boolean => {
      const h = host.toLowerCase().replace(/\.$/, "");
      if (h.endsWith(".example")) return true;
      const domain = registrableDomain(h);
      return domain !== null && allowed.has(domain);
    };
    const hosts = (text: string): string[] => [
      ...[...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)].map(
        (m) => m[1] ?? "",
      ),
      ...[...text.matchAll(/https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)].map(
        (m) => m[1] ?? "",
      ),
    ];
    for (const f of fixtures) {
      for (const host of hosts(JSON.stringify(f))) {
        expect(hostAllowed(host), `${f.id}: ${host}`).toBe(true);
      }
    }
    // The owner address is a fictional .example address and appears in the README.
    expect(FIXTURE_OWNER_EMAIL.endsWith(".example")).toBe(true);
    const readme = readFileSync(
      new URL("../../../../fixtures/emails/README.md", import.meta.url),
      "utf8",
    );
    expect(readme).toContain(FIXTURE_OWNER_EMAIL);
  });

  it("has unique ids and at least 12 demo fixtures", () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    const demo = fixtures.filter((f) => f.demo);
    expect(demo.length).toBeGreaterThanOrEqual(12);
    const demoCategories = new Set(demo.map((f) => f.expected.category));
    expect(demoCategories.size).toBeGreaterThanOrEqual(8);
  });

  it("addresses every inbound fixture to the owner", () => {
    for (const f of fixtures.filter((x) => !x.labels.includes("SENT"))) {
      expect(f.headers.to.map(bareAddress), f.id).toContain(FIXTURE_OWNER_EMAIL);
    }
    for (const f of fixtures.filter((x) => x.labels.includes("SENT"))) {
      expect(bareAddress(f.headers.from), f.id).toBe(FIXTURE_OWNER_EMAIL);
    }
  });
});

describe("loadEmailFixtures", () => {
  const makeDir = (): string => mkdtempSync(join(tmpdir(), "offerbound-fixtures-"));
  const sample = (id: string, internalDate: string): EmailFixture => {
    const base = fixtures.find((f) => f.expected.outcome === "triaged_out");
    if (base === undefined) throw new Error("no sample fixture");
    return { ...base, id, internalDate };
  };

  it("sorts by internalDate, then id", () => {
    const dir = makeDir();
    for (const f of [
      sample("b", "2026-09-02T10:00:00.000Z"),
      sample("c", "2026-09-01T10:00:00.000Z"),
      sample("a", "2026-09-02T10:00:00.000Z"),
    ]) {
      writeFileSync(join(dir, `${f.id}.json`), JSON.stringify(f));
    }
    expect(loadEmailFixtures(dir).map((f) => f.id)).toEqual(["c", "a", "b"]);
  });

  it("names the file that fails validation and ignores subdirectories", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "ignored.json"), "{}");
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ id: "broken" }));
    expect(() => loadEmailFixtures(dir)).toThrow(/broken\.json/);
  });

  it("names the file that holds malformed JSON", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "garbled.json"), "{ not json");
    expect(() => loadEmailFixtures(dir)).toThrow(/garbled\.json.*not valid JSON/);
  });
});
