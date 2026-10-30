import type {
  IntakeBatchKind,
  LeadPipelineState,
  LeadSource,
  LeadStatus,
  Ranking,
  Seniority,
  SuppressedReason,
  Verification,
  WorkMode,
} from "@offerbound/contracts";
import {
  groupMembers,
  resolveCompany,
  type CompanyIndex,
  type CompanyResolution,
} from "./company.js";
import { jobKey } from "./job-key.js";

/**
 * One lead as it arrives at intake (TECHNICAL_SPEC §7.1), whatever the source. `ref` names the lead
 * inside its batch so a plan can point at it (for example from `link_thread`); `order` is its
 * position in the source.
 */
export type IncomingLead = {
  ref: string;
  order: number;
  source: LeadSource;
  companyName: string;
  companyDomain: string | null;
  title: string;
  jobUrl: string | null;
  locationText: string | null;
  country: string | null;
  workMode: WorkMode;
  compensationText: string | null;
  sponsorshipText: string | null;
  postedAt: Date | null;
  seniority: Seniority | null;
  ranking: Ranking | null;
  verification: Verification | null;
  pageExcerpt: string | null;
  sheetStatus: "to_research" | "cancelled" | null;
  notes: string | null;
  contactEmail: string | null;
};

/** Everything `planIntake` needs about the world as it was before the batch started. */
export type IntakeContext = {
  batchKind: IntakeBatchKind;
  /** Job keys of every lead and application that already exists. */
  existingJobKeys: ReadonlySet<string>;
  companyIndex: CompanyIndex;
  /**
   * Companies with a lead or application created before this batch. `planIntake` also adds every
   * member of their groups, so a caller may pass the plain set.
   */
  seenCompanyIds: ReadonlySet<string>;
  excludedSeniorities: readonly Seniority[];
};

/**
 * What synchronous intake decides for one incoming lead (TECHNICAL_SPEC §7.1). A `store` decision
 * with `company.kind === "none"` names no company (the incoming name was blank), which the
 * executor cannot store. Several leads of one new company each carry the same `new` resolution;
 * the executor creates that company once.
 */
export type IntakeDecision = { ref: string } & (
  | { action: "discard"; reason: "no_job_key" | "duplicate" }
  | {
      action: "store";
      jobKey: string | null;
      company: CompanyResolution;
      status: LeadStatus;
      suppressedReason: SuppressedReason | null;
      dismissedReason: string | null;
      pipelineState: LeadPipelineState;
      /** True only for the recruiter-outreach exception: seen company, lead kept as `new`. */
      companySeenBefore: boolean;
    }
);

/** Sources that are history or owner-entered and so skip the company-seen rule. */
const SOURCES_SKIPPING_COMPANY_SEEN: ReadonlySet<LeadSource> = new Set<LeadSource>([
  "sheet_import",
  "manual",
]);
/** Batch kinds that are history or owner-entered and so skip the company-seen rule. */
const BATCHES_SKIPPING_COMPANY_SEEN: ReadonlySet<IntakeBatchKind> = new Set<IntakeBatchKind>([
  "sheet_import",
  "manual",
]);

function seenWithGroups(ctx: IntakeContext): Set<string> {
  const seen = new Set<string>();
  for (const id of ctx.seenCompanyIds) {
    for (const member of groupMembers(id, ctx.companyIndex.companies)) seen.add(member);
  }
  return seen;
}

/**
 * Synchronous intake rules for one batch (TECHNICAL_SPEC §7.1, rules 1-8). Pure: the caller loads
 * the context under the intake lock. Leads are judged in source `order`, so "earlier in the same
 * batch" means the lower `order`; the decisions come back in the order of `incoming`.
 */
