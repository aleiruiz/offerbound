import type {
  CvProfile,
  EmailFixture,
  Extraction,
  LlmPurpose,
  Ranking,
  ReportLead,
  SearchResult,
  TriageItem,
  TriageResult,
} from "@offerbound/contracts";
import { inputKey } from "./inputs.js";
import type { LlmCostConfig } from "./pricing.js";
import {
  type LlmError,
  type ExtractInput,
  type LlmCallCtx,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type RankInput,
  type SearchInput,
  type TriageInput,
} from "./provider.js";
import { recordLlmCall, type LlmCallDb } from "./record.js";

const FAKE_MODEL = "fake";
const FAKE_COST: LlmCostConfig = {
  pricing: {
    [FAKE_MODEL]: {
      inputPerMTokMicros: 0,
      cachedInputPerMTokMicros: 0,
      outputPerMTokMicros: 0,
    },
  },
  webSearchCostPerCallMicros: 0,
};

const FAKE_USAGE: LlmUsage = {
  model: FAKE_MODEL,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  webSearchCalls: 0,
  latencyMs: 0,
  requestId: null,
};

const clone = <T>(value: T): T => structuredClone(value);

const EMPTY_CV_PROFILE: CvProfile = {
  headline: "Fixture profile",
  yearsExperience: null,
  coreSkills: [],
  secondarySkills: [],
  domains: [],
  recentRoles: [],
  leadership: null,
  languages: [],
  location: null,
  workAuthorization: null,
};

const FALLBACK_EXTRACTION: Extraction = {
  category: "status_update_other",
  confidence: 0.5,
  company: null,
  role: null,
  jobUrl: null,
  contact: null,
  interview: null,
  assessment: null,
  leads: [],
  summary: "Unrecognised message",
  language: "en",
};

const NOT_JOB_RELATED: Extraction = {
  ...FALLBACK_EXTRACTION,
  category: "not_job_related",
  confidence: 0.9,
  summary: "Not related to the job search",
};

/** Deterministic score 50..90 from the lead reference. */
function scoreFor(leadRef: string): number {
  return 50 + (parseInt(inputKey("rank", leadRef).slice(0, 8), 16) % 41);
}

function rankLead(input: RankInput, lead: RankInput["leads"][number]): Ranking {
  return {
    leadRef: lead.leadRef,
    track: input.tracks[0]?.key ?? null,
    fitScore: scoreFor(lead.leadRef),
    fitReason: `Fixture ranking for ${lead.title}`,
    gaps: [],
    seniority: "senior",
    workMode: lead.workMode,
    remoteFromHomeCountry: lead.workMode === "remote" ? "yes" : "unknown",
    sponsorship: "unknown",
    relocation: "unknown",
    compensation: {
      min: null,
      max: null,
      currency: null,
      period: null,
      isEstimate: false,
      basis: null,
    },
    eligible: "yes",
    eligibilityReason: null,
  };
}

