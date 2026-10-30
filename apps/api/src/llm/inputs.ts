import { createHash } from "node:crypto";
import type { LlmPurpose, MessageMetadata, ParsedMessage } from "@offerbound/contracts";
import type { ExtractInput, TriageInput } from "./provider.js";

/** Largest body sent for extraction (TECHNICAL_SPEC §5.5). */
export const EXTRACT_BODY_MAX_CHARS = 15_000;
/** Longest Gmail preview sent for triage (AC-3.4). */
export const TRIAGE_PREVIEW_MAX_CHARS = 300;

/**
 * What triage may see of a message: sender, subject and the first 300 characters of Gmail's
 * preview, and nothing else (AC-3.4, SECURITY §3).
 */
export function toTriageInput(meta: MessageMetadata): TriageInput {
  return {
    id: meta.id,
    fromName: meta.headers.fromName,
    fromEmail: meta.headers.fromEmail,
    subject: meta.headers.subject,
    preview: meta.snippet.slice(0, TRIAGE_PREVIEW_MAX_CHARS),
  };
}

/** `body` is the de-quoted text; it is capped here again so no caller can exceed 15,000 characters. */
export function toExtractInput(
  meta: MessageMetadata,
  parsed: ParsedMessage,
  body: string,
  tz: string,
): ExtractInput {
  return {
    messageId: meta.id,
    headers: parsed.headers,
    date: meta.headers.date ?? meta.internalDate.toISOString(),
    ownerTimezone: tz,
    direction: meta.labelIds.includes("SENT") ? "outbound" : "inbound",
    icsEvents: parsed.icsEvents,
    body: body.slice(0, EXTRACT_BODY_MAX_CHARS),
    previousError: null,
  };
}

/** JSON with object keys sorted, dates as ISO strings and undefined members dropped. */
function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 (hex) of the purpose and the stable-sorted JSON of `input`. */
export function inputKey(purpose: LlmPurpose, input: unknown): string {
  return createHash("sha256")
    .update(`${purpose}\n${stableJson(input)}`)
    .digest("hex");
}
