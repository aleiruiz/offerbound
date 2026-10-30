import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_REPORT_CHARS,
  MAX_REPORT_ROWS,
  ReportLeadSchema,
  type IntakeBatchKind,
  type ReportLead,
  type ReportPreview,
  type ReportRowAnnotation,
} from "@offerbound/contracts";
import type { IncomingLead, IntakeDecision } from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError } from "../http/errors.js";
import { PREVIEW_TTL_MS } from "../import/sheet.js";
import { getSettings } from "../settings/service.js";
import { cleanText } from "./exclusions.js";
import { dryRunIntake, enqueueLeadChecks, ingestLeads } from "./intake.js";

/** What the report steps need: the database, the model, the queue and a content-free logger. */
export type ReportCtx = Pick<WorkerCtx, "prisma" | "llm" | "queue" | "clock" | "log">;

const PREVIEW_KIND = "paste_report";
const BATCH_KIND: IntakeBatchKind = "paste_report";

// --- cleaning what the model returned -----------------------------------------------------------

const LIMITS = {
  company: 200,
  title: 300,
  location: 200,
  country: 100,
  compensation: 200,
  domain: 253,
  url: 2048,
  date: 40,
} as const;

/** One line of text: every run of whitespace becomes a space, then control characters go. */
function field(value: string | null, max: number): string | null {
  return value === null ? null : cleanText(value.replace(/\s+/g, " "), max);
}

function httpUrl(value: string | null): string | null {
  const text = field(value, LIMITS.url);
  if (text === null) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

function domain(value: string | null): string | null {
  const text = field(value, LIMITS.domain)?.toLowerCase() ?? null;
  return text !== null && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text) ? text : null;
}

function validDate(value: string | null): string | null {
  const text = field(value, LIMITS.date);
  return text !== null && !Number.isNaN(new Date(text).getTime()) ? text : null;
}

/**
 * Bounds the model's answer before it is stored or shown: text fields are one line of at most a
 * fixed length without control or format characters, links must be http(s), a domain must look
 * like one, a date must parse, and a row with no company or no title is not a posting and is left
 * out. At most `MAX_REPORT_ROWS` rows are kept, in order; `dropped` counts the postings after
 * them, so the page can say they were not read.
 */
export function cleanReportLeads(leads: readonly ReportLead[]): {
  leads: ReportLead[];
  dropped: number;
} {
  const cleaned: ReportLead[] = [];
  let dropped = 0;
  for (const lead of leads) {
    const company = field(lead.company, LIMITS.company);
    const title = field(lead.title, LIMITS.title);
    if (company === null || title === null) continue;
    if (cleaned.length === MAX_REPORT_ROWS) {
      dropped += 1;
      continue;
    }
    cleaned.push({
      company,
      companyDomain: domain(lead.companyDomain),
      title,
      jobUrl: httpUrl(lead.jobUrl),
      locationText: field(lead.locationText, LIMITS.location),
      country: field(lead.country, LIMITS.country),
      workMode: lead.workMode,
      compensationText: field(lead.compensationText, LIMITS.compensation),
      postedAt: validDate(lead.postedAt),
      seniority: lead.seniority,
    });
  }
  return { leads: cleaned, dropped };
}

// --- rows → intake ------------------------------------------------------------------------------

function incomingLead(lead: ReportLead, order: number): IncomingLead {
  return {
    ref: `report:${order}`,
    order,
    source: "paste_report",
    companyName: lead.company,
    companyDomain: lead.companyDomain,
    title: lead.title,
    jobUrl: lead.jobUrl,
    locationText: lead.locationText,
    country: lead.country,
    workMode: lead.workMode,
    compensationText: lead.compensationText,
    sponsorshipText: null,
    postedAt: lead.postedAt === null ? null : new Date(lead.postedAt),
    seniority: lead.seniority,
    ranking: null,
    verification: null,
    pageExcerpt: null,
    sheetStatus: null,
    notes: null,
    contactEmail: null,
  };
}

/** How the intake rules treat a row (TECHNICAL_SPEC §7.6); `null` when intake could not store it. */
function annotate(decision: IntakeDecision): ReportRowAnnotation | null {
  if (decision.action === "discard") return "duplicate";
  if (decision.company.kind === "none") return null;
  if (decision.suppressedReason === "company_already_seen") return "company_already_seen";
  if (decision.suppressedReason === "excluded_seniority") return "excluded_seniority";
  return "new";
}

// --- preview ------------------------------------------------------------------------------------

const payloadSchema = z.object({
  rows: z.array(z.object({ rowId: z.string(), lead: ReportLeadSchema })),
});