/**
 * The provider every test and the demo use; nothing here reaches the network.
 *
 * - Triage and extraction are keyed by message id (`inputKey(purpose, { messageId })`) from the
 *   email fixtures, so they do not depend on how the parser renders a message.
 * - Search hands out the lead batches in order and starts over after the last one, so the demo's
 *   *Run search now* never runs dry; with no batches it answers `{ leads: [], notes: "no more" }`.
 * - Rank, report parsing and CV profiling answer from outputs registered with {@link register}
 *   (keyed by the hash of the whole normalised input), else with a deterministic default.
 * - With a `db`, every call is also logged to `llm_call` (model `fake`, cost 0), like the real one.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly calls: { purpose: LlmPurpose; input: unknown }[] = [];

  private readonly triageByKey = new Map<string, TriageItem>();
  private readonly extractionByKey = new Map<string, Extraction | null>();
  private readonly registered = new Map<string, unknown>();
  private readonly failures = new Map<LlmPurpose, LlmError[]>();
  private nextBatch = 0;

  private constructor(
    private readonly leadBatches: SearchResult[],
    private readonly db: LlmCallDb | undefined,
  ) {}

  static fromFixtures(p: {
    emails: EmailFixture[];
    leadBatches: SearchResult[];
    db?: LlmCallDb;
  }): FakeLlmProvider {
    const fake = new FakeLlmProvider(p.leadBatches, p.db);
    for (const email of p.emails) {
      if (email.llm.triage !== null) {
        fake.triageByKey.set(inputKey("triage", { messageId: email.id }), email.llm.triage);
      }
      fake.extractionByKey.set(inputKey("extract", { messageId: email.id }), email.llm.extraction);
    }
    return fake;
  }

  /**
   * Makes `purpose` answer `output` for exactly this input. Triage and extract are keyed by message
   * id: pass `{ messageId }`; a triage output is that message's `TriageItem`.
   */
  register(purpose: LlmPurpose, input: unknown, output: unknown): void {
    this.registered.set(this.keyFor(purpose, input), clone(output));
  }

  /** Makes the next call of `purpose` fail with `error`; later calls succeed again. */
  failNext(purpose: LlmPurpose, error: LlmError): void {
    this.failures.set(purpose, [...(this.failures.get(purpose) ?? []), error]);
  }

  triage(batch: TriageInput[], ctx?: LlmCallCtx): Promise<LlmResult<TriageResult>> {
    return this.run("triage", batch, ctx, () => ({
      results: batch.map((item): TriageItem => {
        const key = inputKey("triage", { messageId: item.id });
        const registered = this.registered.get(key) as TriageItem | undefined;
        return clone(
          registered ??
            this.triageByKey.get(key) ?? { id: item.id, jobRelated: false, confidence: 0.9 },
        );
      }),
    }));
  }

  extract(input: ExtractInput, ctx?: LlmCallCtx): Promise<LlmResult<Extraction>> {
    return this.run("extract", input, ctx, () => {
      const key = inputKey("extract", { messageId: input.messageId });
      const registered = this.registered.get(key);
      if (registered !== undefined) return clone(registered as Extraction);
      const known = this.extractionByKey.get(key);
      if (known === undefined) return clone(FALLBACK_EXTRACTION);
      // A fixture without an extraction is one that never reaches extraction: not job-related.
      return clone(known ?? NOT_JOB_RELATED);
    });
  }

  rank(input: RankInput, ctx?: LlmCallCtx): Promise<LlmResult<{ rankings: Ranking[] }>> {
    return this.run("rank", input, ctx, () => {
      const registered = this.registered.get(inputKey("rank", input));
      if (registered !== undefined) return clone(registered as { rankings: Ranking[] });
      return { rankings: input.leads.map((lead) => rankLead(input, lead)) };
    });
  }

  search(input: SearchInput, ctx?: LlmCallCtx): Promise<LlmResult<SearchResult>> {
    return this.run("search", input, ctx, () => {
      const registered = this.registered.get(inputKey("search", input));
      if (registered !== undefined) return clone(registered as SearchResult);
      if (this.leadBatches.length === 0) return { leads: [], notes: "no more" };
      const batch = this.leadBatches[this.nextBatch % this.leadBatches.length];
      this.nextBatch += 1;
      return batch === undefined ? { leads: [], notes: "no more" } : clone(batch);
    });
  }

  parseReport(text: string, ctx?: LlmCallCtx): Promise<LlmResult<{ leads: ReportLead[] }>> {
    return this.run("parse_report", text, ctx, () => {
      const registered = this.registered.get(inputKey("parse_report", text));
      return registered === undefined
        ? { leads: [] }
        : clone(registered as { leads: ReportLead[] });
    });
  }

  cvProfile(text: string, ctx?: LlmCallCtx): Promise<LlmResult<CvProfile>> {
    return this.run("cv_profile", text, ctx, () => {
      const registered = this.registered.get(inputKey("cv_profile", text));
      return clone((registered as CvProfile | undefined) ?? EMPTY_CV_PROFILE);
    });
  }

  private keyFor(purpose: LlmPurpose, input: unknown): string {
    if (
      (purpose === "extract" || purpose === "triage") &&
      typeof input === "object" &&
      input !== null
    ) {
      const { messageId } = input as { messageId?: unknown };
      if (typeof messageId === "string") return inputKey(purpose, { messageId });
    }
    return inputKey(purpose, input);
  }

  private async run<T>(
    purpose: LlmPurpose,
    input: unknown,
    ctx: LlmCallCtx | undefined,
    produce: () => T,
  ): Promise<LlmResult<T>> {
    this.calls.push({ purpose, input: clone(input) });
    const failure = this.failures.get(purpose)?.shift();
    const usage = failure?.usage ?? FAKE_USAGE;
    if (this.db !== undefined) {
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
        FAKE_COST,
      );
    }
    if (failure) throw failure;
    return { output: produce(), usage: { ...FAKE_USAGE } };
  }
}
