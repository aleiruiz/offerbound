import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_ERROR_STATUS, type ApiErrorBody, type ApiErrorCode } from "@offerbound/contracts";

/**
 * An error that maps to the API error envelope (TECHNICAL_SPEC §10). Throw it from a handler; the
 * error handler sends `{ error: { code, message, fields? } }` with `status`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(
  code: ApiErrorCode,
  message: string,
  fields?: Record<string, string>,
): ApiErrorBody {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}

type ZodIssueLike = { path: readonly PropertyKey[]; message: string };

/** Duck-typed so it also matches a ZodError created by another copy of zod. */
function zodIssues(error: unknown): ZodIssueLike[] | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== "ZodError" || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as ZodIssueLike[];
}

/** `fields` keyed by dotted path; the first message for a path wins; a root issue is keyed "_". */
function zodFields(issues: ZodIssueLike[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map((part) => String(part)).join(".") || "_";
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Maps Fastify's own 4xx errors (bad JSON, body too large, ...) onto the §10 codes. */
function fromFastifyError(error: FastifyError): ApiError | null {
  const status = error.statusCode;
  if (status === undefined || status < 400 || status > 499) return null;
  switch (status) {
    case 404:
      return new ApiError(404, "not_found", "Not found.");
    case 413:
      return new ApiError(413, "too_large", "The request is too large.");
    case 429:
      return new ApiError(429, "rate_limited", "Too many requests.");
    default:
      // Fastify messages can quote request content, so a fixed message is sent instead.
      return new ApiError(
        API_ERROR_STATUS.validation_failed,
        "validation_failed",
        error.code === "FST_ERR_CTP_INVALID_JSON"
          ? "The request body is not valid JSON."
          : "The request could not be processed.",
      );
  }
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(API_ERROR_STATUS.not_found).send(errorBody("not_found", "No such route."));
}

/**
 * Installs the error handler. The not-found handler is installed by `buildApp` so it can be
 * rate limited. Messages sent to the client and written
 * to the log never include request content (SECURITY §4): unexpected errors are logged by name
 * and code only.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send(errorBody(error.code, error.message, error.fields));
    }

    const issues = zodIssues(error);
    if (issues) {
      return reply
        .code(API_ERROR_STATUS.validation_failed)
        .send(errorBody("validation_failed", "The request is invalid.", zodFields(issues)));
    }

    const mapped = isFastifyError(error) ? fromFastifyError(error) : null;
    if (mapped) {
      return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
    }

    const { name, code } = error as { name?: string; code?: unknown };
    request.log.error(
      { errorName: name, errorCode: typeof code === "string" ? code : undefined },
      "unhandled error",
    );
    return reply
      .code(API_ERROR_STATUS.internal_error)
      .send(errorBody("internal_error", "Something went wrong."));
  });
}

function isFastifyError(error: unknown): error is FastifyError {
  return typeof error === "object" && error !== null && "statusCode" in error;
}