export function planIntake(incoming: IncomingLead[], ctx: IntakeContext): IntakeDecision[] {
  const seen = seenWithGroups(ctx);
  const excluded = new Set<Seniority>(ctx.excludedSeniorities);
  const keysInBatch = new Set<string>();
  const decisions = new Map<IncomingLead, IntakeDecision>();

  const judgingOrder = incoming
    .map((lead, index) => ({ lead, index }))
    .sort((a, b) => a.lead.order - b.lead.order || a.index - b.index);

  for (const { lead } of judgingOrder) {
    const key = lead.jobUrl === null ? null : jobKey(lead.jobUrl);

    // 1. No job key from the search agent: nothing to deduplicate on.
    if (key === null && lead.source === "search_agent") {
      decisions.set(lead, { ref: lead.ref, action: "discard", reason: "no_job_key" });
      continue;
    }
    // 2. The posting is already known, or appeared earlier in this batch.
    if (key !== null && (ctx.existingJobKeys.has(key) || keysInBatch.has(key))) {
      decisions.set(lead, { ref: lead.ref, action: "discard", reason: "duplicate" });
      continue;
    }
    if (key !== null) keysInBatch.add(key);

    // 3. Company, from its own name and links, never from a sender.
    const company = resolveCompany(
      {
        senderEmail: null,
        extractedName: lead.companyName,
        websiteDomain: lead.companyDomain,
        jobUrl: lead.jobUrl,
      },
      ctx.companyIndex,
    );

    const store = (
      status: LeadStatus,
      pipelineState: LeadPipelineState,
      extra: Partial<{
        suppressedReason: SuppressedReason;
        dismissedReason: string;
        companySeenBefore: boolean;
      }> = {},
    ): IntakeDecision => ({
      ref: lead.ref,
      action: "store",
      jobKey: key,
      company,
      status,
      suppressedReason: extra.suppressedReason ?? null,
      dismissedReason: extra.dismissedReason ?? null,
      pipelineState,
      companySeenBefore: extra.companySeenBefore ?? false,
    });

    // 4. Company (or a company of its group) already has a lead or application.
    let companySeenBefore = false;
    const checksSeen =
      !SOURCES_SKIPPING_COMPANY_SEEN.has(lead.source) &&
      !BATCHES_SKIPPING_COMPANY_SEEN.has(ctx.batchKind);
    if (checksSeen && company.kind === "existing" && seen.has(company.companyId)) {
      if (lead.source !== "gmail_recruiter") {
        decisions.set(
          lead,
          store("suppressed", "ready", { suppressedReason: "company_already_seen" }),
        );
        continue;
      }
      companySeenBefore = true;
    }

    // 5. Excluded seniority.
    if (lead.seniority !== null && lead.seniority !== "unknown" && excluded.has(lead.seniority)) {
      decisions.set(
        lead,
        store("suppressed", "ready", { suppressedReason: "excluded_seniority", companySeenBefore }),
      );
      continue;
    }
    // 6. Search-agent leads arrive checked and ranked.
    if (lead.source === "search_agent") {
      decisions.set(
        lead,
        lead.ranking?.eligible === "no"
          ? store("suppressed", "ready", { suppressedReason: "ineligible", companySeenBefore })
          : store("new", "ready", { companySeenBefore }),
      );
      continue;
    }
    // 7. Imported rows the owner cancelled are history.
    if (lead.sheetStatus === "cancelled") {
      decisions.set(
        lead,
        store("dismissed", "ready", { dismissedReason: "not_pursued_imported", companySeenBefore }),
      );
      continue;
    }
    // 8. Everything else waits for the link check and ranking.
    decisions.set(lead, store("new", "checking", { companySeenBefore }));
  }

  return incoming.map((lead) => {
    const decision = decisions.get(lead);
    if (decision === undefined) throw new Error("planIntake: lead was not judged");
    return decision;
  });
}

/** Finalize input: one lead of the batch after link check and ranking. */
export type BatchLead = {
  id: string;
  companyId: string;
  status: LeadStatus;
  fitScore: number | null;
  postedAt: Date | null;
  order: number;
};

/** Best lead first: highest fit, then newest `postedAt`, then lowest `order` (missing values last). */
function compareBest(a: BatchLead, b: BatchLead): number {
  return (
    (b.fitScore ?? -Infinity) - (a.fitScore ?? -Infinity) ||
    (b.postedAt?.getTime() ?? -Infinity) - (a.postedAt?.getTime() ?? -Infinity) ||
    a.order - b.order
  );
}

/**
 * Rule 3 once every lead of the batch is checked and ranked: per company keep the best `new` lead
 * and suppress the rest as `same_company_in_batch`. The caller skips this for `sheet_import` and
 * `manual` batches. Returns the ids to suppress, in the order given.
 */
export function finalizeBatch(leads: BatchLead[]): { suppressIds: string[] } {
  const byCompany = new Map<string, BatchLead[]>();
  for (const lead of leads) {
    if (lead.status !== "new") continue;
    byCompany.set(lead.companyId, [...(byCompany.get(lead.companyId) ?? []), lead]);
  }
  const suppress = new Set<string>();
  for (const group of byCompany.values()) {
    const [, ...rest] = [...group].sort(compareBest);
    for (const lead of rest) suppress.add(lead.id);
  }
  return { suppressIds: leads.filter((l) => suppress.has(l.id)).map((l) => l.id) };
}
