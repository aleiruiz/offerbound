import {
  JOB_ALERT_SENDERS,
  bareAddress,
  hostOf,
  isAtsSender,
  isNonCompanyDomain,
  registrableDomain,
} from "./domains.js";

export type TriageRuleInput = {
  labelIds: string[];
  internalDate: Date;
  backfillSince: Date;
  threadId: string;
  from: string | null;
  to: string[];
  cc: string[];
  ownerEmail: string | null;
};

/** Set members and ignore-list entries are compared case-insensitively, so keep them lower-case. */
export type TriageLookups = {
  linkedThreadIds: ReadonlySet<string>;
  contactEmails: ReadonlySet<string>;
  companyDomains: ReadonlySet<string>;
  ignoreList: readonly string[];
};

export type TriageDecision = {
  decision: "skipped" | "triaged_out" | "job_related" | "llm";
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9";
  direction: "inbound" | "outbound";
  hint: "job_alert" | null;
};

const SKIPPED_LABELS = ["DRAFT", "SPAM", "TRASH", "CHAT"];
const NOISE_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_FORUMS"];

/** A company domain is usable only when it is not a mailbox provider, ATS or job board. */
function isKnownCompanyDomain(address: string, companyDomains: ReadonlySet<string>): boolean {
  const domain = registrableDomain(address);
  return domain !== null && !isNonCompanyDomain(domain) && companyDomains.has(domain);
}

function isIgnored(address: string, ignoreList: readonly string[]): boolean {
  const host = hostOf(address);
  const domain = registrableDomain(address);
  return ignoreList.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^@/, "");
    if (entry === "") return false;
    if (entry.includes("@")) return entry === address;
    return entry === host || entry === domain || host.endsWith(`.${entry}`);
  });
}

/** Stage 1a of triage (TECHNICAL_SPEC §5.3): the first matching rule wins. */
export function triageByRules(input: TriageRuleInput, lookups: TriageLookups): TriageDecision {
  const direction = input.labelIds.includes("SENT") ? "outbound" : "inbound";
  const decide = (
    decision: TriageDecision["decision"],
    rule: TriageDecision["rule"],
    hint: TriageDecision["hint"] = null,
  ): TriageDecision => ({ decision, rule, direction, hint });

  // R1
  if (
    input.labelIds.some((l) => SKIPPED_LABELS.includes(l)) ||
    input.internalDate.getTime() < input.backfillSince.getTime()
  ) {
    return decide("skipped", "R1");
  }

  // R2
  if (lookups.linkedThreadIds.has(input.threadId)) return decide("job_related", "R2");

  // R3: outgoing mail never reaches the LLM
  if (direction === "outbound") {
    const owner = input.ownerEmail === null ? null : bareAddress(input.ownerEmail);
    const recipients = [...input.to, ...input.cc]
      .map(bareAddress)
      .filter((a) => a !== "" && a !== owner);
    const known = recipients.some(
      (a) => lookups.contactEmails.has(a) || isKnownCompanyDomain(a, lookups.companyDomains),
    );
    return known ? decide("job_related", "R3") : decide("triaged_out", "R3");
  }

  const sender = input.from === null ? null : bareAddress(input.from);
  if (sender !== null && sender !== "") {
    // R4
    if (isAtsSender(sender)) return decide("job_related", "R4");
    // R5
    if (JOB_ALERT_SENDERS.includes(sender)) return decide("job_related", "R5", "job_alert");
    // R6
    if (lookups.contactEmails.has(sender) || isKnownCompanyDomain(sender, lookups.companyDomains)) {
      return decide("job_related", "R6");
    }
    // R7
    if (isIgnored(sender, lookups.ignoreList)) return decide("triaged_out", "R7");
  }

  // R8
  if (input.labelIds.some((l) => NOISE_CATEGORIES.includes(l))) return decide("triaged_out", "R8");

  // R9
  return decide("llm", "R9");
}
