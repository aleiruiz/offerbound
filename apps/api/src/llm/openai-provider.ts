import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  CvProfileSchema,
  ExtractionSchema,
  ParseReportResultSchema,
  RankingsSchema,
  SearchResultSchema,
  TriageResultSchema,
  clampExtraction,
  clampRanking,
  type CvProfile,
  type Extraction,
  type LlmPurpose,
  type Ranking,
  type ReportLead,
  type SearchResult,
  type TriageResult,
} from "@offerbound/contracts";
import { PROMPTS, userMessageFor } from "./prompts.js";
import {
  LlmError,
  type ExtractInput,
  type LlmCallCtx,
  type LlmConfig,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type RankInput,
  type SearchInput,
  type TriageInput,
} from "./provider.js";
import { recordLlmCall, type LlmCallDb, type WarnLogger } from "./record.js";

/** `max_tool_calls` is accepted by the API but missing from this SDK version's request type. */
export type OpenAiRequest = ResponseCreateParamsNonStreaming & { max_tool_calls?: number };

/** The part of a Responses API reply this adapter reads. The SDK's `Response` satisfies it. */
export type OpenAiResponse = {
  id: string;
  status?: string | null;
  output_text: string;
  output: { type: string }[];
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens: number } | null;
    output_tokens: number;
  } | null;
  error?: { code?: string | null; message?: string | null } | null;
};

/** Sends one Responses API request. Tests inject their own; production uses the SDK. */
export interface OpenAiTransport {
  create(body: OpenAiRequest, opts: { timeoutMs: number }): Promise<OpenAiResponse>;
}

/** The SDK client with `maxRetries: 0`: pg-boss owns retries (TECHNICAL_SPEC §8.3). */
export function createOpenAiTransport(opts: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}): OpenAiTransport {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    maxRetries: 0,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });
  return {
    create: (body, { timeoutMs }) =>
      client.responses.create(body, { timeout: timeoutMs, maxRetries: 0 }),
  };
}

/** Per-purpose request timeouts (TECHNICAL_SPEC §8.1); search is per round. */
export const TIMEOUT_MS: Record<LlmPurpose, number> = {
  triage: 30_000,
  extract: 45_000,
  rank: 60_000,
  cv_profile: 60_000,
  parse_report: 90_000,
  search: 300_000,
};

// Reasoning tokens count against the limit, so these leave room to think.
const MAX_OUTPUT_TOKENS: Record<LlmPurpose, number> = {
  triage: 8_000,
  extract: 8_000,
  rank: 16_000,
  cv_profile: 8_000,
  parse_report: 32_000,
  search: 48_000,
};

function emptyUsage(model: string, latencyMs: number): LlmUsage {
  return {
    model,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    webSearchCalls: 0,
    latencyMs,
    requestId: null,
  };
}

function usageFrom(model: string, response: OpenAiResponse, latencyMs: number): LlmUsage {
  return {
    model,
    inputTokens: response.usage?.input_tokens ?? 0,
    cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    webSearchCalls: response.output.filter((item) => item.type === "web_search_call").length,
    latencyMs,
    requestId: response.id,
  };
}

