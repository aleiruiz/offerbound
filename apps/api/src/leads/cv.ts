import type { PrismaClient } from "@prisma/client";
import { CvProfileSchema, type CvProfile } from "@offerbound/contracts";
import { ApiError } from "../http/errors.js";
import type { LlmProvider } from "../llm/provider.js";
import { CvExtractionError, extractRawText, type CvKind } from "./cv-extract.js";

/** CV upload rules (TECHNICAL_SPEC §7.5, SECURITY §10). The file is parsed in memory, never stored. */
export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_CV_BYTES = 5 * 1024 * 1024;
/** Fewer characters than this means the file has no usable text (`cv_no_text`). */
export const MIN_CV_TEXT_CHARS = 200;
/** Bounds what is stored and sent to the model; a CV is a few thousand characters. */
export const MAX_CV_TEXT_CHARS = 50_000;

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const unsupported = (): ApiError =>
  new ApiError(422, "unsupported_file", "Upload a PDF or Word (.docx) file.");

function startsWith(buf: Buffer, magic: Buffer): boolean {
  return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}

/** `application/pdf; charset=x` → `application/pdf`. */
function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Extracts the text of an uploaded CV. The declared MIME type must be PDF or DOCX *and* the first
 * bytes must agree (`%PDF-`, or `PK\x03\x04` for DOCX); neither the extension nor the MIME type
 * is trusted alone. Anything else, or a file the parser rejects, is `unsupported_file`. The
 * result is trimmed and capped at {@link MAX_CV_TEXT_CHARS}; it can be empty (the caller decides
 * what counts as no text). Never logs content.
 */
export async function extractCvText(
  buf: Buffer,
  mime: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const type = baseMime(mime);
  let kind: CvKind;
  if (type === PDF_MIME && startsWith(buf, PDF_MAGIC)) kind = "pdf";
  else if (type === DOCX_MIME && startsWith(buf, ZIP_MAGIC)) kind = "docx";
  else throw unsupported();

  let raw: string;
  try {
    raw = await extractRawText(kind, buf, MAX_CV_TEXT_CHARS + 2, options.timeoutMs);
  } catch (error) {
    // Corrupt, encrypted, too big when inflated, or too slow. The parser's message can quote content.
    if (error instanceof CvExtractionError) throw unsupported();
    throw error;
  }
  return clampText(raw);
}

/**
 * Cleans and cuts extracted text to {@link MAX_CV_TEXT_CHARS} characters without copying the whole
 * string first. NUL is removed (PostgreSQL text cannot hold it), and a surrogate pair is never
 * split.
 */
function clampText(raw: string): string {
  let text = raw
    .slice(0, MAX_CV_TEXT_CHARS + 2)
    .replaceAll("\u0000", "")
    .trim();
  if (text.length > MAX_CV_TEXT_CHARS) text = text.slice(0, MAX_CV_TEXT_CHARS);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text;
}

/** Display name only: control characters (NUL breaks the insert) removed, length capped. */
function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 255) || "cv";
}

export type CvDeps = { prisma: PrismaClient; llm: LlmProvider };
export type CvUpload = { fileName: string; mimeType: string; bytes: Buffer };
export type CvLogger = { warn(fields: Record<string, unknown>, message?: string): void };

/** Name and code of a failed call, never its message: that can quote the prompt (SECURITY §4). */
function failureFields(error: unknown): Record<string, unknown> {
  const { name, code } = error as { name?: unknown; code?: unknown };
  return {
    errorName: typeof name === "string" ? name : "unknown",
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

type ProfileOutcome = { profile: CvProfile; model: string } | null;

async function generateProfile(
  llm: LlmProvider,
  text: string,
  log: CvLogger,
): Promise<ProfileOutcome> {
  try {
    const { output, usage } = await llm.cvProfile(text);
    return { profile: CvProfileSchema.parse(output), model: usage.model };
  } catch (error) {
    log.warn(failureFields(error), "cv profile failed");
    return null;
  }
}

/** Serialises CV writes so two uploads cannot both try to be the active one. */
async function lockCv(tx: Pick<PrismaClient, "$executeRaw">): Promise<void> {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtext('offerbound.cv'))`;
}

/**
 * Stores an uploaded CV: extracts the text, asks the model for the profile, and makes the new row
 * the active one (the previous CV becomes inactive). When the model fails the text is stored with
 * `profile` null and `ok` is false; the owner can retry. Replacing the CV never touches leads
 * (AC-11.4). Only the text and the profile are kept, not the file (AC-11.3).
 */
export async function storeCv(
  deps: CvDeps,
  upload: CvUpload,
  log: CvLogger,
): Promise<{ ok: true; profile: CvProfile } | { ok: false }> {
  const text = await extractCvText(upload.bytes, upload.mimeType);
  if (text.length < MIN_CV_TEXT_CHARS) {
    throw new ApiError(422, "cv_no_text", "This file has no readable text. Try another file.");
  }
  const outcome = await generateProfile(deps.llm, text, log);

  await deps.prisma.$transaction(async (tx) => {
    await lockCv(tx);
    await tx.candidateProfile.updateMany({ where: { isActive: true }, data: { isActive: false } });
    await tx.candidateProfile.create({
      data: {
        fileName: safeFileName(upload.fileName),
        mimeType: baseMime(upload.mimeType),
        sizeBytes: upload.bytes.length,
        textContent: text,
        profile: outcome?.profile ?? undefined,
        profileStatus: outcome ? "ok" : "failed",
        model: outcome?.model ?? null,
        isActive: true,
      },
    });
  });
  return outcome ? { ok: true, profile: outcome.profile } : { ok: false };
}

/**
 * The active CV's profile; null when there is no CV, its profile has not been generated, or the
 * stored profile no longer matches the schema (treated like a failed profile: *Retry profile*
 * regenerates it, rather than the read failing).
 */
export async function getActiveProfile(
  prisma: PrismaClient,
  log?: CvLogger,
): Promise<CvProfile | null> {
  const row = await prisma.candidateProfile.findFirst({ where: { isActive: true } });
  if (!row || row.profile === null) return null;
  const parsed = CvProfileSchema.safeParse(row.profile);
  if (!parsed.success) {
    // Name only: the stored profile is personal content.
    log?.warn({ errorName: "ZodError" }, "stored cv profile does not match the schema");
    return null;
  }
  return parsed.data;
}

/** Re-runs the profile step on the active CV's stored text (*Retry profile*). */
export async function retryProfile(deps: CvDeps, log: CvLogger): Promise<CvProfile> {
  const row = await deps.prisma.candidateProfile.findFirst({ where: { isActive: true } });
  if (!row) throw new ApiError(404, "not_found", "Upload a CV first.");
  const outcome = await generateProfile(deps.llm, row.textContent, log);
  if (!outcome) {
    throw new ApiError(502, "upstream_error", "The profile could not be generated. Try again.");
  }
  // Only if it is still the active CV: it may have been replaced while the model ran.
  const { count } = await deps.prisma.candidateProfile.updateMany({
    where: { id: row.id, isActive: true },
    data: { profile: outcome.profile, profileStatus: "ok", model: outcome.model },
  });
  if (count === 0) {
    throw new ApiError(409, "version_conflict", "Your CV was replaced. Check the new one.");
  }
  return outcome.profile;
}
