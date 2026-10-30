import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  clampRanking,
  type SearchLead,
  type SearchRun as SearchRunDto,
  type SearchTrigger,
  type Settings,
} from "@offerbound/contracts";
import { jobKey, ownerLocalDay, type IncomingLead } from "@offerbound/domain";
import type { AppDeps, WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { writeEvent } from "../db/events.js";
import { ApiError } from "../http/errors.js";
import { QUEUES, type JobQueue } from "../jobs/queues.js";
import { LlmError } from "../llm/provider.js";
import { getSettings } from "../settings/service.js";
import { getActiveProfile } from "./cv.js";
import { bumpBatchCounts, ingestLeads } from "./intake.js";
import { runFinalize } from "./finalize.js";
import { checkLink, type LinkCheckResult } from "./link-check.js";

export type { SearchRunDto };

/** A run still `running` after this long was lost with its worker (TECHNICAL_SPEC §7.3). */
export const STALE_RUN_AFTER_MS = 30 * 60 * 1000;
/** Links of one round checked at the same time (TECHNICAL_SPEC §7.3). */
export const LINK_CHECK_CONCURRENCY = 5;
/** `GET /search/runs` answers with this many runs (AC-10.5). */
export const SEARCH_RUNS_LISTED = 14;

type Db = PrismaClient | Prisma.TransactionClient;

// --- the run record -----------------------------------------------------------------------------

type RunRow = Prisma.SearchRunGetPayload<object>;

function toDto(row: RunRow): SearchRunDto {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    rounds: row.rounds,
    returned: row.returned,
    accepted: row.accepted,
    suppressed: row.suppressed,
    duplicates: row.duplicates,
    dead: row.dead,
    webSearchCalls: row.webSearchCalls,
    costMicros: row.costMicros === null ? null : Number(row.costMicros),
    error: row.error,
  };
}

/** The last {@link SEARCH_RUNS_LISTED} runs, newest first (`GET /search/runs`). */
export async function listSearchRuns(prisma: PrismaClient): Promise<SearchRunDto[]> {
  const rows = await prisma.searchRun.findMany({
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: SEARCH_RUNS_LISTED,
  });
  return rows.map(toDto);
}

function alreadyRunning(): ApiError {
  return new ApiError(409, "already_running", "A search is already running.");
}

/**
 * Creates the `running` row for a new run. At most one run can be `running` (a partial unique
 * index), so a second start answers `409 already_running`. Stores only the SHA-256 of the brief
 * (AC-10.6, DATA_MODEL §3.12).
 *
 * First it closes runs that have been `running` for more than 30 minutes (`markStaleRuns`), so a
 * run lost to a crash or deploy stops blocking Run now and the daily run 30 minutes after it
 * started, without waiting for another worker start.
 */
async function createRun(
  prisma: PrismaClient,
  trigger: SearchTrigger,
  now: Date,
): Promise<{ row: RunRow; settings: Settings }> {
  await markStaleRuns(prisma, now);
  const settings = await getSettings(prisma);
  const briefHash = createHash("sha256").update(settings.search.brief).digest("hex");
  if ((await prisma.searchRun.count({ where: { status: "running" } })) > 0) throw alreadyRunning();
  try {
    const row = await prisma.searchRun.create({
      data: { trigger, status: "running", startedAt: now, briefHash },
    });
    return { row, settings };
  } catch (error) {
    // Two starts at once: the unique index lets only one through.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw alreadyRunning();
    }
    throw error;
  }
}

/**
 * `POST /search/run` and nothing else: creates the `running` row (`409 already_running` when a
 * run exists) and queues `search.run` for it, so the route can answer `202` at once. If the job
 * cannot be queued the run is closed as failed, so it does not block the next one.
 */
export async function requestSearchRun(
  deps: Pick<AppDeps, "prisma" | "queue" | "clock">,
  trigger: SearchTrigger,
): Promise<SearchRunDto> {
  const { row } = await createRun(deps.prisma, trigger, deps.clock());
  try {
    await deps.queue.send(QUEUES.searchRun, { runId: row.id, trigger });
  } catch (error) {
    await deps.prisma.searchRun.update({
      where: { id: row.id },
      data: { status: "failed", finishedAt: deps.clock(), error: "could not queue the search" },
    });
    throw error;
  }
  return toDto(row);
}

