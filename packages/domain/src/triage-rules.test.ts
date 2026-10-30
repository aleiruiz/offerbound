import { describe, expect, it } from "vitest";
import {
  triageByRules,
  type TriageDecision,
  type TriageLookups,
  type TriageRuleInput,
} from "./triage-rules.js";

const BACKFILL = new Date("2026-09-01T00:00:00Z");
const OWNER = "owner@mail.example";

const base: TriageRuleInput = {
  labelIds: ["INBOX"],
  internalDate: new Date("2026-10-01T12:00:00Z"),
  backfillSince: BACKFILL,
  threadId: "t-new",
  from: "stranger@unknown.example",
  to: [OWNER],
  cc: [],
  ownerEmail: OWNER,
};

const lookups: TriageLookups = {
  linkedThreadIds: new Set(["t-linked"]),
  contactEmails: new Set(["rae@quarry.example"]),
  companyDomains: new Set(["quarry.example"]),
  ignoreList: ["spam@ignored.example", "noisy.example"],
};

function run(input: Partial<TriageRuleInput>, l: Partial<TriageLookups> = {}): TriageDecision {
  return triageByRules({ ...base, ...input }, { ...lookups, ...l });
}

type Row = [
  name: string,
  input: Partial<TriageRuleInput>,
  expected: Pick<TriageDecision, "decision" | "rule">,
  extra?: Partial<TriageDecision>,
  lookups?: Partial<TriageLookups>,
];

