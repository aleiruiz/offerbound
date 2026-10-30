import type { Prisma, PrismaClient } from "@prisma/client";
import type { IntakeBatchKind, Ranking, Settings } from "@offerbound/contracts";
import {
  planIntake,
  type CompanyIndex,
  type IncomingLead,
  type IntakeDecision,
} from "@offerbound/domain";
import { QUEUES, type JobQueue } from "../jobs/queues.js";

type Tx = Prisma.TransactionClient;
/** The transaction client the lead jobs and `ingestLeads` write through. */
export type LeadsTx = Tx;

/** The batch's running tally (DATA_MODEL §3.10). */
export type IntakeCounts = {
  received: number;
  duplicates: number;
  suppressed: number;
  dead: number;
  accepted: number;
};

export type IntakeBatchInput = {
  kind: IntakeBatchKind;
  searchRunId?: string;
  messageId?: string;
  fileHash?: string;
};

export type IngestResult = {
  batchId: string;
  /** Every lead stored, in source order. */
  leadIds: string[];
  /** The stored leads that wait for `leads.check`; the caller sends the jobs after commit. */
  checkIds: string[];
  /** Incoming `ref` → stored lead id, for plan operations that point at a new lead. */
  refs: Record<string, string>;
  counts: IntakeCounts;
};

/** Batches whose leads are history or owner-entered: they are never finalized (§7.1). */
export const BATCHES_WITHOUT_FINALIZE: ReadonlySet<IntakeBatchKind> = new Set<IntakeBatchKind>([
  "sheet_import",
  "manual",
]);

const COUNT_KEYS = ["received", "duplicates", "suppressed", "dead", "accepted"] as const;

/**
 * Takes the intake lock for the rest of the transaction (TECHNICAL_SPEC §6.8). Same statement as
 * `withIntakeLock` in `db/lock.ts`; the lead jobs use this one until that module is on main.
 */
