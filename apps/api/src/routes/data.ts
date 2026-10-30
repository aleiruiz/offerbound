import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withIntakeLock } from "../db/lock.js";
import type { AppDeps } from "../deps.js";

/** `{ confirm: "DELETE" }`: the typed confirmation the Data settings section sends (AC-15.2). */
const PurgeBodySchema = z.strictObject({ confirm: z.literal("DELETE") });

/**
 * Data routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope.
 *
 * `POST /data/purge-email-content` (Should; AC-15.2; SECURITY §3) clears the stored sender,
 * recipients, subject, preview and body of every message, and answers how many messages held any.
 * Records, timelines and each message's state, summary and extraction stay, so the pipeline never
 * picks a purged message up again: it only reads rows that are still `discovered`, `job_related`
 * or `extracted`, and sync inserts ids it already has as no-ops. The three in-flight states are
 * purged too (AC-15.2 says all content). A `discovered` row holds none; a `job_related` row has its
 * body fetched and stored again by extraction, like a mail arriving after the purge; an
 * `extracted` row applies from its stored extraction with a null sender, which the planner
 * tolerates (it then skips the sender-domain company match). It runs under the intake lock, so
 * a pipeline step is never half way through a message while its content goes. Only the count is
 * logged.
 */
export function registerDataRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/data/purge-email-content", async (request) => {
    PurgeBodySchema.parse(request.body);
    const messagesPurged = await withIntakeLock(
      deps.prisma,
      (tx) =>
        // Raw SQL: Prisma cannot write NULL to a list column. A NULL list reads back as `[]`.
        tx.$executeRaw`
        UPDATE gmail_message
        SET body_text = NULL, snippet = NULL, subject = NULL,
            from_name = NULL, from_email = NULL, to_emails = NULL
        WHERE body_text IS NOT NULL OR snippet IS NOT NULL OR subject IS NOT NULL
           OR from_name IS NOT NULL OR from_email IS NOT NULL
           OR COALESCE(cardinality(to_emails), 0) > 0`,
    );
    request.log.info({ messagesPurged }, "purged stored email content");
    return { messagesPurged };
  });
}
