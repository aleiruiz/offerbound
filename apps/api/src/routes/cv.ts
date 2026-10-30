import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { CvProfile, CvUploadFailed } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { requireSession } from "../http/session-guard.js";
import { getActiveProfile, MAX_CV_BYTES, retryProfile, storeCv } from "../leads/cv.js";

/**
 * CV routes (TECHNICAL_SPEC §7.5, §10.1). Register inside the guarded scope.
 *
 * `POST /cv` authenticates in `preParsing`, before any of the body is read: the multipart plugin
 * would otherwise buffer an unauthenticated upload up to the size cap. The size cap is enforced
 * while the file streams in; the file is held in memory and never written to disk (AC-11.3).
 */
export async function registerCvRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(multipart, {
    // Busboy stops reading a file past the cap and the stream errors with a 413.
    limits: { fileSize: MAX_CV_BYTES, files: 1, fields: 5, parts: 6, headerPairs: 50 },
  });

  const guard = requireSession(deps);

  app.get("/cv", async (): Promise<CvProfile | null> => getActiveProfile(deps.prisma));

  app.post(
    "/cv",
    {
      preParsing: async (request, reply) => {
        await guard.call(app, request, reply);
      },
    },
    async (request, reply): Promise<CvProfile | CvUploadFailed> => {
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
    },
  );

  app.post("/cv/retry-profile", async (request): Promise<CvProfile> => {
    return retryProfile(deps, request.log);
  });
}
