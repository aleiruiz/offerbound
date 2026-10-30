import type { ApplicationStatus, EmailCategory, LeadStatus } from "@offerbound/contracts";
import { groupMembers, type CompanyRef, type CompanyResolution } from "./company.js";

/**
 * Matching an email to an application (TECHNICAL_SPEC §6.4; AC-4.5; journey J5).
 * Pure: the caller loads the snapshot and acts on the result.
 */

export type MatchSnapshot = {
  threadLinks: ReadonlyMap<string, { applicationId: string | null; leadId: string | null }>;
  applications: {
    id: string;
    companyId: string;
    title: string;
    status: ApplicationStatus;
    jobKey: string | null;
  }[];
  leads: {
    id: string;
    companyId: string;
    title: string;
    status: LeadStatus;
    jobKey: string | null;
  }[];
  companies: CompanyRef[];
};

/** A record the owner can pick in an *Ambiguous match* review item; label = "Company — Role (Status)". */
export type Candidate = { id: string; label: string };

export type MatchResult =
  | { kind: "application"; applicationId: string; via: "thread" | "job_key" | "company" }
  | { kind: "lead_thread"; leadId: string }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "create"; convertLeadId: string | null }
  | { kind: "none" };

const ROLE_JACCARD_MIN = 0.6;

/** Statuses only the owner sets; an email never matches into them through the company. */
const TERMINAL: readonly ApplicationStatus[] = ["accepted", "withdrawn"];

/** Recruiter outreach attaches only to an application still in play (§6.4); otherwise it is a lead. */
const ACTIVE: readonly ApplicationStatus[] = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
];

/** Categories that create an application when nothing matches (§6.4 rule 4). */
const CREATING: readonly EmailCategory[] = [
  "application_confirmation",
  "rejection",
  "interview_invite",
  "assessment",
  "offer",
];

/** Categories about an application that, found nothing, go to the owner to create or dismiss. */
const UNKNOWN_APPLICATION: readonly EmailCategory[] = [
  "interview_reschedule",
  "interview_cancellation",
  "status_update_other",
];

/** Role titles are compared as plain word sets; company-name suffix stripping does not apply. */
function roleTokens(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((t) => t !== ""),
  );
}

function roleJaccard(a: string | null, b: string): number {
  if (a === null) return 0;
  const setA = roleTokens(a);
  const setB = roleTokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * Whether two role titles are close enough to be the same job: word-set Jaccard of at least 0.6,
 * the test an email's role gets against an application's. Other callers (the sheet import) use
 * it so both agree on what "similar" means.
 */
export function rolesSimilar(a: string, b: string): boolean {
  return roleJaccard(a, b) >= ROLE_JACCARD_MIN;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function candidateFor(
  a: MatchSnapshot["applications"][number],
  companies: CompanyRef[],
): Candidate {
  const name = companies.find((c) => c.id === a.companyId)?.name ?? "Unknown company";
  return { id: a.id, label: `${name} — ${a.title} (${capitalize(a.status)})` };
}

function convertibleLead(
  s: MatchSnapshot,
  m: { jobKey: string | null; company: CompanyResolution; roleTitle: string | null },
): string | null {
  // A lead that already became an application cannot be converted again.
  const open = s.leads.filter((l) => l.status !== "applied");
  if (m.jobKey !== null) {
    const byKey = open.find((l) => l.jobKey === m.jobKey);
    if (byKey) return byKey.id;
  }
  if (m.company.kind !== "existing") return null;
  const companyId = m.company.companyId;
  let best: { id: string; score: number } | null = null;
  for (const l of open) {
    if (l.companyId !== companyId) continue;
    const score = roleJaccard(m.roleTitle, l.title);
    if (score >= ROLE_JACCARD_MIN && (best === null || score > best.score)) {
      best = { id: l.id, score };
    }
  }
  return best?.id ?? null;
}

/**
 * Decides what an email belongs to. First hit wins: linked thread, job key, then the resolved
 * company's (and group's) non-terminal applications; otherwise create, or ask the owner.
 * `job_alert` and `not_job_related` are never about an application and return `none`.
 * `recruiter_outreach` matches only an application in Applied through Offer (by job key or company);
 * a thread link still wins, and with no active application the result is `none` (a lead, §6.4).
 */
export function matchApplication(
  s: MatchSnapshot,
  m: {
    threadId: string;
    jobKey: string | null;
    company: CompanyResolution;
    roleTitle: string | null;
    category: EmailCategory;
  },
): MatchResult {
  if (m.category === "job_alert" || m.category === "not_job_related") return { kind: "none" };

  const link = s.threadLinks.get(m.threadId);
  if (link?.applicationId) {
    return { kind: "application", applicationId: link.applicationId, via: "thread" };
  }
  if (link?.leadId) return { kind: "lead_thread", leadId: link.leadId };

  const isOutreach = m.category === "recruiter_outreach";
  const candidateStatuses = isOutreach ? ACTIVE : null;

  if (m.jobKey !== null) {
    const byKey = s.applications.find(
      (a) => a.jobKey === m.jobKey && (candidateStatuses?.includes(a.status) ?? true),
    );
    if (byKey) return { kind: "application", applicationId: byKey.id, via: "job_key" };
  }

  if (m.company.kind === "existing") {
    const members = groupMembers(m.company.companyId, s.companies);
    const open = s.applications.filter(
      (a) =>
        members.has(a.companyId) &&
        (candidateStatuses === null
          ? !TERMINAL.includes(a.status)
          : candidateStatuses.includes(a.status)),
    );
    const [first, ...rest] = open;
    if (first !== undefined && rest.length === 0) {
      return { kind: "application", applicationId: first.id, via: "company" };
    }
    if (first !== undefined) {
      const passing = open.filter((a) => roleJaccard(m.roleTitle, a.title) >= ROLE_JACCARD_MIN);
      const [only, ...others] = passing;
      if (only !== undefined && others.length === 0) {
        return { kind: "application", applicationId: only.id, via: "company" };
      }
      const shown = passing.length >= 2 ? passing : open;
      return { kind: "ambiguous", candidates: shown.map((a) => candidateFor(a, s.companies)) };
    }
  }

  if (CREATING.includes(m.category)) {
    return { kind: "create", convertLeadId: convertibleLead(s, m) };
  }
  if (UNKNOWN_APPLICATION.includes(m.category)) return { kind: "ambiguous", candidates: [] };
  return { kind: "none" };
}