export async function withLeadsLock<T>(
  prisma: PrismaClient,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('offerbound.intake'))`;
      return fn(tx);
    },
    // The wait for the lock counts against the transaction clock; nothing slow runs inside.
    { maxWait: 10_000, timeout: 60_000 },
  );
}

/**
 * Adds `delta` to the batch's counts in one statement, so check and rank jobs that finish at the
 * same time cannot overwrite each other.
 */
export async function bumpBatchCounts(
  tx: Tx,
  batchId: string,
  delta: Partial<IntakeCounts>,
): Promise<void> {
  const d = Object.fromEntries(COUNT_KEYS.map((key) => [key, delta[key] ?? 0])) as IntakeCounts;
  await tx.$executeRaw`
    update intake_batch set counts = jsonb_build_object(
      'received', coalesce((counts->>'received')::int, 0) + ${d.received}::int,
      'duplicates', coalesce((counts->>'duplicates')::int, 0) + ${d.duplicates}::int,
      'suppressed', coalesce((counts->>'suppressed')::int, 0) + ${d.suppressed}::int,
      'dead', coalesce((counts->>'dead')::int, 0) + ${d.dead}::int,
      'accepted', coalesce((counts->>'accepted')::int, 0) + ${d.accepted}::int
    )
    where id = ${batchId}::uuid`;
}

/** `usd` → `USD`; anything that is not a three-letter code is dropped (the column is char(3)). */
function currencyCode(raw: string | null): string | null {
  const code = raw?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** The ranking columns of a lead (AC-12.2). */
export type RankingColumns = Pick<
  Prisma.LeadUncheckedCreateInput,
  | "track"
  | "fitScore"
  | "fitReason"
  | "gaps"
  | "seniority"
  | "workMode"
  | "remoteFromHomeCountry"
  | "sponsorship"
  | "relocation"
  | "compMin"
  | "compMax"
  | "compCurrency"
  | "compPeriod"
  | "compIsEstimate"
  | "compBasis"
  | "eligible"
  | "eligibilityReason"
>;

/** Maps a ranking to lead columns; shared by intake (search-agent leads) and the rank job. */
export function rankingColumns(ranking: Ranking, trackKeys: readonly string[]): RankingColumns {
  return {
    track: ranking.track !== null && trackKeys.includes(ranking.track) ? ranking.track : null,
    fitScore: ranking.fitScore,
    fitReason: ranking.fitReason,
    gaps: ranking.gaps,
    seniority: ranking.seniority,
    workMode: ranking.workMode,
    remoteFromHomeCountry: ranking.remoteFromHomeCountry,
    sponsorship: ranking.sponsorship,
    relocation: ranking.relocation,
    compMin: ranking.compensation.min,
    compMax: ranking.compensation.max,
    compCurrency: currencyCode(ranking.compensation.currency),
    compPeriod: ranking.compensation.period,
    compIsEstimate: ranking.compensation.isEstimate,
    compBasis: ranking.compensation.basis,
    eligible: ranking.eligible,
    eligibilityReason: ranking.eligibilityReason,
  };
}

async function loadCompanyIndex(tx: Tx): Promise<CompanyIndex> {
  const companies = await tx.company.findMany({
    select: {
      id: true,
      name: true,
      normalizedName: true,
      aliases: true,
      domains: true,
      atsSlugs: true,
      groupId: true,
    },
  });
  // Leads name their own company, never a sender, so contacts play no part here.
  return { companies, contacts: [] };
}

async function loadExistingJobKeys(tx: Tx): Promise<Set<string>> {
  const keys = new Set<string>();
  const leads = await tx.lead.findMany({
    where: { jobKey: { not: null } },
    select: { jobKey: true },
  });
  const apps = await tx.application.findMany({
    where: { jobKey: { not: null } },
    select: { jobKey: true },
  });
  for (const row of [...leads, ...apps]) if (row.jobKey !== null) keys.add(row.jobKey);
  return keys;
}

/** Every company with a lead or application: all of them were created before this batch. */
async function loadSeenCompanyIds(tx: Tx): Promise<Set<string>> {
  const leads = await tx.lead.findMany({ distinct: ["companyId"], select: { companyId: true } });
  const apps = await tx.application.findMany({
    distinct: ["companyId"],
    select: { companyId: true },
  });
  return new Set([...leads, ...apps].map((row) => row.companyId));
}

function createdSource(lead: IncomingLead): string {
  return lead.source === "gmail_alert" || lead.source === "gmail_recruiter" ? "gmail" : lead.source;
}

type Stored = Extract<IntakeDecision, { action: "store" }>;

/**
 * Synchronous intake for one batch (TECHNICAL_SPEC §7.1, rules 1-8), inside the caller's
 * transaction, which must hold the intake lock. Creates the batch, any new companies and the
 * leads the rules keep. Lead rows carry `createdAt = now + order milliseconds`, which is how
 * finalize knows "first returned" (the table has no order column). Writes no events: the caller
 * records them with the change that caused the batch.
 *
 * The caller sends the follow-up jobs after the transaction commits (`enqueueLeadChecks`), so a
 * worker never looks for a lead that is not yet visible.
 */
export async function ingestLeads(
  tx: Tx,
  batch: IntakeBatchInput,
  incoming: IncomingLead[],
  ctx: { settings: Settings; now: Date },
): Promise<IngestResult> {
  const decisions = planIntake(incoming, {
    batchKind: batch.kind,
    existingJobKeys: await loadExistingJobKeys(tx),
    companyIndex: await loadCompanyIndex(tx),
    seenCompanyIds: await loadSeenCompanyIds(tx),
    excludedSeniorities: ctx.settings.search.excludedSeniorities,
  });

  const counts: IntakeCounts = {
    received: incoming.length,
    duplicates: 0,
    suppressed: 0,
    dead: 0,
    accepted: 0,
  };
  const kept: { lead: IncomingLead; decision: Stored }[] = [];
  incoming.forEach((lead, index) => {
    const decision = decisions[index];
    if (decision === undefined) throw new Error("planIntake returned too few decisions");
    if (decision.action === "discard") {
      if (decision.reason === "duplicate") counts.duplicates += 1;
      return;
    }
    // A blank company name leaves nothing to attach the lead to.
    if (decision.company.kind === "none") return;
    kept.push({ lead, decision });
    if (decision.status === "suppressed") counts.suppressed += 1;
    else counts.accepted += 1;
  });

  const created = await tx.intakeBatch.create({
    data: {
      kind: batch.kind,
      searchRunId: batch.searchRunId ?? null,
      messageId: batch.messageId ?? null,
      fileHash: batch.fileHash ?? null,
      counts,
    },
  });

  const trackKeys = ctx.settings.search.tracks.map((t) => t.key);
  const companyIds = new Map<string, string>();
  const refs: Record<string, string> = {};
  const leadIds: string[] = [];
  const checkIds: string[] = [];

  for (const { lead, decision } of kept) {
    const resolution = decision.company;
    let companyId: string;
    if (resolution.kind === "existing") {
      companyId = resolution.companyId;
    } else if (resolution.kind === "new") {
      const known = companyIds.get(resolution.company.normalizedName);
      if (known !== undefined) {
        companyId = known;
      } else {
        const company = await tx.company.create({
          data: {
            name: resolution.company.name,
            normalizedName: resolution.company.normalizedName,
            domains: resolution.company.domains,
            atsSlugs: resolution.company.atsSlugs,
            websiteDomain: resolution.company.websiteDomain,
            createdSource: createdSource(lead),
            createdAt: ctx.now,
            updatedAt: ctx.now,
          },
        });
        companyIds.set(resolution.company.normalizedName, company.id);
        companyId = company.id;
      }
    } else {
      continue;
    }

    const contact =
      lead.contactEmail === null
        ? null
        : await tx.contact.findUnique({ where: { email: lead.contactEmail } });
    const ranking = lead.ranking;
    const row = await tx.lead.create({
      data: {
        companyId,
        intakeBatchId: created.id,
        title: lead.title,
        jobUrl: lead.jobUrl,
        jobKey: decision.jobKey,
        locationText: lead.locationText,
        country: lead.country,
        workMode: lead.workMode,
        sponsorshipText: lead.sponsorshipText,
        compensationText: lead.compensationText,
        seniority: lead.seniority ?? "unknown",
        ...(ranking === null ? {} : rankingColumns(ranking, trackKeys)),
        rankedAt: ranking === null ? null : ctx.now,
        status: decision.status,
        statusChangedAt: ctx.now,
        pipelineState: decision.pipelineState,
        suppressedReason: decision.suppressedReason,
        dismissedReason: decision.dismissedReason,
        companySeenBefore: decision.companySeenBefore,
        verification: lead.verification ?? "pending",
        verifiedAt: lead.verification === null || lead.verification === "pending" ? null : ctx.now,
        pageExcerpt: lead.pageExcerpt,
        source: lead.source,
        sourceMessageId: batch.messageId ?? null,
        contactId: contact?.id ?? null,
        postedAt: lead.postedAt,
        foundAt: ctx.now,
        notes: lead.notes,
        createdAt: new Date(ctx.now.getTime() + lead.order),
        updatedAt: ctx.now,
      },
    });
    refs[lead.ref] = row.id;
    leadIds.push(row.id);
    if (decision.pipelineState === "checking") checkIds.push(row.id);
  }

  return { batchId: created.id, leadIds, checkIds, refs, counts };
}

/** Sends `leads.check` for every stored lead that waits for one. Call it after the commit. */
export async function enqueueLeadChecks(
  queue: Pick<JobQueue, "send">,
  result: Pick<IngestResult, "checkIds">,
): Promise<void> {
  for (const leadId of result.checkIds) await queue.send(QUEUES.leadsCheck, { leadId });
}

/**
 * After a check or rank, sends `leads.finalize` (keyed by the batch) when no lead of the batch is
 * left in `checking` or `ranking`. Sheet and manual batches, and batches already finalized, send
 * nothing.
 */
export async function sendFinalizeIfSettled(
  ctx: { prisma: PrismaClient; queue: Pick<JobQueue, "send"> },
  batchId: string,
): Promise<void> {
  const batch = await ctx.prisma.intakeBatch.findUnique({
    where: { id: batchId },
    select: { kind: true, finalizedAt: true },
  });
  if (batch === null || batch.finalizedAt !== null || BATCHES_WITHOUT_FINALIZE.has(batch.kind)) {
    return;
  }
  const pending = await ctx.prisma.lead.count({
    where: { intakeBatchId: batchId, pipelineState: { in: ["checking", "ranking"] } },
  });
  if (pending > 0) return;
  await ctx.queue.send(QUEUES.leadsFinalize, { batchId }, { singletonKey: batchId });
}
