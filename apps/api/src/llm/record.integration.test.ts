import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { FakeLlmProvider } from "./fake-provider.js";
import { OpenAiProvider, type OpenAiResponse, type OpenAiTransport } from "./openai-provider.js";
import { LlmError, type LlmUsage } from "./provider.js";
import { recordLlmCall } from "./record.js";
import { TEST_LLM_CONFIG } from "./test-support.js";

const prisma: PrismaClient = testPrisma();

beforeEach(async () => {
  await resetDb(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const usage = (over: Partial<LlmUsage> = {}): LlmUsage => ({
  model: "model-extract",
  inputTokens: 1_000_000,
  cachedInputTokens: 200_000,
  outputTokens: 100_000,
  webSearchCalls: 2,
  latencyMs: 321,
  requestId: "resp_abc",
  ...over,
});

const okResponse = (payload: unknown): OpenAiResponse => ({
  id: "resp_ok",
  status: "completed",
  output_text: JSON.stringify(payload),
  output: [],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 10 },
});

describe("recordLlmCall", () => {
  it("writes tokens, latency, status and computed cost", async () => {
    await recordLlmCall(
      prisma,
      { purpose: "search", usage: usage(), status: "ok", errorCode: null },
      TEST_LLM_CONFIG,
    );
    const rows = await prisma.llmCall.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "search",
      model: "model-extract",
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
      webSearchCalls: 2,
      latencyMs: 321,
      status: "ok",
      errorCode: null,
      requestId: "resp_abc",
      costMicros: 2_045_000n,
    });
  });

  it("stores a null cost for an unpriced model, warns, and links message and search run", async () => {
    const message = await prisma.gmailMessage.create({
      data: {
        id: "msg-1",
        threadId: "thr-1",
        internalDate: new Date("2026-10-05T12:00:00.000Z"),
        direction: "inbound",
        labelIds: ["INBOX"],
      },
    });
    const warnings: unknown[] = [];
    await recordLlmCall(
      prisma,
      {
        purpose: "extract",
        usage: usage({ model: "unlisted" }),
        status: "error",
        errorCode: "timeout",
        messageId: message.id,
      },
      TEST_LLM_CONFIG,
      { warn: (fields) => warnings.push(fields) },
    );
    const row = await prisma.llmCall.findFirstOrThrow();
    expect(row).toMatchObject({
      costMicros: null,
      status: "error",
      errorCode: "timeout",
      messageId: "msg-1",
    });
    expect(warnings).toEqual([{ model: "unlisted" }]);
  });
});

describe("OpenAiProvider cost log", () => {
  it("every call, ok or error, writes one llm_call row with tokens, latency, status and cost", async () => {
    let next: OpenAiResponse | Error = okResponse({ results: [] });
    const transport: OpenAiTransport = {
      create: () => (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)),
    };
    const provider = new OpenAiProvider(TEST_LLM_CONFIG, prisma, transport);

    await provider.triage([]);
    next = okResponse({ nonsense: true });
    await expect(provider.extract(extractInput())).rejects.toBeInstanceOf(LlmError);
    next = new Error("socket closed");
    await expect(provider.extract(extractInput())).rejects.toMatchObject({ code: "upstream" });

    const rows = await prisma.llmCall.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.purpose, r.status, r.errorCode])).toEqual([
      ["triage", "ok", null],
      ["extract", "error", "invalid_output"],
      ["extract", "error", "upstream"],
    ]);
    expect(rows[0]).toMatchObject({
      model: "model-triage",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      requestId: "resp_ok",
      costMicros: null, // model-triage is not in the pricing table
    });
    expect(rows[1]).toMatchObject({ model: "model-extract", inputTokens: 100, outputTokens: 10 });
    expect(rows[1]?.costMicros).toBe(BigInt(Math.round(60 * 1.25 + 40 * 0.125 + 10 * 10)));
    expect(rows[2]).toMatchObject({ inputTokens: 0, outputTokens: 0, costMicros: 0n });
    for (const r of rows) expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the message and search run ids from the call context", async () => {
    await prisma.gmailMessage.create({
      data: {
        id: "msg-2",
        threadId: "thr-2",
        internalDate: new Date("2026-10-05T12:00:00.000Z"),
        direction: "inbound",
        labelIds: [],
      },
    });
    const transport: OpenAiTransport = {
      create: () => Promise.resolve(okResponse({ leads: [] })),
    };
    const provider = new OpenAiProvider(TEST_LLM_CONFIG, prisma, transport);
    await provider.parseReport("report", { messageId: "msg-2" });
    expect((await prisma.llmCall.findFirstOrThrow()).messageId).toBe("msg-2");
  });
});

describe("FakeLlmProvider with a database", () => {
  it("logs each call as an llm_call row with model 'fake' and zero cost", async () => {
    const fake = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [], db: prisma });
    await fake.cvProfile("cv");
    await fake.triage([{ id: "x", fromName: null, fromEmail: null, subject: null, preview: "" }]);
    const rows = await prisma.llmCall.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.purpose, r.model, r.status, r.costMicros])).toEqual([
      ["cv_profile", "fake", "ok", 0n],
      ["triage", "fake", "ok", 0n],
    ]);
  });
});

function extractInput() {
  return {
    messageId: "m",
    headers: {
      from: null,
      fromName: null,
      fromEmail: null,
      to: [],
      cc: [],
      subject: null,
      date: null,
      listId: null,
    },
    date: "2026-10-05T12:00:00.000Z",
    ownerTimezone: "America/Monterrey",
    direction: "inbound" as const,
    icsEvents: [],
    body: "",
    previousError: null,
  };
}
