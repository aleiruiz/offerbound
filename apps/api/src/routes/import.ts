import { createHash } from "node:crypto";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import {
  ReportCommitBodySchema,
  ReportPreviewBodySchema,
  SheetCommitBodySchema,
  type ImportSummary,
  type ReportCommitResult,
  type ReportPreview,
  type SheetPreview,
} from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { commitReport, previewReport } from "../leads/report.js";
import { commitSheet, MAX_SHEET_BYTES, parseSheetCsv, previewSheet } from "../import/sheet.js";

/**
 * Import routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope.
 *
 * Like the CV upload, the file is pulled lazily with `request.file()` after the session guard has
 * run, held in memory and never written to disk. The upload plugin is registered once per scope
 * (the CV routes register it first, with a 5 MB cap); this route sets its own 2 MB cap per
 * request, so the two limits don't meet.
 */
export async function registerImportRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  if (!app.hasRequestDecorator("file")) {
    await app.register(multipart, {
      limits: { fileSize: MAX_SHEET_BYTES, fieldSize: 1024, files: 1, fields: 5, parts: 6 },
    });
  }

  app.post("/import/sheet/preview", async (request): Promise<SheetPreview> => {
    if (!request.isMultipart()) {
      throw new ApiError(400, "validation_failed", "Send the CSV as multipart form data.", {
        file: "required",
      });
    }
    const part = await request.file({ limits: { fileSize: MAX_SHEET_BYTES } });
    if (!part || part.fieldname !== "file") {
      throw new ApiError(400, "validation_failed", "Attach the CSV in the file field.", {
        file: "required",
      });
    }
    // Busboy stops at the cap and `toBuffer` rejects with a 413, which the error handler maps.
    const bytes = await part.toBuffer();
    const parsed = parseSheetCsv(bytes);
    if (parsed.headerLine === null) {
      throw new ApiError(
        400,
        "validation_failed",
        "Offerbound couldn't find a header row with Company, Role and Status.",
        { file: "no_header_row" },
      );
    }
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    return previewSheet(deps.prisma, parsed.rows, parsed.errors, fileHash, deps.clock());
  });

  app.post("/import/sheet/commit", async (request, reply): Promise<ImportSummary> => {
    const { previewId } = SheetCommitBodySchema.parse(request.body);
    const summary = await commitSheet({ ...deps, log: request.log }, previewId);
    return reply.code(201).send(summary);
  });

  // A pasted report (TECHNICAL_SPEC §7.6). The text is untrusted and never logged. A text over
  // 50,000 characters is a 413 from the service; a body over Fastify's 1 MB limit is one too.
  app.post("/leads/import/preview", async (request): Promise<ReportPreview> => {
    const { text } = ReportPreviewBodySchema.parse(request.body);
    return previewReport({ ...deps, log: request.log }, text);
  });

  app.post("/leads/import/commit", async (request, reply): Promise<ReportCommitResult> => {
    const { previewId, keepRowIds } = ReportCommitBodySchema.parse(request.body);
    const result = await commitReport({ ...deps, log: request.log }, previewId, keepRowIds);
    return reply.code(202).send(result);
  });
}
