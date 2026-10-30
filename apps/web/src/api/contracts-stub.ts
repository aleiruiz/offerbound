/**
 * TEMPORARY STUB for `@offerbound/contracts` (T0.3, stream B), which is not merged yet.
 *
 * Everything the web app needs from the contracts package is imported from this one file.
 * When T0.3 merges, delete this file and change the imports to `@offerbound/contracts`
 * (names are the same: `ApiErrorBodySchema`, `MeSchema`, `ApplicationStatusSchema`).
 *
 * Shapes: TECHNICAL_SPEC §10 (error envelope) and §10.2 (`Me`); DATA_MODEL §2 (`application_status`).
 */
import { z } from "zod";

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ApplicationStatusSchema = z.enum([
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "abandoned",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const MeSchema = z.object({
  mode: z.enum(["private", "demo"]),
  email: z.string().nullable(),
  onboardingCompleted: z.boolean(),
  timezone: z.string(),
});
export type Me = z.infer<typeof MeSchema>;
