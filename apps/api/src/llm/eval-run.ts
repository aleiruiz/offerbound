import type { EmailFixture, MessageMetadata } from "@offerbound/contracts";
import { stripQuotedHistory } from "../gmail/dequote.js";
import { toGmailMessage } from "../gmail/fake-client.js";
import { parseFullMessage } from "../gmail/mime.js";
import type { EvalCase } from "./eval.js";
import { toExtractInput, toTriageInput } from "./inputs.js";
import type { LlmProvider, LlmUsage } from "./provider.js";

/** Triage batch size (TECHNICAL_SPEC §5.4). */
export const TRIAGE_BATCH_SIZE = 25;
/** Triage proceeds to extraction unless it says "not job-related" with at least this confidence. */
export const TRIAGE_PROCEED_BELOW = 0.7;

export type EvalRun = {
  cases: EvalCase[];
  /** Usage of every successful call, for the cost line. */
  usages: LlmUsage[];
  /** Fixture ids whose triage or extraction call failed. They count as misses in the scores. */
  failedIds: string[];
};

const runSkippedByRules = (f: EmailFixture): boolean => f.expected.triage === "skipped";

/**
 * Runs the pipeline's two model steps over `fixtures` with `llm`: triage for every message that no
 * rule skips, in batches of 25, then extraction for each message triage lets through. It calls
 * the provider directly and uses the same input builders as the pipeline (`toTriageInput`,
 * `toExtractInput`), but not the triage rules: the model sees every message, which is the harder test.
 */
export async function runEvalCases(
  llm: LlmProvider,
  fixtures: EmailFixture[],
  opts: { ownerTimezone: string; concurrency?: number },
): Promise<EvalRun> {
  const usages: LlmUsage[] = [];
  const failed = new Set<string>();

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
    return { fixture, meta, parsed };
  });
  const scored = prepared.filter((p) => !runSkippedByRules(p.fixture));

  // Step 1: triage. A message the model leaves out, or a failed batch, counts as dropped.
  const proceeds = new Map<string, boolean>();
  for (let i = 0; i < scored.length; i += TRIAGE_BATCH_SIZE) {
    const batch = scored.slice(i, i + TRIAGE_BATCH_SIZE);
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

  // Step 2: extraction for the messages triage let through, a few at a time.
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
  };
}
