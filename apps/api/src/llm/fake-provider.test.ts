import { describe, expect, it } from "vitest";
import type { EmailFixture, SearchResult } from "@offerbound/contracts";
import { loadEmailFixtures } from "../fixtures/emails.js";
import { loadLeadBatches } from "../fixtures/leads.js";
import { FakeLlmProvider } from "./fake-provider.js";
import { inputKey } from "./inputs.js";
import { LlmError, type ExtractInput } from "./provider.js";

const emails = loadEmailFixtures();
const leadBatches = loadLeadBatches();

const extractInputFor = (messageId: string, body = "anything"): ExtractInput => ({
  messageId,
  headers: {
    from: null,
    fromName: null,
    fromEmail: null,
    to: [],
    cc: [],
    subject: null,
    date: null,
    listId: null,
  },
  date: "2026-10-05T12:00:00.000Z",
  ownerTimezone: "America/Monterrey",
  direction: "inbound",
  icsEvents: [],
  body,
  previousError: null,
});

const withExtraction = (): EmailFixture => {
  const f = emails.find((e) => e.llm.extraction !== null && e.expected.category === "rejection");
  if (f === undefined) throw new Error("no fixture");
  return f;
};

describe("FakeLlmProvider", () => {
  const make = () => FakeLlmProvider.fromFixtures({ emails, leadBatches });

  it("the fake returns a fixture's llm.extraction for its ExtractInput", async () => {
    const fake = make();
    const f = withExtraction();
    // The body does not matter: extraction is keyed by message id.
    const a = await fake.extract(extractInputFor(f.id, "one rendering"));
    const b = await fake.extract(extractInputFor(f.id, "another rendering"));
    expect(a.output).toEqual(f.llm.extraction);
    expect(b.output).toEqual(f.llm.extraction);
    expect(a.usage.model).toBe("fake");
  });

  it("returns a fixture's llm.triage per message id", async () => {
    const fake = make();
    const f = emails.find((e) => e.llm.triage !== null);
    if (f?.llm.triage == null) throw new Error("no triage fixture");
    const result = await fake.triage([
      { id: f.id, fromName: null, fromEmail: null, subject: "whatever", preview: "" },
    ]);
    expect(result.output.results).toEqual([f.llm.triage]);
  });

  it("the fake answers unknown extract input with status_update_other at confidence 0.5 and unknown triage input with not job-related at 0.9", async () => {
    const fake = make();
    const extracted = await fake.extract(extractInputFor("no-such-message"));
    expect(extracted.output).toMatchObject({
      category: "status_update_other",
      confidence: 0.5,
      company: null,
      role: null,
      leads: [],
    });
    const triaged = await fake.triage([
      { id: "no-such-message", fromName: null, fromEmail: null, subject: null, preview: "" },
    ]);
    expect(triaged.output.results).toEqual([
      { id: "no-such-message", jobRelated: false, confidence: 0.9 },
    ]);
  });

  it("answers a known fixture without extraction (a decoy) as not job-related", async () => {
    const decoy = emails.find(
      (e) => e.expected.triage === "triaged_out" && e.llm.extraction === null,
    );
    if (decoy === undefined) throw new Error("no decoy");
    const result = await make().extract(extractInputFor(decoy.id));
    expect(result.output).toMatchObject({ category: "not_job_related", confidence: 0.9 });
  });

  it("the fake returns lead batches in order", async () => {
    const fake = make();
    const search = {
      today: "2026-10-30",
      homeCountry: "MX",
      brief: "b",
      cvProfile: null,
      tracks: [],
      excludedSeniorities: [],
      exclusions: [],
      wanted: 10,
      round: 1,
    };
    const seen: SearchResult[] = [];
    for (let i = 0; i < leadBatches.length; i += 1) seen.push((await fake.search(search)).output);
    expect(seen).toEqual(leadBatches);
  });

  it("starts the lead batches over after the last one, however many searches run", async () => {
    const fake = make();
    const search = {
      today: "2026-10-30",
      homeCountry: "MX",
      brief: "b",
      cvProfile: null,
      tracks: [],
      excludedSeniorities: [],
      exclusions: [],
      wanted: 10,
      round: 1,
    };
    const seen: SearchResult[] = [];
    for (let i = 0; i < leadBatches.length * 2 + 1; i += 1) {
      seen.push((await fake.search(search)).output);
    }
    expect(seen).toEqual([...leadBatches, ...leadBatches, leadBatches[0]]);
  });

  it("answers search with no leads when there are no batches", async () => {
    const fake = FakeLlmProvider.fromFixtures({ emails, leadBatches: [] });
    const result = await fake.search({
      today: "2026-10-30",
      homeCountry: "MX",
      brief: "b",
      cvProfile: null,
      tracks: [],
      excludedSeniorities: [],
      exclusions: [],
      wanted: 10,
      round: 1,
    });
    expect(result.output).toEqual({ leads: [], notes: "no more" });
  });

  it("serves a registered triage answer for a message id, ahead of the fixture", async () => {
    const fake = make();
    const f = emails.find((e) => e.llm.triage !== null);
    if (f === undefined) throw new Error("no triage fixture");
    const item = { id: f.id, jobRelated: true, confidence: 0.55 };
    fake.register("triage", { messageId: f.id }, item);
    const result = await fake.triage([
      { id: f.id, fromName: null, fromEmail: null, subject: "s", preview: "" },
      { id: "unregistered", fromName: null, fromEmail: null, subject: "s", preview: "" },
    ]);
    expect(result.output.results[0]).toEqual(item);
    expect(result.output.results[1]).toMatchObject({ id: "unregistered", jobRelated: false });
  });

  it("answers rank deterministically for every lead, and parse_report and cv_profile with canned output", async () => {
    const fake = make();
    const input = {
      brief: "b",
      cvProfile: null,
      tracks: [{ key: "A", label: "Remote", priority: 1 as const }],
      homeCountry: "MX",
      leads: [
        {
          leadRef: "L1",
          company: "Acme",
          title: "Engineer",
          locationText: null,
          workMode: "remote" as const,
          compensationText: null,
          pageExcerpt: null,
        },
        {
          leadRef: "L2",
          company: "Beta",
          title: "Engineer",
          locationText: null,
          workMode: "hybrid" as const,
          compensationText: null,
          pageExcerpt: null,
        },
      ],
    };
    const first = await fake.rank(input);
    const second = await make().rank(input);
    expect(first.output).toEqual(second.output);
    expect(first.output.rankings.map((r) => r.leadRef)).toEqual(["L1", "L2"]);
    for (const r of first.output.rankings) {
      expect(r.fitScore).toBeGreaterThanOrEqual(0);
      expect(r.fitScore).toBeLessThanOrEqual(100);
    }
    expect(first.output.rankings[1]?.workMode).toBe("hybrid");
    expect((await fake.parseReport("some report")).output).toEqual({ leads: [] });
    expect((await fake.cvProfile("my cv")).output.coreSkills).toEqual([]);
  });

  it("records every call for assertions", async () => {
    const fake = make();
    await fake.parseReport("report text");
    await fake.cvProfile("cv text");
    expect(fake.calls).toEqual([
      { purpose: "parse_report", input: "report text" },
      { purpose: "cv_profile", input: "cv text" },
    ]);
  });

  it("serves outputs registered for an exact input, keyed by the hash of the normalised input", async () => {
    const fake = make();
    const profile = { ...(await fake.cvProfile("x")).output, headline: "Registered" };
    fake.register("cv_profile", "my cv", profile);
    expect((await fake.cvProfile("my cv")).output.headline).toBe("Registered");
    expect((await fake.cvProfile("other cv")).output.headline).not.toBe("Registered");
    expect(inputKey("cv_profile", "my cv")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws queued errors once, then recovers", async () => {
    const fake = make();
    fake.failNext("extract", new LlmError("upstream", "boom", { retryable: true }));
    await expect(fake.extract(extractInputFor("x"))).rejects.toMatchObject({ code: "upstream" });
    await expect(fake.extract(extractInputFor("x"))).resolves.toBeDefined();
  });
});