/** Name and code of a failed call, never its message: that can quote the prompt (SECURITY §4). */
function failureFields(error: unknown): Record<string, unknown> {
  const { name, code } = error as { name?: unknown; code?: unknown };
  return {
    errorName: typeof name === "string" ? name : "unknown",
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

/**
 * Reads a pasted report and says what importing it would do (AC-9.4). The model turns the text
 * into rows, then `planIntake` is dry-run over them against the records as they are: each row is
 * `new`, a `duplicate`, from a `company_already_seen` or an `excluded_seniority`. Writes only the
 * preview row, which lives for an hour: no lead, company or batch. The text is never logged.
 */
export async function previewReport(ctx: ReportCtx, text: string): Promise<ReportPreview> {
  if (text.length > MAX_REPORT_CHARS) {
    throw new ApiError(413, "too_large", "This report is too long. Paste a shorter one.");
  }
  if (text.trim() === "") {
    throw new ApiError(400, "validation_failed", "Paste the report text.", { text: "required" });
  }

  let parsed: ReportLead[];
  try {
    parsed = (await ctx.llm.parseReport(text)).output.leads;
  } catch (error) {
    ctx.log.warn(failureFields(error), "report parsing failed");
    throw new ApiError(502, "upstream_error", "The report could not be read. Try again.");
  }
  const { leads, dropped } = cleanReportLeads(parsed);

  const now = ctx.clock();
  const settings = await getSettings(ctx.prisma);
  const decisions = await dryRunIntake(ctx.prisma, BATCH_KIND, leads.map(incomingLead), settings);
  const rows: ReportPreview["rows"] = [];
  leads.forEach((lead, index) => {
    const decision = decisions[index];
    const annotation = decision === undefined ? null : annotate(decision);
    if (annotation !== null) {
      rows.push({ rowId: randomUUID(), annotation, defaultKeep: annotation === "new", lead });
    }
  });

  // Expired previews are of no use to anyone; clearing them here keeps the table small.
  await ctx.prisma.importPreview.deleteMany({ where: { expiresAt: { lte: now } } });
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS);
  const payload: z.infer<typeof payloadSchema> = {
    rows: rows.map(({ rowId, lead }) => ({ rowId, lead })),
  };
  const stored = await ctx.prisma.importPreview.create({
    data: { kind: PREVIEW_KIND, payload, createdAt: now, expiresAt },
  });
  return { previewId: stored.id, expiresAt: expiresAt.toISOString(), rows, droppedRows: dropped };
}

// --- commit -------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): ApiError =>
  new ApiError(404, "not_found", "This preview has expired. Paste the report again.");

/**
 * Creates the leads of a preview that the owner kept checked (AC-9.4), as one `paste_report`
 * batch. Intake runs again here, under the lock, over the records as they are now, so a row the
 * preview called `new` can come out suppressed if something changed since. Each stored lead gets a
 * `lead_created` event; `leads.check` is sent for those that wait for a check after the commit,
 * and the rest of the batch (ranking, one lead per company) follows as for any batch. The preview
 * is used up: committing it again answers `not_found`. A row id the preview does not hold is a
 * `400 validation_failed`, and nothing is written.
 */
export async function commitReport(
  ctx: ReportCtx,
  previewId: string,
  keepRowIds: readonly string[],
): Promise<{ batchId: string }> {
  if (!UUID.test(previewId)) throw notFound();
  const now = ctx.clock();

  const result = await withIntakeLock(ctx.prisma, async (tx) => {
    const preview = await tx.importPreview.findUnique({ where: { id: previewId } });
    if (preview === null || preview.kind !== PREVIEW_KIND || preview.expiresAt <= now) {
      throw notFound();
    }
    const payload = payloadSchema.safeParse(preview.payload);
    if (!payload.success) throw notFound();

    const known = new Set(payload.data.rows.map((row) => row.rowId));
    if (keepRowIds.some((rowId) => !known.has(rowId))) {
      throw new ApiError(
        400,
        "validation_failed",
        "Some of the selected rows are not in this preview.",
        {
          keepRowIds: "unknown_row",
        },
      );
    }
    const keep = new Set(keepRowIds);
    // The report's own order is kept: "first in the report" decides which duplicate wins.
    const kept = payload.data.rows.filter((row) => keep.has(row.rowId));

    const settings = await getSettings(tx);
    const ingested = await ingestLeads(
      tx,
      { kind: BATCH_KIND },
      kept.map((row, order) => incomingLead(row.lead, order)),
      { settings, now },
    );

    const leads = await tx.lead.findMany({
      where: { id: { in: ingested.leadIds } },
      select: { id: true, companyId: true, status: true },
    });
    await tx.event.createMany({
      data: leads.map((lead) => ({
        leadId: lead.id,
        companyId: lead.companyId,
        type: "lead_created" as const,
        actor: "import" as const,
        occurredAt: now,
        summary:
          lead.status === "new"
            ? "Imported from a pasted report as a new lead"
            : "Imported from a pasted report and set aside",
        data: { source: "paste_report", status: lead.status },
        undoable: false,
      })),
    });
    await tx.importPreview.delete({ where: { id: previewId } });
    return ingested;
  });

  // After the commit, so a worker never looks for a lead it cannot see yet. A send that fails is
  // logged; `sendPendingChecks` (run by the 1-minute sweep) sends it later.
  await enqueueLeadChecks(ctx.queue, result, ctx.log);
  return { batchId: result.batchId };
}
