import { z } from "zod";

// TECHNICAL_SPEC §10: the only error codes the API returns.
export const API_ERROR_STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  not_owner: 403,
  csrf_header_missing: 403,
  demo_read_only: 403,
  not_found: 404,
  version_conflict: 409,
  changed_since: 409,
  already_running: 409,
  duplicate_import: 409,
  not_connected: 409,
  too_large: 413,
  cv_no_text: 422,
  unsupported_file: 422,
  rate_limited: 429,
  upstream_error: 502,
  not_ready: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export const ApiErrorCodeSchema = z.enum(
  Object.keys(API_ERROR_STATUS) as [ApiErrorCode, ...ApiErrorCode[]],
);

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