/** Maps what the SDK or the network threw to an LlmError. 429, 5xx and timeouts are retryable. */
function toLlmError(error: unknown, usage: LlmUsage): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError("timeout", "The model request timed out", {
      retryable: true,
      usage,
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIUserAbortError) {
    return new LlmError("timeout", "The model request was aborted", {
      retryable: true,
      usage,
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    const status = error.status;
    if (status === 429) {
      return new LlmError("rate_limited", "The model API rate limit was hit (429)", {
        retryable: true,
        usage: { ...usage, requestId: error.requestID ?? usage.requestId },
        cause: error,
      });
    }
    if (status === 408) {
      return new LlmError("timeout", "The model API timed out (408)", {
        retryable: true,
        usage,
        cause: error,
      });
    }
    if (status >= 500 || status === 409) {
      return new LlmError("upstream", `The model API failed (${status})`, {
        retryable: true,
        usage: { ...usage, requestId: error.requestID ?? usage.requestId },
        cause: error,
      });
    }
    return new LlmError("bad_request", `The model API rejected the request (${status})`, {
      retryable: false,
      usage: { ...usage, requestId: error.requestID ?? usage.requestId },
      cause: error,
    });
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new LlmError("timeout", "The model request timed out", {
      retryable: true,
      usage,
      cause: error,
    });
  }
  // Connection resets, DNS failures and the like.
  return new LlmError("upstream", "The model API could not be reached", {
    retryable: true,
    usage,
    cause: error,
  });
}

type Call<T> = {
  purpose: LlmPurpose;
  schemaName: string;
  schema: z.ZodType<T>;
  user: string;
  ctx: LlmCallCtx | undefined;
};

export class OpenAiProvider implements LlmProvider {
  private readonly transport: OpenAiTransport;

  constructor(
    private readonly config: LlmConfig,
    private readonly db: LlmCallDb,
    transport?: OpenAiTransport,
    private readonly log?: WarnLogger,
  ) {
    this.transport = transport ?? createOpenAiTransport({ apiKey: config.apiKey });
  }

  triage(batch: TriageInput[], ctx?: LlmCallCtx): Promise<LlmResult<TriageResult>> {
    return this.call({
      purpose: "triage",
      schemaName: "TriageResult",
      schema: TriageResultSchema,
      user: userMessageFor("triage", batch),
      ctx,
    });
  }

  async extract(input: ExtractInput, ctx?: LlmCallCtx): Promise<LlmResult<Extraction>> {
    const result = await this.call({
      purpose: "extract",
      schemaName: "Extraction",
      schema: ExtractionSchema,
      user: userMessageFor("extract", input),
      ctx,
    });
    return { ...result, output: clampExtraction(result.output) };
  }

  async rank(input: RankInput, ctx?: LlmCallCtx): Promise<LlmResult<{ rankings: Ranking[] }>> {
    const result = await this.call({
      purpose: "rank",
      schemaName: "Rankings",
      schema: RankingsSchema,
      user: userMessageFor("rank", input),
      ctx,
    });
    return { ...result, output: { rankings: result.output.rankings.map(clampRanking) } };
  }

  async search(input: SearchInput, ctx?: LlmCallCtx): Promise<LlmResult<SearchResult>> {
    const result = await this.call({
      purpose: "search",
      schemaName: "SearchResult",
      schema: SearchResultSchema,
      user: userMessageFor("search", input),
      ctx,
    });
    const leads = result.output.leads.map((lead) => ({ ...lead, ...clampRanking(lead) }));
    return { ...result, output: { ...result.output, leads } };
  }

  parseReport(text: string, ctx?: LlmCallCtx): Promise<LlmResult<{ leads: ReportLead[] }>> {
    return this.call({
      purpose: "parse_report",
      schemaName: "ParseReportResult",
      schema: ParseReportResultSchema,
      user: userMessageFor("parse_report", text),
      ctx,
    });
  }

  cvProfile(text: string, ctx?: LlmCallCtx): Promise<LlmResult<CvProfile>> {
    return this.call({
      purpose: "cv_profile",
      schemaName: "CvProfile",
      schema: CvProfileSchema,
      user: userMessageFor("cv_profile", text),
      ctx,
    });
  }

  private requestFor<T>(call: Call<T>, model: string): OpenAiRequest {
    const { purpose } = call;
    return {
      model,
      input: [
        { role: "system", content: PROMPTS[purpose].system },
        { role: "user", content: call.user },
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS[purpose],
      reasoning: { effort: this.config.efforts[purpose] },
      store: false,
      prompt_cache_key: `offerbound-${purpose}`,
      ...(purpose === "search"
        ? {
            tools: [{ type: "web_search" as const }],
            tool_choice: "required" as const,
            max_tool_calls: this.config.searchMaxToolCallsPerRound,
            include: ["web_search_call.action.sources" as const],
          }
        : {}),
      text: {
        format: {
          type: "json_schema",
          name: call.schemaName,
          strict: true,
          schema: z.toJSONSchema(call.schema),
        },
      },
    };
  }

  /** One model call: request, parse, validate and log. Every outcome writes one llm_call row. */
  private async call<T>(call: Call<T>): Promise<LlmResult<T>> {
    const { purpose, ctx } = call;
    const model = this.config.models[purpose];
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);

    let result: LlmResult<T> | undefined;
    let failure: LlmError | undefined;
    try {
      let response: OpenAiResponse;
      try {
        response = await this.transport.create(this.requestFor(call, model), {
          timeoutMs: TIMEOUT_MS[purpose],
        });
      } catch (error) {
        throw toLlmError(error, emptyUsage(model, elapsed()));
      }
      const usage = usageFrom(model, response, elapsed());
      result = { output: this.parse(call, response, usage), usage };
    } catch (error) {
      failure = error instanceof LlmError ? error : toLlmError(error, emptyUsage(model, elapsed()));
    }

    const usage = failure ? (failure.usage ?? emptyUsage(model, elapsed())) : result?.usage;
    if (usage === undefined) throw new Error("unreachable: no usage");
    try {
      await recordLlmCall(
        this.db,
        {
          purpose,
          usage,
          status: failure ? "error" : "ok",
          errorCode: failure?.code ?? null,
          ...(ctx?.messageId === undefined ? {} : { messageId: ctx.messageId }),
          ...(ctx?.searchRunId === undefined ? {} : { searchRunId: ctx.searchRunId }),
        },
        this.config,
        this.log,
      );
    } catch (logError) {
      // On the error path the caller needs the typed LlmError, not the logging failure.
      if (!failure) throw logError;
      this.log?.warn({ purpose }, "llm call could not be logged");
    }
    if (failure) throw failure;
    if (result === undefined) throw new Error("unreachable: no result");
    return result;
  }

  private parse<T>(call: Call<T>, response: OpenAiResponse, usage: LlmUsage): T {
    if (response.status === "incomplete") {
      throw new LlmError("incomplete", "The model stopped before finishing its answer", {
        retryable: false,
        usage,
      });
    }
    if (response.status === "failed" || response.status === "cancelled") {
      throw new LlmError("upstream", `The model response ${response.status}`, {
        retryable: true,
        usage,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(response.output_text);
    } catch {
      // The parse error would quote the output, so say nothing about its content.
      throw new LlmError("invalid_output", "Output was not valid JSON", {
        retryable: false,
        usage,
      });
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) {
      throw new LlmError("invalid_output", `Output failed validation: ${parsed.error.message}`, {
        retryable: false,
        usage,
      });
    }
    return parsed.data;
  }
}
