import type { EmailFixture, MessageMetadata } from "@offerbound/contracts";
import { triageByRules, type TriageLookups } from "@offerbound/domain";
import { stripQuotedHistory } from "../gmail/dequote.js";
import { toGmailMessage } from "../gmail/fake-client.js";
import { parseFullMessage } from "../gmail/mime.js";
import type { EvalCase } from "./eval.js";
import { toExtractInput, toTriageInput } from "./inputs.js";
import type { LlmProvider, LlmUsage } from "./provider.js";

/** Triage batch size (TECHNICAL_SPEC §5.4). Mirrors the pipeline; share it once that is merged. */
export const TRIAGE_BATCH_SIZE = 25;
/** Triage proceeds to extraction unless it says "not job-related" with at least this confidence. */
export const TRIAGE_PROCEED_BELOW = 0.7;

export type EvalRun = {
  cases: EvalCase[];
  /** Usage of every successful call, for the cost line. */
  usages: LlmUsage[];
  /** Fixture ids whose triage or extraction call failed. They count as misses in the scores. */
  failedIds: string[];
  /** How the deterministic rules treated the messages, before any model call. */
  rules: {
    /** R1 (SPAM, TRASH, DRAFT, CHAT, or labelled skipped): left out of the scores. */
    skipped: number;
    /** R3 (outgoing, not job-related) and R8 (Promotions, Forums): dropped, never sent to a model. */
    dropped: number;
    /** R3, outgoing mail labelled job-related (stands for "already linked"): extracted, not triaged. */
    outgoingKept: number;
    /** Everything else: sent to model triage. */
    triaged: number;
  };
};

const NO_LOOKUPS: TriageLookups = {
  linkedThreadIds: new Set(),
  contactEmails: new Set(),
  companyDomains: new Set(),
  ignoreList: [],
};

type RuleOutcome = "skipped" | "dropped" | "outgoing_kept" | "triage";

/**
 * The stateless label rules of TECHNICAL_SPEC §5.3, by `triageByRules` itself: R1 (skip labels),
 * R3 (outgoing mail never reaches the model unless linked) and R8 (Promotions and Forums never
 * reach it). The sender is withheld so the sender rules (R4 to R7) cannot fire before R8, and the
 * lookups are empty, so nothing is "linked" or "known". A fixture labelled job-related that is
 * outgoing stands for an outgoing message in a linked thread.
 */
function labelRules(fixture: EmailFixture, meta: MessageMetadata): RuleOutcome {
  if (fixture.expected.triage === "skipped") return "skipped";
  const { decision, rule } = triageByRules(
    {
      labelIds: meta.labelIds,
      internalDate: meta.internalDate,
      backfillSince: new Date(0),
      threadId: meta.threadId,
      from: null,
      to: [],
      cc: [],
      ownerEmail: null,
    },
    NO_LOOKUPS,
  );
  if (decision === "skipped") return "skipped";
  if (rule === "R3") return fixture.expected.triage === "job_related" ? "outgoing_kept" : "dropped";
  if (decision === "triaged_out") return "dropped";
  return "triage";
}

/**
 * Runs the pipeline's two model steps over `fixtures` with `llm`. The label rules run first
 * (SECURITY §3), so a message they decide is never sent to the provider. Then triage runs in
 * batches of 25 for the rest, and extraction for each message triage lets through. It uses the
 * pipeline's input builders (`toTriageInput`, `toExtractInput`), not the sender and thread rules
 * (R2, R4 to R7): those need mailbox state, so the model also sees messages they would decide.
 */
export async function runEvalCases(
  llm: LlmProvider,
  fixtures: EmailFixture[],
  opts: { ownerTimezone: string; concurrency?: number },
): Promise<EvalRun> {
  const usages: LlmUsage[] = [];
  const failed = new Set<string>();
  const rules: EvalRun["rules"] = { skipped: 0, dropped: 0, outgoingKept: 0, triaged: 0 };

  const prepared = fixtures.map((fixture) => {
    const parsed = parseFullMessage(toGmailMessage(fixture));
    const meta: MessageMetadata = {
      id: fixture.id,
      threadId: fixture.threadId,
      internalDate: new Date(fixture.internalDate),
      labelIds: fixture.labels,
      snippet: fixture.snippet,
      headers: parsed.headers,
    };
    return { fixture, meta, parsed, rule: labelRules(fixture, meta) };
  });
  const scored = prepared.filter((p) => p.rule !== "skipped");
  rules.skipped = prepared.length - scored.length;
  rules.dropped = scored.filter((p) => p.rule === "dropped").length;
  rules.outgoingKept = scored.filter((p) => p.rule === "outgoing_kept").length;
  const toTriage = scored.filter((p) => p.rule === "triage");
  rules.triaged = toTriage.length;

  // Step 1: model triage. A message the model leaves out, or a failed batch, counts as dropped.
  const proceeds = new Map<string, boolean>();
  for (const p of scored) if (p.rule === "outgoing_kept") proceeds.set(p.fixture.id, true);
  for (let i = 0; i < toTriage.length; i += TRIAGE_BATCH_SIZE) {
    const batch = toTriage.slice(i, i + TRIAGE_BATCH_SIZE);
    try {
      const { output, usage } = await llm.triage(batch.map((p) => toTriageInput(p.meta)));
      usages.push(usage);
      for (const item of output.results) {
        proceeds.set(item.id, item.jobRelated || item.confidence < TRIAGE_PROCEED_BELOW);
      }
    } catch {
      for (const p of batch) failed.add(p.fixture.id);
    }
  }

  // Step 2: extraction for the messages that got through, a few at a time.
  const extractions = new Map<string, EvalCase["extraction"]>();
  const queue = scored.filter((p) => proceeds.get(p.fixture.id) === true);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const p = queue[next++];
      if (p === undefined) return;
      try {
        const body = stripQuotedHistory(p.parsed.textBody);
        const input = toExtractInput(p.meta, p.parsed, body, opts.ownerTimezone);
        const { output, usage } = await llm.extract(input);
        usages.push(usage);
        extractions.set(p.fixture.id, output);
      } catch {
        failed.add(p.fixture.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  return {
    cases: scored.map((p) => ({
      fixture: p.fixture,
      triageJobRelated: proceeds.get(p.fixture.id) === true,
      extraction: extractions.get(p.fixture.id) ?? null,
    })),
    usages,
    failedIds: [...failed].sort(),
    rules,
  };
}
