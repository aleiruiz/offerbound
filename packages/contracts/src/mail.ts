import { z } from "zod";

// Shared by stream A (Gmail parsing) and stream B (LLM inputs) so neither depends on the other's code.

export const ParsedHeadersSchema = z.object({
  from: z.string().nullable(),
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string().nullable(),
  date: z.string().nullable(),
  listId: z.string().nullable(),
});
export type ParsedHeaders = z.infer<typeof ParsedHeadersSchema>;

/** One VEVENT. `start` and `end` are ISO 8601 in UTC. */
export const IcsEventSchema = z.object({
  uid: z.string().nullable(),
  method: z.enum(["REQUEST", "CANCEL"]).nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  timezone: z.string().nullable(),
  summary: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string().nullable(),
  descriptionLink: z.string().nullable(),
  organizer: z.string().nullable(),
});
export type IcsEvent = z.infer<typeof IcsEventSchema>;

export const MessageMetadataSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: z.date(),
  labelIds: z.array(z.string()),
  snippet: z.string(),
  headers: ParsedHeadersSchema,
});
export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

export const ParsedMessageSchema = z.object({
  headers: ParsedHeadersSchema,
  textBody: z.string(),
  icsEvents: z.array(IcsEventSchema),
});
export type ParsedMessage = z.infer<typeof ParsedMessageSchema>;
