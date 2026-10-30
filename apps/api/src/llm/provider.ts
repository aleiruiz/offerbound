import type {
  CvProfile,
  Extraction,
  IcsEvent,
  LlmPurpose,
  ParsedHeaders,
  Ranking,
  ReportLead,
  Seniority,
  SearchResult,
  Track,
  TriageResult,
  WorkMode,
} from "@offerbound/contracts";
import type { LlmCostConfig } from "./pricing.js";

export type LlmCallCtx = { messageId?: string; searchRunId?: string };

export type LlmUsage = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  latencyMs: number;
  requestId: string | null;
};

export type LlmResult<T> = { output: T; usage: LlmUsage };

export type LlmErrorCode =
  "timeout" | "rate_limited" | "upstream" | "invalid_output" | "bad_request" | "incomplete";

/**
 * A failed model call. `retryable` tells pg-boss whether trying again can help (429, 5xx and
 * timeouts); `usage` holds whatever the call consumed, so the cost log is complete even on error.
 * The message never contains prompt text or model output (SECURITY §4).
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  readonly usage: LlmUsage | null;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { retryable: boolean; usage?: LlmUsage | null; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmError";
    this.code = code;
    this.retryable = options.retryable;
    this.usage = options.usage ?? null;
  }
}

// --- Inputs (TECHNICAL_SPEC §5.4, §5.5, §7.3, §7.4; SECURITY §3) ---

export type TriageInput = {
  id: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  preview: string;
};

export type ExtractInput = {
  messageId: string;
  headers: ParsedHeaders;
  date: string;
  ownerTimezone: string;
  direction: "inbound" | "outbound";
  icsEvents: IcsEvent[];
  body: string;
  previousError: string | null;
};

export type RankInput = {
  brief: string;
  cvProfile: CvProfile | null;
  tracks: Track[];
  homeCountry: string;
  leads: {
    leadRef: string;
    company: string;
    title: string;
    locationText: string | null;
    workMode: WorkMode;
    compensationText: string | null;
    pageExcerpt: string | null;
  }[];
};

export type SearchInput = {
  today: string;
  homeCountry: string;
  brief: string;
  cvProfile: CvProfile | null;
  tracks: Track[];
  excludedSeniorities: Seniority[];
  exclusions: { names: string[] }[];
  wanted: number;
  round: number;
};

export interface LlmProvider {
  triage(batch: TriageInput[], ctx?: LlmCallCtx): Promise<LlmResult<TriageResult>>;
  extract(input: ExtractInput, ctx?: LlmCallCtx): Promise<LlmResult<Extraction>>;
  rank(input: RankInput, ctx?: LlmCallCtx): Promise<LlmResult<{ rankings: Ranking[] }>>;
  search(input: SearchInput, ctx?: LlmCallCtx): Promise<LlmResult<SearchResult>>;
  parseReport(text: string, ctx?: LlmCallCtx): Promise<LlmResult<{ leads: ReportLead[] }>>;
  cvProfile(text: string, ctx?: LlmCallCtx): Promise<LlmResult<CvProfile>>;
}

/** Reasoning effort as the OpenAI API names it. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Everything the LLM layer needs from configuration. Stream A builds it from `Env`:
 * `OPENAI_API_KEY`, `OPENAI_MODEL_*`, `OPENAI_REASONING_EFFORT_*`, `AI_PRICING`,
 * `AI_WEB_SEARCH_COST_PER_CALL_MICROS` and `SEARCH_MAX_TOOL_CALLS_PER_ROUND`. Report parsing has no
 * variable of its own: give `parse_report` the extraction model and effort.
 */
export type LlmConfig = LlmCostConfig & {
  apiKey: string;
  models: Record<LlmPurpose, string>;
  efforts: Record<LlmPurpose, ReasoningEffort>;
  searchMaxToolCallsPerRound: number;
};
