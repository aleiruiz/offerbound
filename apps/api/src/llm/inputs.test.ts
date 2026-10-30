import { describe, expect, it } from "vitest";
import type { MessageMetadata, ParsedMessage } from "@offerbound/contracts";
import { inputKey, toExtractInput, toTriageInput } from "./inputs.js";

const meta = (over: Partial<MessageMetadata> = {}): MessageMetadata => ({
  id: "m-1",
  threadId: "t-1",
  internalDate: new Date("2026-10-05T12:00:00.000Z"),
  labelIds: ["INBOX"],
  snippet: "x".repeat(450),
  headers: {
    from: "Ana Ruiz <ana@acme.example>",
    fromName: "Ana Ruiz",
    fromEmail: "ana@acme.example",
    to: ["me@owner.example"],
    cc: [],
    subject: "Your application",
    date: "Mon, 5 Oct 2026 07:00:00 -0500",
    listId: null,
  },
  ...over,
});

describe("toTriageInput", () => {
  it("has exactly id, fromName, fromEmail, subject and preview, with preview ≤ 300 chars", () => {
    const input = toTriageInput(meta());
    expect(Object.keys(input).sort()).toEqual([
      "fromEmail",
      "fromName",
      "id",
      "preview",
      "subject",
    ]);
    expect(input.preview).toHaveLength(300);
    expect(input).toMatchObject({
      id: "m-1",
      fromName: "Ana Ruiz",
      fromEmail: "ana@acme.example",
      subject: "Your application",
    });
  });
});

describe("toExtractInput", () => {
  const parsed: ParsedMessage = {
    headers: meta().headers,
    textBody: "ignored: the caller passes the de-quoted body",
    icsEvents: [],
  };

  it("builds the extraction input from metadata, parsed message and body", () => {
    const input = toExtractInput(meta(), parsed, "Hello", "America/Monterrey");
    expect(input).toEqual({
      messageId: "m-1",
      headers: parsed.headers,
      date: "Mon, 5 Oct 2026 07:00:00 -0500",
      ownerTimezone: "America/Monterrey",
      direction: "inbound",
      icsEvents: [],
      body: "Hello",
      previousError: null,
    });
  });

  it("is outbound for SENT mail, falls back to internalDate, and caps the body at 15,000 chars", () => {
    const m = meta({ labelIds: ["SENT"], headers: { ...meta().headers, date: null } });
    const input = toExtractInput(m, parsed, "y".repeat(20_000), "America/Monterrey");
    expect(input.direction).toBe("outbound");
    expect(input.date).toBe("2026-10-05T12:00:00.000Z");
    expect(input.body).toHaveLength(15_000);
  });
});

describe("inputKey", () => {
  it("is stable under key order and differs by purpose", () => {
    expect(inputKey("rank", { a: 1, b: [{ y: 2, x: 1 }] })).toBe(
      inputKey("rank", { b: [{ x: 1, y: 2 }], a: 1 }),
    );
    expect(inputKey("rank", { a: 1 })).not.toBe(inputKey("search", { a: 1 }));
    expect(inputKey("rank", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats dates as ISO strings and ignores undefined keys", () => {
    const d = new Date("2026-10-05T12:00:00.000Z");
    expect(inputKey("rank", { d, u: undefined })).toBe(inputKey("rank", { d: d.toISOString() }));
  });
});
