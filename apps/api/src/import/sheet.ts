import { parse } from "csv-parse/sync";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type {
  ImportSummary,
  IntakeBatchKind,
  SheetPreview,
  SheetStatus,
  SheetTarget,
  WorkMode,
} from "@offerbound/contracts";
import {
  jobKey,
  localMidnightUtc,
  normalizeCompanyName,
  resolveCompany,
  rolesSimilar,
  type CompanyIndex,
  type IncomingLead,
} from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError } from "../http/errors.js";
import { enqueueLeadChecks, ingestLeads } from "../leads/intake.js";
import { getSettings } from "../settings/service.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The largest CSV the import takes (TECHNICAL_SPEC §10.1). */
export const MAX_SHEET_BYTES = 2 * 1024 * 1024;
/** How long a preview can be committed (DATA_MODEL §3.11). */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

const PREVIEW_KIND = "sheet_csv";
const BATCH_KIND: IntakeBatchKind = "sheet_import";

export type SheetRow = {
  /** The line of the file where the row starts, counting from 1, as an editor shows it. */
  line: number;
  company: string;
  role: string;
  country: string | null;
  cityModality: string | null;
  /** `YYYY-MM-DD`, validated; becomes local midnight at commit. */
  dateApplied: string | null;
  status: SheetStatus;
  salary: string | null;
  sponsorship: string | null;
  jobLink: string | null;
  notes: string | null;
};

export type SheetRowError = { line: number; message: string };

export type SheetParseResult = {
  rows: SheetRow[];
  errors: SheetRowError[];
  /** Line of the header row, or null when the file has none (then `rows` is empty). */
  headerLine: number | null;
};

// --- parsing ------------------------------------------------------------------------------------

const STATUS_BY_LABEL: Record<string, SheetStatus> = {
  "to research": "to_research",
  cancelled: "cancelled",
  applied: "applied",
  interview: "interview",
  rejected: "rejected",
};

const TARGET_BY_STATUS: Record<SheetStatus, SheetTarget> = {
  to_research: "lead_new",
  cancelled: "lead_dismissed",
  applied: "application_applied",
  interview: "application_interviewing",
  rejected: "application_rejected",
};

const APPLICATION_STATUS = {
  applied: "applied",
  interview: "interviewing",
  rejected: "rejected",
} as const;

type Columns = {
  company: number;
  role: number;
  status: number;
  country: number;
  cityModality: number;
  dateApplied: number;
  salary: number;
  sponsorship: number;
  jobLink: number;
  notes: number;
};

type RawRecord = { cells: string[]; line: number };

const normalizeCell = (cell: string): string => cell.trim().replace(/\s+/g, " ").toLowerCase();

/** DATA_MODEL §5: the first row with a cell ending in `company`, one equal to `role` and one to `status`. */
function findColumns(cells: string[]): Columns | null {
  const labels = cells.map(normalizeCell);
  const company = labels.findIndex((l) => l.endsWith("company"));
  const role = labels.indexOf("role");
  const status = labels.indexOf("status");
  if (company < 0 || role < 0 || status < 0) return null;
  const find = (test: (label: string) => boolean): number => labels.findIndex(test);
  return {
    company,
    role,
    status,
    country: find((l) => l === "country"),
    cityModality: find((l) => l.startsWith("city") || l.includes("modality")),
    dateApplied: find((l) => l.startsWith("date")),
    salary: find((l) => l.startsWith("salary") || l.startsWith("compensation")),
    sponsorship: find((l) => l.startsWith("sponsor") || l.startsWith("relocation")),
    jobLink: find((l) => l === "job link" || l === "link" || l.startsWith("job link")),
    notes: find((l) => l === "notes" || l === "note"),
  };
}

/**
 * The line each record starts on, as an editor shows it. csv-parse reports where a record ends,
 * and it counts the two characters of a CRLF inside a quoted field as two lines, so the lines are
 * counted here from the byte offset at which each record's text begins.
 */
