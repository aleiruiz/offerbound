import { z } from "zod";
import { EmailCategorySchema, ReviewKindSchema } from "./enums.js";
import { ExtractionSchema, TriageItemSchema } from "./llm.js";

// TECHNICAL_SPEC §15 fixture shape. Shared by FakeGmailClient, FakeLlmProvider, the eval script and the demo.

export const EmailFixtureSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: z.string(),
  labels: z.array(z.string()),
  headers: z.object({
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    subject: z.string(),
    date: z.string(),
    listId: z.string().optional(),
  }),
  snippet: z.string(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  ics: z.string().optional(),
  demo: z.boolean(),
  expected: z.object({
    triage: z.enum(["skipped", "triaged_out", "job_related"]),
    category: EmailCategorySchema.nullable(),
    company: z.string().nullable(),
    role: z.string().nullable(),
    jobKey: z.string().optional(),
    outcome: z.enum(["applied", "needs_review", "triaged_out", "skipped"]),
    reviewKind: ReviewKindSchema.optional(),
    interviewStart: z.string().optional(),
    leads: z.number().int().min(0).optional(),
  }),
  llm: z.object({
    triage: TriageItemSchema.nullable(),
    extraction: ExtractionSchema.nullable(),
  }),
});
export type EmailFixture = z.infer<typeof EmailFixtureSchema>;
