import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { CvProfile, CvUploadFailed } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { getActiveProfile, MAX_CV_BYTES, retryProfile, storeCv } from "../leads/cv.js";

/**
 * CV routes (TECHNICAL_SPEC §7.5, §10.1). Register inside the guarded scope.
 *
 * The session guard is the scope's preHandler (see app.ts). It runs before the handler, and the
 * handler is what reads the upload: the file is pulled lazily with `request.file()`, so an
 * unauthenticated request is refused with its body unread. Do not switch to `attachFieldsToBody`
 * or an `onFile` handler, which would read the body first; a test covers this. The size cap is
 * enforced while the file streams in; the file is held in memory and never written to disk
 * (AC-11.3).
 */
export async function registerCvRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(multipart, {
    // Busboy stops reading a file past the cap and the stream errors with a 413.
    // `fieldSize` bounds the non-file fields, which busboy would otherwise allow 1 MB each.
    limits: {
      fileSize: MAX_CV_BYTES,
      fieldSize: 1024,
      files: 1,
      fields: 5,
      parts: 6,
      headerPairs: 50,
    },
  });

  app.get("/cv", async (request): Promise<CvProfile | null> =>
    getActiveProfile(deps.prisma, request.log),
  );

  app.post("/cv", async (request, reply): Promise<CvProfile | CvUploadFailed> => {
    if (!request.isMultipart()) {
      throw new ApiError(400, "validation_failed", "Send the CV as multipart form data.", {
        file: "required",
      });
    }
    const part = await request.file();
    if (!part || part.fieldname !== "file") {
      throw new ApiError(400, "validation_failed", "Attach the CV in the file field.", {
        file: "required",
      });
    }
    const bytes = await part.toBuffer();
    const result = await storeCv(
      deps,
      { fileName: part.filename, mimeType: part.mimetype, bytes },
      request.log,
    );
    if (!result.ok) {
      return reply.code(202).send({ profileStatus: "failed", profile: null });
    }
    return reply.code(201).send(result.profile);
  });

  app.post("/cv/retry-profile", async (request): Promise<CvProfile> => {
    return retryProfile(deps, request.log);
  });
}