function startLines(buf: Buffer, ends: readonly number[]): number[] {
  const text = buf.toString("latin1");
  const lines: number[] = [];
  let offset = 0;
  let line = 1;
  for (const end of ends) {
    // Blank lines between records were skipped by the parser: step over them.
    let start = offset;
    while (text[start] === "\r" || text[start] === "\n") start += 1;
    line += (text.slice(offset, start).match(/\r\n|\n|\r/g) ?? []).length;
    lines.push(line);
    line += (text.slice(start, end).match(/\r\n|\n|\r/g) ?? []).length;
    offset = end;
  }
  return lines;
}

function validDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The first problem a status label has, or the status it names. */
function readStatus(label: string): SheetStatus | null {
  return STATUS_BY_LABEL[normalizeCell(label)] ?? null;
}

const shorten = (value: string): string => (value.length > 40 ? `${value.slice(0, 40)}...` : value);

/**
 * Reads the Applications tab exported as CSV (AC-14.1-14.3). Title rows above the header and blank
 * rows are ignored. A row with a problem becomes an entry in `errors` and is left out of `rows`;
 * no message repeats more than a short status or date the owner typed.
 */
export function parseSheetCsv(buf: Buffer): SheetParseResult {
  let records: RawRecord[];
  try {
    const parsed = parse(buf, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      info: true,
    }) as unknown as { record: string[]; info: { bytes: number } }[];
    const lines = startLines(
      buf,
      parsed.map((p) => p.info.bytes),
    );
    records = parsed.map((p, i) => ({ cells: p.record, line: lines[i] ?? 1 }));
  } catch {
    return {
      rows: [],
      errors: [{ line: 1, message: "The file could not be read as CSV." }],
      headerLine: null,
    };
  }

  const headerIndex = records.findIndex((r) => findColumns(r.cells) !== null);
  const header = records[headerIndex];
  const columns = header === undefined ? null : findColumns(header.cells);
  if (header === undefined || columns === null) return { rows: [], errors: [], headerLine: null };

  const rows: SheetRow[] = [];
  const errors: SheetRowError[] = [];
  for (const record of records.slice(headerIndex + 1)) {
    const cell = (index: number): string | null => {
      if (index < 0) return null;
      const text = (record.cells[index] ?? "").replace(/\r\n?/g, "\n").trim();
      return text === "" ? null : text;
    };
    // A spreadsheet export pads empty rows with commas: nothing to import, nothing to report.
    if (record.cells.every((c) => c.trim() === "")) continue;

    const company = cell(columns.company);
    const role = cell(columns.role);
    const statusLabel = cell(columns.status);
    const dateApplied = cell(columns.dateApplied);
    const status = statusLabel === null ? null : readStatus(statusLabel);

    const problem =
      company === null
        ? "Company is missing."
        : role === null
          ? "Role is missing."
          : statusLabel === null
            ? "Status is missing."
            : status === null
              ? `Status "${shorten(statusLabel)}" isn't one Offerbound imports.`
              : dateApplied !== null && !validDay(dateApplied)
                ? `Date applied "${shorten(dateApplied)}" isn't in the YYYY-MM-DD format.`
                : null;
    if (problem !== null || company === null || role === null || status === null) {
      errors.push({ line: record.line, message: problem ?? "The row could not be read." });
      continue;
    }
    rows.push({
      line: record.line,
      company,
      role,
      country: cell(columns.country),
      cityModality: cell(columns.cityModality),
      dateApplied,
      status,
      salary: cell(columns.salary),
      sponsorship: cell(columns.sponsorship),
      jobLink: cell(columns.jobLink),
      notes: cell(columns.notes),
    });
  }
  return { rows, errors, headerLine: header.line };
}

/** `work_mode` from the City / modality text (DATA_MODEL §5). */
export function inferWorkMode(text: string | null): WorkMode {
  if (text === null) return "unknown";
  if (/remote/i.test(text)) return "remote";
  if (/hybrid/i.test(text)) return "hybrid";
  if (/on[\s-]?site|in[\s-]office/i.test(text)) return "onsite";
  return "unknown";
}

// --- comparing rows with each other and with what exists -----------------------------------------