/**
 * Marks every run that has been `running` for more than 30 minutes as `failed` with the error
 * `interrupted` (its worker stopped). Called at worker start. Returns how many were marked.
 */
export async function markStaleRuns(db: Db, now: Date): Promise<number> {
  const { count } = await db.searchRun.updateMany({
    where: {
      status: "running",
      startedAt: { lt: new Date(now.getTime() - STALE_RUN_AFTER_MS) },
    },
    data: { status: "failed", finishedAt: now, error: "interrupted" },
  });
  return count;
}

// --- the schedule -------------------------------------------------------------------------------

/**
 * Registers the daily `search.run` job at `search.runTime` in the owner's time zone `tz` when
 * search is enabled (cron `"mm HH * * *"`, so `07:00` is `0 7 * * *`), and removes the schedule
 * when it is not. Call it at worker start and again whenever `search.enabled` or `search.runTime`
 * changes (`PUT /settings`). It is safe to call repeatedly: a new call replaces the old schedule.
 */
export async function registerSearchSchedule(
  queue: JobQueue,
  search: Pick<Settings["search"], "enabled" | "runTime">,
  tz: string,
): Promise<void> {
  if (!search.enabled) {
    await queue.unschedule(QUEUES.searchRun);
    return;
  }
  const [hours, minutes] = search.runTime.split(":").map(Number);
  await queue.schedule(QUEUES.searchRun, `${minutes} ${hours} * * *`, { tz });
}

// --- exclusions ---------------------------------------------------------------------------------

type ExclusionGroup = { names: string[] };

/** Longest company name sent in the exclusion list. */
export const EXCLUSION_NAME_MAX_CHARS = 120;
/** Most names sent in the exclusion list, over all groups. */
export const EXCLUSION_MAX_NAMES = 200;

/**
 * A name that is safe to put in the prompt: control characters removed (including line and
 * paragraph separators), trimmed, at most 120 characters and never ending on half a surrogate
 * pair. Company names come from stored records and from model output, which is untrusted
 * (SECURITY §9). Returns null when nothing is left.
 */
function cleanName(name: string): string | null {
  let clean = name.replace(/[\p{Cc}\u2028\u2029]/gu, "").trim();
  if (clean.length > EXCLUSION_NAME_MAX_CHARS) {
    clean = clean.slice(0, EXCLUSION_NAME_MAX_CHARS);
    const last = clean.charCodeAt(clean.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1);
    clean = clean.trim();
  }
  return clean === "" ? null : clean;
}