const rows: Row[] = [
  // R1
  ["R1 DRAFT", { labelIds: ["DRAFT"] }, { decision: "skipped", rule: "R1" }],
  ["R1 SPAM", { labelIds: ["INBOX", "SPAM"] }, { decision: "skipped", rule: "R1" }],
  ["R1 TRASH", { labelIds: ["TRASH"] }, { decision: "skipped", rule: "R1" }],
  ["R1 CHAT", { labelIds: ["CHAT"] }, { decision: "skipped", rule: "R1" }],
  [
    "R1 before backfill start",
    { internalDate: new Date("2026-08-31T23:59:59Z") },
    { decision: "skipped", rule: "R1" },
  ],
  [
    "R1 beats R2 for a linked thread",
    { labelIds: ["SPAM"], threadId: "t-linked" },
    { decision: "skipped", rule: "R1" },
  ],
  [
    "backfill start itself is not skipped",
    { internalDate: BACKFILL },
    { decision: "llm", rule: "R9" },
  ],
  // R2
  [
    "R2 linked thread",
    { threadId: "t-linked" },
    { decision: "job_related", rule: "R2" },
    { direction: "inbound" },
  ],
  [
    "R2 linked thread from an ignored sender (before R7)",
    { threadId: "t-linked", from: "spam@ignored.example" },
    { decision: "job_related", rule: "R2" },
  ],
  [
    "R2 linked thread sent by the owner",
    { threadId: "t-linked", labelIds: ["SENT"], from: OWNER, to: ["x@unknown.example"] },
    { decision: "job_related", rule: "R2" },
    { direction: "outbound" },
  ],
  // R3
  [
    "R3 SENT to an unknown address",
    { labelIds: ["SENT"], from: OWNER, to: ["x@unknown.example"] },
    { decision: "triaged_out", rule: "R3" },
    { direction: "outbound" },
  ],
  [
    "R3 SENT to a known contact",
    { labelIds: ["SENT"], from: OWNER, to: ["Rae@Quarry.example"] },
    { decision: "job_related", rule: "R3" },
    { direction: "outbound" },
  ],
  [
    "R3 SENT to a known company domain",
    { labelIds: ["SENT"], from: OWNER, to: ["someone@mail.quarry.example"] },
    { decision: "job_related", rule: "R3" },
    { direction: "outbound" },
  ],
  [
    "R3 known contact in cc",
    { labelIds: ["SENT"], from: OWNER, to: ["x@unknown.example"], cc: ["rae@quarry.example"] },
    { decision: "job_related", rule: "R3" },
  ],
  [
    "R3 the owner's own address in the recipients is ignored",
    { labelIds: ["SENT"], from: OWNER, to: ["OWNER@mail.example", "x@unknown.example"] },
    { decision: "triaged_out", rule: "R3" },
    {},
    { contactEmails: new Set([OWNER]), companyDomains: new Set(["mail.example"]) },
  ],
  [
    "R3 SENT to a generic mailbox domain a company lists stays out",
    { labelIds: ["SENT"], from: OWNER, to: ["friend@gmail.com"] },
    { decision: "triaged_out", rule: "R3" },
    {},
    { companyDomains: new Set(["gmail.com"]) },
  ],
  [
    "R3 SENT to a known contact on a generic domain is in",
    { labelIds: ["SENT"], from: OWNER, to: ["recruiter@gmail.com"] },
    { decision: "job_related", rule: "R3" },
    {},
    { contactEmails: new Set(["recruiter@gmail.com"]) },
  ],
  [
    "R3 SENT with no recipients",
    { labelIds: ["SENT"], from: OWNER, to: [], cc: [] },
    { decision: "triaged_out", rule: "R3" },
  ],
  // R4
  [
    "R4 greenhouse-mail.io",
    { from: "noreply@greenhouse-mail.io" },
    { decision: "job_related", rule: "R4" },
    { hint: null, direction: "inbound" },
  ],
  [
    "R4 subdomain of an ATS",
    { from: "no-reply@us.greenhouse-mail.io" },
    { decision: "job_related", rule: "R4" },
  ],
  ["R4 ats.rippling.com", { from: "x@ats.rippling.com" }, { decision: "job_related", rule: "R4" }],
  ["rippling.com is not R4", { from: "x@rippling.com" }, { decision: "llm", rule: "R9" }],
  [
    "R4 beats R7",
    { from: "noreply@greenhouse.io" },
    { decision: "job_related", rule: "R4" },
    {},
    { ignoreList: ["greenhouse.io"] },
  ],
  // R5
  [
    "R5 LinkedIn job alerts",
    { from: "jobalerts-noreply@linkedin.com" },
    { decision: "job_related", rule: "R5" },
    { hint: "job_alert" },
  ],
  [
    "R5 case-insensitive",
    { from: "Alert@Indeed.com" },
    { decision: "job_related", rule: "R5" },
    { hint: "job_alert" },
  ],
  [
    "LinkedIn messaging goes to the LLM",
    { from: "messages-noreply@linkedin.com" },
    { decision: "llm", rule: "R9" },
    { hint: null },
  ],
  [
    "LinkedIn InMail goes to the LLM",
    { from: "inmail-hit-reply@linkedin.com" },
    { decision: "llm", rule: "R9" },
  ],
  // R6
  ["R6 known contact", { from: "rae@quarry.example" }, { decision: "job_related", rule: "R6" }],
  [
    "R6 known contact, display name and case",
    { from: "Rae Quarry <RAE@Quarry.example>" },
    { decision: "job_related", rule: "R6" },
  ],
  [
    "R6 company subdomain",
    { from: "ana@mail.quarry.example" },
    { decision: "job_related", rule: "R6" },
  ],
  [
    "R6 ignores generic mailbox domains even when a company lists them",
    { from: "x@gmail.com" },
    { decision: "llm", rule: "R9" },
    {},
    { companyDomains: new Set(["gmail.com", "quarry.example"]) },
  ],
  [
    "R6 ignores ATS domains a company lists",
    { from: "x@rippling.com" },
    { decision: "llm", rule: "R9" },
    {},
    { companyDomains: new Set(["rippling.com"]) },
  ],
  [
    "R6 ignores job-board domains a company lists",
    { from: "messages-noreply@linkedin.com" },
    { decision: "llm", rule: "R9" },
    {},
    { companyDomains: new Set(["linkedin.com"]) },
  ],
  [
    "R6 contact on a generic domain still counts",
    { from: "recruiter@gmail.com" },
    { decision: "job_related", rule: "R6" },
    {},
    { contactEmails: new Set(["recruiter@gmail.com"]) },
  ],
  // R7
  ["R7 ignored email", { from: "spam@ignored.example" }, { decision: "triaged_out", rule: "R7" }],
  ["R7 ignored domain", { from: "news@noisy.example" }, { decision: "triaged_out", rule: "R7" }],
  [
    "R7 ignored domain, subdomain sender",
    { from: "news@mail.noisy.example" },
    { decision: "triaged_out", rule: "R7" },
  ],
  [
    "R7 ignore entry with a leading @ and mixed case",
    { from: "news@noisy.example" },
    { decision: "triaged_out", rule: "R7" },
    {},
    { ignoreList: ["@Noisy.Example"] },
  ],
  [
    "R7 only the listed address, not its whole domain",
    { from: "other@ignored.example" },
    { decision: "llm", rule: "R9" },
  ],
  [
    "R7 a bare TLD entry matches nothing",
    { from: "news@noisy.example" },
    { decision: "llm", rule: "R9" },
    {},
    { ignoreList: ["example", "com", ".com", "@org", "co.uk"] },
  ],
  [
    "R6 beats R7",
    { from: "rae@quarry.example" },
    { decision: "job_related", rule: "R6" },
    {},
    { ignoreList: ["rae@quarry.example"] },
  ],
  // R8
  [
    "R8 promotions",
    { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] },
    { decision: "triaged_out", rule: "R8" },
  ],
  ["R8 forums", { labelIds: ["CATEGORY_FORUMS"] }, { decision: "triaged_out", rule: "R8" }],
  [
    "R8 yields to an earlier match",
    { labelIds: ["CATEGORY_PROMOTIONS"], from: "rae@quarry.example" },
    { decision: "job_related", rule: "R6" },
  ],
  [
    "R8 with no sender",
    { labelIds: ["CATEGORY_PROMOTIONS"], from: null },
    { decision: "triaged_out", rule: "R8" },
  ],
  // R9
  [
    "R9 updates from an unknown sender",
    { labelIds: ["INBOX", "CATEGORY_UPDATES"] },
    { decision: "llm", rule: "R9" },
    { direction: "inbound", hint: null },
  ],
  ["R9 with no sender", { from: null }, { decision: "llm", rule: "R9" }],
];