/** A role title reduced to what must match for two rows to be the same job. */
function roleKey(role: string): string {
  return role
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type DuplicateInFile = { line: number; duplicateOfLine: number; company: string; role: string };

type Classified = {
  /** Rows an import would write, in file order. */
  importable: SheetRow[];
  duplicatesInFile: DuplicateInFile[];
  /** Rows that match a record Offerbound already has. */
  existing: SheetRow[];
};

async function loadCompanyIndex(db: Db): Promise<CompanyIndex> {
  const companies = await db.company.findMany({
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
  return { companies, contacts: [] };
}

type Existing = {
  jobKeys: Set<string>;
  /** Per company, the titles of its leads and applications. */
  titlesByCompany: Map<string, string[]>;
};

async function loadExisting(db: Db): Promise<Existing> {
  const jobKeys = new Set<string>();
  const titlesByCompany = new Map<string, string[]>();
  const leads = await db.lead.findMany({ select: { jobKey: true, companyId: true, title: true } });
  const apps = await db.application.findMany({
    select: { jobKey: true, companyId: true, title: true },
  });
  for (const row of [...leads, ...apps]) {
    if (row.jobKey !== null) jobKeys.add(row.jobKey);
    const titles = titlesByCompany.get(row.companyId);
    if (titles) titles.push(row.title);
    else titlesByCompany.set(row.companyId, [row.title]);
  }
  return { jobKeys, titlesByCompany };
}

const linkKey = (row: SheetRow): string | null =>
  row.jobLink === null ? null : jobKey(row.jobLink);

/**
 * Splits parsed rows into those an import would write, repeats inside the file (the first row
 * wins) and matches with records that exist (AC-14.4, AC-14.5): same job key, or same company and
 * the same role or a similar one (word overlap of at least 0.6, as for email matching). Repeats
 * inside the file stay exact: only identical rows are duplicates of each other.
 */
async function classifyRows(db: Db, rows: readonly SheetRow[]): Promise<Classified> {
  const seenKeys = new Map<string, number>();
  const kept: SheetRow[] = [];
  const duplicatesInFile: DuplicateInFile[] = [];
  for (const row of rows) {
    const keys = [linkKey(row), `${normalizeCompanyName(row.company)}|${roleKey(row.role)}`].filter(
      (k): k is string => k !== null,
    );
    const firstLine = keys.map((k) => seenKeys.get(k)).find((l) => l !== undefined);
    if (firstLine !== undefined) {
      duplicatesInFile.push({
        line: row.line,
        duplicateOfLine: firstLine,
        company: row.company,
        role: row.role,
      });
      continue;
    }
    for (const k of keys) seenKeys.set(k, row.line);
    kept.push(row);
  }

  const index = await loadCompanyIndex(db);
  const existing = await loadExisting(db);
  const importable: SheetRow[] = [];
  const matched: SheetRow[] = [];
  for (const row of kept) {
    const key = linkKey(row);
    const company = resolveCompany(
      { senderEmail: null, extractedName: row.company, websiteDomain: null, jobUrl: row.jobLink },
      index,
    );
    const known =
      (key !== null && existing.jobKeys.has(key)) ||
      (company.kind === "existing" &&
        (existing.titlesByCompany.get(company.companyId) ?? []).some(
          (title) => roleKey(title) === roleKey(row.role) || rolesSimilar(title, row.role),
        ));
    (known ? matched : importable).push(row);
  }
  return { importable, duplicatesInFile, existing: matched };
}

// --- preview ------------------------------------------------------------------------------------

const rowSchema = z.object({
  line: z.number().int(),
  company: z.string(),
  role: z.string(),
  country: z.string().nullable(),
  cityModality: z.string().nullable(),
  dateApplied: z.string().nullable(),
  status: z.enum(["to_research", "cancelled", "applied", "interview", "rejected"]),
  salary: z.string().nullable(),
  sponsorship: z.string().nullable(),
  jobLink: z.string().nullable(),
  notes: z.string().nullable(),
});

/** What `import_preview.payload` holds for a sheet: the rows that parsed and the rows that did not. */
const payloadSchema = z.object({
  rows: z.array(rowSchema),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});

async function assertNotImported(db: Db, fileHash: string): Promise<void> {
  const batch = await db.intakeBatch.findFirst({ where: { fileHash }, select: { id: true } });
  if (batch !== null) {
    throw new ApiError(409, "duplicate_import", "This file was already imported.");
  }
}

/**
 * Says what importing `rows` would do, and keeps the rows for an hour so `commitSheet` can write
 * them (AC-14.4). Writes only the preview row: no application, lead or company. A file that was
 * imported before is refused (AC-14.5).
 */
export async function previewSheet(
  db: PrismaClient,
  rows: SheetRow[],
  errors: SheetRowError[],
  fileHash: string,
  now: Date,
): Promise<SheetPreview> {
  await assertNotImported(db, fileHash);
  const { importable, duplicatesInFile, existing } = await classifyRows(db, rows);

  const counts = new Map<SheetStatus, number>();
  for (const row of importable) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

  // Expired previews are of no use to anyone; clearing them here keeps the table small.
  await db.importPreview.deleteMany({ where: { expiresAt: { lte: now } } });
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS);
  const payload: z.infer<typeof payloadSchema> = { rows, errors };
  const stored = await db.importPreview.create({
    data: {
      kind: PREVIEW_KIND,
      fileHash,
      payload,
      createdAt: now,
      expiresAt,
    },
  });

  return {
    previewId: stored.id,
    expiresAt: expiresAt.toISOString(),
    totalRows: rows.length + errors.length,
    mappings: (Object.keys(TARGET_BY_STATUS) as SheetStatus[])
      .filter((status) => (counts.get(status) ?? 0) > 0)
      .map((status) => ({
        sheetStatus: status,
        target: TARGET_BY_STATUS[status],
        rows: counts.get(status) ?? 0,
      })),
    errors,
    duplicatesInFile,
    existingMatches: existing.length,
  };
}

// --- commit -------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): ApiError =>
  new ApiError(404, "not_found", "This preview has expired. Add the file again.");

const STATUS_LABEL: Record<SheetStatus, string> = {
  to_research: "To research",
  cancelled: "Cancelled",
  applied: "Applied",
  interview: "Interview",
  rejected: "Rejected",
};

function incomingLead(row: SheetRow, order: number): IncomingLead {
  return {
    ref: `line:${row.line}`,
    order,
    source: "sheet_import",
    companyName: row.company,
    companyDomain: null,
    title: row.role,
    jobUrl: row.jobLink,
    locationText: row.cityModality,
    country: row.country,
    workMode: inferWorkMode(row.cityModality),
    compensationText: row.salary,
    sponsorshipText: row.sponsorship,
    postedAt: null,
    seniority: null,
    ranking: null,
    verification: null,
    pageExcerpt: null,
    sheetStatus: row.status === "cancelled" ? "cancelled" : "to_research",
    notes: row.notes,
    contactEmail: null,
  };
}

/**
 * Writes the rows of a preview (AC-14.2, AC-14.5, AC-14.6), all in one transaction under the
 * intake lock: applications with a non-undoable `imported` event, leads through `ingestLeads`
 * (which skips the company-seen and one-per-company rules for a sheet), and a `lead_created`
 * event per lead. `leads.check` is sent for the New leads after the commit. The preview is used
 * up: committing it again answers `not_found`. Rows are compared with the records again here,
 * because the database may have changed since the preview.
 */
export async function commitSheet(ctx: WorkerCtx, previewId: string): Promise<ImportSummary> {
  if (!UUID.test(previewId)) throw notFound();
  const now = ctx.clock();
  const tz = ctx.env.userTimezone;

  const outcome = await withIntakeLock(ctx.prisma, async (tx) => {
    const preview = await tx.importPreview.findUnique({ where: { id: previewId } });
    if (preview === null || preview.kind !== PREVIEW_KIND || preview.expiresAt <= now) {
      throw notFound();
    }
    const payload = payloadSchema.safeParse(preview.payload);
    if (!payload.success) throw notFound();
    if (preview.fileHash !== null) await assertNotImported(tx, preview.fileHash);

    const { importable, duplicatesInFile, existing } = await classifyRows(tx, payload.data.rows);
    const settings = await getSettings(tx);

    // Applications first: the companies they create are then known to the lead intake below.
    const index = await loadCompanyIndex(tx);
    let applicationsCreated = 0;
    for (const row of importable) {
      if (row.status !== "applied" && row.status !== "interview" && row.status !== "rejected") {
        continue;
      }
      const resolution = resolveCompany(
        { senderEmail: null, extractedName: row.company, websiteDomain: null, jobUrl: row.jobLink },
        index,
      );
      if (resolution.kind === "none") continue;
      let companyId: string;
      if (resolution.kind === "existing") {
        companyId = resolution.companyId;
      } else {
        const company = await tx.company.create({
          data: {
            name: resolution.company.name,
            normalizedName: resolution.company.normalizedName,
            domains: resolution.company.domains,
            atsSlugs: resolution.company.atsSlugs,
            websiteDomain: resolution.company.websiteDomain,
            createdSource: "sheet_import",
            createdAt: now,
            updatedAt: now,
          },
        });
        index.companies.push({
          id: company.id,
          name: company.name,
          normalizedName: company.normalizedName,
          aliases: [],
          domains: company.domains,
          atsSlugs: company.atsSlugs,
          groupId: null,
        });
        companyId = company.id;
      }
      const status = APPLICATION_STATUS[row.status];
      const appliedAt = row.dateApplied === null ? null : localMidnightUtc(row.dateApplied, tz);
      const application = await tx.application.create({
        data: {
          companyId,
          title: row.role,
          jobUrl: row.jobLink,
          jobKey: linkKey(row),
          locationText: row.cityModality,
          country: row.country,
          workMode: inferWorkMode(row.cityModality),
          compensationText: row.salary,
          sponsorshipText: row.sponsorship,
          status,
          statusChangedAt: appliedAt ?? now,
          appliedAt,
          source: "sheet_import",
          notes: row.notes,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.event.create({
        data: {
          applicationId: application.id,
          companyId,
          type: "imported",
          actor: "import",
          occurredAt: now,
          summary: `Imported from your spreadsheet as ${STATUS_LABEL[row.status]}`,
          data: { toStatus: status, line: row.line },
          undoable: false,
        },
      });
      applicationsCreated += 1;
    }

    const incoming = importable
      .filter((row) => row.status === "to_research" || row.status === "cancelled")
      .map((row, order) => incomingLead(row, order));
    // Always run: the batch is what remembers the file hash, even for a sheet of applications only.
    const result = await ingestLeads(
      tx,
      { kind: BATCH_KIND, ...(preview.fileHash === null ? {} : { fileHash: preview.fileHash }) },
      incoming,
      { settings, now },
    );

    const leads = await tx.lead.findMany({
      where: { id: { in: result.leadIds } },
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
          lead.status === "dismissed"
            ? "Imported from your spreadsheet as a dismissed lead"
            : "Imported from your spreadsheet as a new lead",
        data: { source: "sheet_import", status: lead.status },
        undoable: false,
      })),
    });

    await tx.importPreview.delete({ where: { id: previewId } });

    const summary: ImportSummary = {
      applicationsCreated,
      leadsCreated: leads.filter((l) => l.status === "new").length,
      leadsDismissed: leads.filter((l) => l.status === "dismissed").length,
      skippedExisting: existing.length + result.counts.duplicates,
      skippedDuplicateRows: duplicatesInFile.length,
      errorRows: payload.data.errors.length,
    };
    return { summary, result };
  });

  // After the commit, so a worker never looks for a lead it cannot see yet. A send that fails is
  // logged; `sendPendingChecks` (run by the 1-minute sweep) sends it later.
  await enqueueLeadChecks(ctx.queue, outcome.result, ctx.log);
  return outcome.summary;
}