function sameName(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/**
 * Every company the owner has already seen: any company with a lead or application, plus the other
 * members of its corporate group, each with its name and aliases; one group per corporate group
 * (AC-10.3). `extra` holds company names returned by earlier rounds of this run that are not
 * stored (a dead posting's company), each its own group. Every name is cleaned (`cleanName`) and
 * the list holds at most 200 names: stored groups come first, then `extra`, and later names are
 * left out. Sorted, so the same data gives the same prompt.
 */
async function buildExclusions(
  prisma: PrismaClient,
  extra: readonly string[],
): Promise<ExclusionGroup[]> {
  const [withLead, withApp, companies] = await Promise.all([
    prisma.lead.findMany({ distinct: ["companyId"], select: { companyId: true } }),
    prisma.application.findMany({ distinct: ["companyId"], select: { companyId: true } }),
    prisma.company.findMany({
      select: { id: true, name: true, aliases: true, groupId: true },
    }),
  ]);
  const seen = new Set([...withLead, ...withApp].map((row) => row.companyId));
  const rootOf = (c: { id: string; groupId: string | null }): string => c.groupId ?? c.id;
  const seenRoots = new Set(companies.filter((c) => seen.has(c.id)).map(rootOf));

  const byRoot = new Map<string, string[]>();
  for (const company of companies) {
    const root = rootOf(company);
    if (!seenRoots.has(root)) continue;
    byRoot.set(root, [...(byRoot.get(root) ?? []), company.name, ...company.aliases]);
  }

  let room = EXCLUSION_MAX_NAMES;
  const groups: ExclusionGroup[] = [];
  const take = (names: readonly string[]): ExclusionGroup | null => {
    const cleaned = [...new Set(names.map(cleanName).filter((n): n is string => n !== null))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, room);
    room -= cleaned.length;
    return cleaned.length === 0 ? null : { names: cleaned };
  };
  const stored = [...byRoot.values()]
    .map((names) => [...names].sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  for (const names of stored) {
    const group = take(names);
    if (group !== null) groups.push(group);
  }
  for (const name of extra) {
    const group = take([name]);
    if (
      group !== null &&
      !groups.some((g) => g.names.some((n) => sameName(n, group.names[0] ?? "")))
    ) {
      groups.push(group);
    } else if (group !== null) {
      room += 1;
    }
  }
  return groups.sort((a, b) => (a.names[0] ?? "").localeCompare(b.names[0] ?? ""));
}

// --- one round ----------------------------------------------------------------------------------

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function compensationText(c: SearchLead["compensation"]): string | null {
  if (c.min === null && c.max === null) return null;
  const range =
    c.min !== null && c.max !== null && c.min !== c.max ? `${c.min}-${c.max}` : `${c.min ?? c.max}`;
  const unit = [c.currency, c.period === null ? null : `per ${c.period}`].filter(Boolean).join(" ");
  const estimate = c.isEstimate ? ` (estimate${c.basis === null ? "" : `: ${c.basis}`})` : "";
  return `${range} ${unit}`.trim() + estimate;
}

function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIncoming(
  lead: SearchLead,
  ref: string,
  order: number,
  link: LinkCheckResult,
): IncomingLead {
  return {
    ref,
    order,
    source: "search_agent",
    companyName: lead.company,
    companyDomain: lead.companyDomain,
    title: lead.title,
    jobUrl: lead.jobUrl,
    locationText: lead.locationText,
    country: lead.country,
    workMode: lead.workMode,
    compensationText: compensationText(lead.compensation),
    sponsorshipText: null,
    postedAt: parseDate(lead.postedAt),
    seniority: lead.seniority,
    ranking: clampRanking(lead),
    verification: link.verdict === "dead" ? null : link.verdict,
    pageExcerpt: link.verdict === "verified" ? link.pageExcerpt : null,
    sheetStatus: null,
    notes: null,
    contactEmail: null,
  };
}

type RoundOutcome = {
  batchId: string;
  /**
   * Distinct companies among the leads intake accepted. Finalize keeps one lead per company, so
   * this is what the batch will still hold; the stop check counts it, not the raw accepted count.
   */
  accepted: number;
  returned: number;
};

/**
 * Steps 1-3 of a round for the leads the model returned: drop leads without a usable job link
 * (no URL, or one with no job key), check the rest with a concurrency of 5, drop the dead ones
 * (counted in `dead` on the batch) and run intake on the others under the lock. Search leads
 * arrive checked and ranked, so intake stores them as `ready` and no `leads.check` is sent.
 */
async function ingestRound(
  ctx: WorkerCtx,
  runId: string,
  round: number,
  leads: SearchLead[],
  settings: Settings,
): Promise<RoundOutcome> {
  const linked = leads.filter((lead) => lead.jobUrl !== null && jobKey(lead.jobUrl) !== null);
  const checked = await mapLimit(linked, LINK_CHECK_CONCURRENCY, async (lead) => ({
    lead,
    link: await checkLink(lead.jobUrl as string, ctx.fetchLink),
  }));
  const alive = checked.filter(({ link }) => link.verdict !== "dead");
  const dead = checked.length - alive.length;
  const now = ctx.clock();

  const incoming = alive.map(({ lead, link }, order) =>
    toIncoming(lead, `search-${round}-${order}`, order, link),
  );
  const result = await withIntakeLock(ctx.prisma, async (tx) => {
    const ingested = await ingestLeads(tx, { kind: "search_run", searchRunId: runId }, incoming, {
      settings,
      now,
    });
    if (dead > 0) await bumpBatchCounts(tx, ingested.batchId, { dead });
    const stored = await tx.lead.findMany({
      where: { id: { in: ingested.leadIds } },
      select: { id: true, companyId: true, status: true },
    });
    for (const lead of stored) {
      await writeEvent(tx, {
        leadId: lead.id,
        companyId: lead.companyId,
        type: "lead_created",
        actor: "system",
        occurredAt: now,
        summary:
          lead.status === "new"
            ? "Found by the job search"
            : "Found by the job search and set aside",
        data: { source: "search_agent", searchRunId: runId, round, status: lead.status },
        undoable: false,
      });
    }
    const keptCompanies = new Set(
      stored.filter((lead) => lead.status === "new").map((lead) => lead.companyId),
    );
    return { ingested, accepted: keptCompanies.size };
  });
  return {
    batchId: result.ingested.batchId,
    accepted: result.accepted,
    returned: leads.length,
  };
}

// --- the run ------------------------------------------------------------------------------------

/** A short, content-free error for the run record (DATA_MODEL §3.12, SECURITY §4). */
function describeError(error: unknown): string {
  // The validation text names keys the model returned, so an invalid answer gets a fixed message.
  if (error instanceof LlmError && error.code === "invalid_output") {
    return "search_error: invalid_output";
  }
  if (error instanceof LlmError) return `llm_${error.code}: ${error.message}`.slice(0, 300);
  return `search_error: ${error instanceof Error ? error.name : "unknown"}`;
}

/** Web search calls and cost of the run's model calls (`llm_call` rows are the one record). */
async function usageOf(
  prisma: PrismaClient,
  runId: string,
): Promise<{ webSearchCalls: number; costMicros: bigint | null }> {
  const sum = await prisma.llmCall.aggregate({
    where: { searchRunId: runId },
    _sum: { webSearchCalls: true, costMicros: true },
  });
  return { webSearchCalls: sum._sum.webSearchCalls ?? 0, costMicros: sum._sum.costMicros };
}

/** The totals of the run's batches: stored counts, including leads finalize suppressed. */
async function totalsOf(prisma: PrismaClient, batchIds: string[]) {
  const batches = await prisma.intakeBatch.findMany({ where: { id: { in: batchIds } } });
  const total = { accepted: 0, suppressed: 0, duplicates: 0, dead: 0 };
  for (const batch of batches) {
    const counts = batch.counts as Record<keyof typeof total, number | undefined>;
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += counts[key] ?? 0;
  }
  return total;
}

/**
 * Runs a search (TECHNICAL_SPEC §7.3, AC-10.2 to AC-10.6) and returns its record. With no `runId`
 * it creates the `running` row itself (the scheduled run), and throws `409 already_running` when
 * another run exists. With a `runId` it carries on the row that `requestSearchRun` created for
 * *Run now*.
 *
 * Each round asks the model for `wanted` leads (the first asks for `leadTarget.max`), drops leads
 * without a job link, link-checks the rest with a concurrency of 5, drops the dead ones and runs
 * intake under the lock. The run stops when accepted ≥ `leadTarget.min` (counted as distinct
 * companies among accepted leads, since finalize keeps one lead per company), when a round accepts
 * nothing, or after `SEARCH_MAX_ROUNDS` rounds; otherwise the round's companies join the exclusion
 * list and the next round asks for `leadTarget.max − accepted`. Finally every batch of the run is
 * finalized.
 *
 * `SearchRun.rounds` is the number of rounds BEGUN: it is written when a round starts, before
 * the model is called, so while the run is `running` it already names the round in progress (the
 * web shows "Round N of 3"). The counts are updated after each round.
 *
 * Status: `succeeded` when accepted ≥ min; `partial` when it is not reached, or when a round
 * failed after earlier rounds accepted leads; `failed` when a round failed and nothing was
 * accepted. A failed round is recorded on the run, never thrown. Nothing is retried.
 */
export async function runSearch(
  ctx: WorkerCtx,
  trigger: SearchTrigger,
  runId?: string,
): Promise<SearchRunDto> {
  const { prisma } = ctx;
  let id: string;
  let settings: Settings | null = null;
  if (runId === undefined) {
    const created = await createRun(prisma, trigger, ctx.clock());
    id = created.row.id;
    settings = created.settings;
  } else {
    id = runId;
  }

  const maxRounds = ctx.env.searchMaxRounds;
  const batchIds: string[] = [];
  const roundCompanies: string[] = [];
  let returned = 0;
  let accepted = 0;
  let failure: string | null = null;

  let leadTarget: Settings["search"]["leadTarget"] | null = null;

  try {
    // Inside the try: a failed read closes the run as failed instead of leaving it `running`.
    settings ??= await getSettings(prisma);
    leadTarget = settings.search.leadTarget;
    if (runId !== undefined) {
      // The brief may have been edited since the run was requested: the hash is of the brief used.
      await prisma.searchRun.update({
        where: { id },
        data: { briefHash: createHash("sha256").update(settings.search.brief).digest("hex") },
      });
    }
    const cvProfile = await getActiveProfile(prisma);
    let wanted = leadTarget.max;
    for (let round = 1; round <= maxRounds; round += 1) {
      await prisma.searchRun.update({ where: { id }, data: { rounds: round } });
      const { output } = await ctx.llm.search(
        {
          today: ownerLocalDay(ctx.clock(), ctx.env.userTimezone),
          homeCountry: ctx.env.homeCountry,
          brief: settings.search.brief,
          cvProfile,
          tracks: settings.search.tracks,
          excludedSeniorities: settings.search.excludedSeniorities,
          exclusions: await buildExclusions(prisma, roundCompanies),
          wanted,
          round,
        },
        { searchRunId: id },
      );
      // The answer is untrusted: never check more links than were asked for, nor more than the
      // target maximum leaves room for (SECURITY §9). `returned` still counts what came back.
      const taken = output.leads.slice(0, Math.max(0, Math.min(wanted, leadTarget.max - accepted)));
      roundCompanies.push(...taken.map((lead) => lead.company));

      const outcome = await ingestRound(ctx, id, round, taken, settings);
      batchIds.push(outcome.batchId);
      returned += output.leads.length;
      accepted += outcome.accepted;

      const totals = await totalsOf(prisma, batchIds);
      await prisma.searchRun.update({
        where: { id },
        data: { returned, ...totals, ...(await usageOf(prisma, id)) },
      });

      if (accepted >= leadTarget.min || outcome.accepted === 0) break;
      wanted = leadTarget.max - accepted;
    }
  } catch (error) {
    failure = describeError(error);
  }

  try {
    for (const batchId of batchIds) await runFinalize(ctx, batchId);
  } catch (error) {
    failure ??= describeError(error);
  }

  try {
    const totals = await totalsOf(prisma, batchIds);
    const status =
      failure === null
        ? totals.accepted >= (leadTarget?.min ?? 0)
          ? "succeeded"
          : "partial"
        : totals.accepted > 0
          ? "partial"
          : "failed";
    const row = await prisma.searchRun.update({
      where: { id },
      data: {
        status,
        finishedAt: ctx.clock(),
        returned,
        ...totals,
        ...(await usageOf(prisma, id)),
        error: failure,
      },
    });
    return toDto(row);
  } catch (error) {
    // The record could not be written: close it anyway so it does not block later runs.
    await prisma.searchRun
      .update({
        where: { id },
        data: { status: "failed", finishedAt: ctx.clock(), error: describeError(error) },
      })
      .catch(() => undefined);
    throw error;
  }
}

// --- the job ------------------------------------------------------------------------------------

/**
 * The `search.run` handler. `{ runId }` carries on the run *Run now* created. Without one this is
 * the daily cron tick: it does nothing while search is disabled (a stale schedule) and ends
 * quietly when a run is already going. The queue never retries it (§9), and a run records its own
 * failures, so only an error before the record exists reaches pg-boss.
 */
export async function searchRunHandler(
  ctx: WorkerCtx,
  job: { data: Record<string, unknown> },
): Promise<void> {
  const runId = typeof job.data.runId === "string" && job.data.runId !== "" ? job.data.runId : null;
  if (runId !== null) {
    // A row that is gone or already closed (marked interrupted at a restart) has nothing to run.
    const row = await ctx.prisma.searchRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (row?.status === "running") await runSearch(ctx, "manual", runId);
    return;
  }
  if (!(await getSettings(ctx.prisma)).search.enabled) return;
  try {
    await runSearch(ctx, "schedule");
  } catch (error) {
    if (error instanceof ApiError && error.code === "already_running") {
      ctx.log.info("scheduled search skipped: a search is already running");
      return;
    }
    throw error;
  }
}