describe("triageByRules", () => {
  it("matches contacts and company domains case-insensitively", () => {
    const mixed: Partial<TriageLookups> = {
      contactEmails: new Set(["Rae.Mixed@Quarry.Example"]),
      companyDomains: new Set(["Lumen.Example"]),
    };
    expect(run({ from: "rae.mixed@quarry.example" }, mixed)).toMatchObject({ rule: "R6" });
    expect(run({ from: "someone@lumen.example" }, mixed)).toMatchObject({ rule: "R6" });
    expect(
      run({ labelIds: ["SENT"], from: OWNER, to: ["RAE.MIXED@quarry.example"] }, mixed),
    ).toMatchObject({ decision: "job_related", rule: "R3" });
  });

  it.each(rows)("%s", (_name, input, expected, extra, l) => {
    const result = run(input, l);
    expect(result).toMatchObject(expected);
    if (extra) expect(result).toMatchObject(extra);
  });

  it("never sends outgoing mail to the LLM", () => {
    const labelSets = [["SENT"], ["SENT", "CATEGORY_UPDATES"], ["SENT", "INBOX"]];
    for (const labelIds of labelSets) {
      for (const to of [[], ["x@unknown.example"], ["rae@quarry.example"]]) {
        const d = run({ labelIds, from: OWNER, to });
        expect(d.decision).not.toBe("llm");
        expect(d.direction).toBe("outbound");
      }
    }
  });

  it("gives every decision a direction and hint", () => {
    expect(run({ labelIds: ["DRAFT"] })).toEqual({
      decision: "skipped",
      rule: "R1",
      direction: "inbound",
      hint: null,
    });
  });
});
