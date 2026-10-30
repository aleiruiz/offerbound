/**
 * `pnpm eval:emails [--private]` — AC-17.4, TECHNICAL_SPEC §15.
 *
 * Runs email triage and extraction with the real OpenAI provider over labelled fixtures, prints
 * per-category precision and recall and the release bar, and exits 1 when the bar is not met.
 *
 *   (default)   fixtures/emails/ (fictional, committed)
 *   --private   private/eval/ (git-ignored; same JSON format; never commit it)
 *
 * It spends real money and needs a key, so it never runs in CI or in any test:
 *   OPENAI_API_KEY (required), OPENAI_MODEL_TRIAGE / OPENAI_MODEL_EXTRACT (default gpt-6-luna),
 *   OPENAI_REASONING_EFFORT_TRIAGE / OPENAI_REASONING_EFFORT_EXTRACT (default low),
 *   AI_PRICING (optional JSON, as in .env.example) to print a cost, USER_TIMEZONE (optional).
 *
 * Before any model call the label rules run (R1 skip labels, R3 outgoing mail, R8 Promotions and
 * Forums; SECURITY §3), so mail they decide is never sent to OpenAI. Triage and extraction figures
 * are measured on the messages that pass them. The sender and thread rules (R2, R4 to R7) need
 * mailbox state and are not applied, so the model also sees mail those would decide.
 *
 * Output holds fixture ids, categories and counts only: no email text, names or keys. In a private
 * set, give the fixtures opaque ids, since failures are listed by id.
 */
import { loadEmailFixtures } from "../src/fixtures/emails.js";
import { formatReport, meetsBar, scoreEval, type EvalReport } from "../src/llm/eval.js";
import { runEvalCases } from "../src/llm/eval-run.js";
import { OpenAiProvider } from "../src/llm/openai-provider.js";
import { computeCostMicros, ModelPriceSchema, type ModelPrice } from "../src/llm/pricing.js";
import type { LlmConfig, ReasoningEffort } from "../src/llm/provider.js";
import { z } from "zod";

const EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function fail(message: string): never {
  console.error(`eval:emails: ${message}`);
  process.exit(2);
}

function effortFrom(name: string): ReasoningEffort {
  const value = process.env[name];
  if (value === undefined || value === "") return "low";
  if (!(EFFORTS as readonly string[]).includes(value)) {
    fail(`${name} must be one of ${EFFORTS.join(", ")}.`);
  }
  return value as ReasoningEffort;
}

function pricingFromEnv(): Record<string, ModelPrice> {
  const raw = process.env.AI_PRICING;
  if (raw === undefined || raw === "") return {};
  try {
    return z.record(z.string(), ModelPriceSchema).parse(JSON.parse(raw));
  } catch {
    return fail("AI_PRICING is not valid JSON of model prices.");
  }
}

function buildConfig(apiKey: string): LlmConfig {
  const model = (name: string): string => process.env[name] || "gpt-6-luna";
  const triage = model("OPENAI_MODEL_TRIAGE");
  const extract = model("OPENAI_MODEL_EXTRACT");
  const effortTriage = effortFrom("OPENAI_REASONING_EFFORT_TRIAGE");
  const effortExtract = effortFrom("OPENAI_REASONING_EFFORT_EXTRACT");
  return {
    apiKey,
    // Only triage and extract are called here; the other purposes follow extraction.
    models: {
      triage,
      extract,
      parse_report: extract,
      rank: extract,
      search: extract,
      cv_profile: extract,
    },
    efforts: {
      triage: effortTriage,
      extract: effortExtract,
      parse_report: effortExtract,
      rank: effortExtract,
      search: effortExtract,
      cv_profile: effortExtract,
    },
    pricing: pricingFromEnv(),
    webSearchCostPerCallMicros: null,
    searchMaxToolCallsPerRound: 40,
  };
}

/**
 * What went wrong reading the fixtures, without quoting them: the loader's messages can echo a
 * snippet of the file. Names the file and the kind of problem only.
 */
function describeLoadError(error: unknown): string {
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "folder not found";
  const message = error instanceof Error ? error.message : "";
  const file = /^Invalid email fixture (\S+?):/.exec(message)?.[1];
  if (file === undefined) return "unreadable";
  const kind = message.includes("not valid JSON")
    ? "not valid JSON"
    : "does not match the fixture schema";
  return `${file} ${kind}`;
}

function summarise(report: EvalReport, failed: number): string {
  return `${formatReport(report)}\n\nProvider failures: ${failed}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const unknown = args.filter((a) => a !== "--private");
  if (unknown.length > 0)
    fail(`unknown argument ${unknown[0]}. Usage: pnpm eval:emails [--private]`);
  const privateSet = args.includes("--private");

  if (process.env.CI) fail("this is a live evaluation and must not run in CI.");
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    fail("OPENAI_API_KEY is not set. This script calls the real OpenAI API; export a key first.");
  }

  const dir = privateSet ? "private/eval" : "fixtures/emails";
  let fixtures;
  try {
    fixtures = loadEmailFixtures(dir);
  } catch (error) {
    fail(`could not read ${dir}: ${describeLoadError(error)}`);
  }
  if (fixtures.length === 0) fail(`no fixtures found in ${dir}.`);

  const config = buildConfig(apiKey);
  // Nothing is stored: the evaluation has no database.
  const noDb = { llmCall: { create: () => Promise.resolve(undefined) } };
  const llm = new OpenAiProvider(config, noDb, undefined, {
    warn: () => undefined, // unknown prices are reported below
  });

  console.log(
    `Evaluating ${fixtures.length} messages from ${dir} (triage ${config.models.triage}, extraction ${config.models.extract})...`,
  );
  const tz = process.env.USER_TIMEZONE || "America/Monterrey";
  const run = await runEvalCases(llm, fixtures, { ownerTimezone: tz });
  const report = scoreEval(run.cases);

  const r = run.rules;
  console.log(
    `\nRules ran before the model: ${r.skipped} skipped (R1), ${r.dropped} dropped (R3 outgoing, R8 Promotions/Forums), ` +
      `${r.outgoingKept} outgoing kept as linked (R3); none of these went to OpenAI. ` +
      `${r.triaged} went to model triage. Triage and extraction figures are measured on the rule-passed set; ` +
      "sender and thread rules (R2, R4-R7) were not applied.",
  );
  console.log(`\n${summarise(report, run.failedIds.length)}`);

  const misses = run.cases.filter((c) => {
    const want = c.fixture.expected.category ?? "not_job_related";
    const got = c.triageJobRelated ? (c.extraction?.category ?? null) : "not_job_related";
    return want !== got && c.fixture.expected.triage === "job_related";
  });
  if (misses.length > 0) {
    console.log("\nWrong category or dropped (id: expected -> got):");
    for (const c of misses) {
      const got = c.triageJobRelated
        ? (c.extraction?.category ?? "no extraction")
        : "dropped by triage";
      console.log(`  ${c.fixture.id}: ${c.fixture.expected.category ?? "-"} -> ${got}`);
    }
  }
  if (run.failedIds.length > 0) console.log(`\nFailed calls: ${run.failedIds.join(", ")}`);

  const costs = run.usages.map((u) => computeCostMicros(u, config.pricing, null));
  const tokens = run.usages.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
  const known = costs.filter((c): c is number => c !== null);
  const costText =
    known.length === costs.length && costs.length > 0
      ? `$${(known.reduce((a, b) => a + b, 0) / 1_000_000).toFixed(4)}`
      : "unknown (set AI_PRICING for the models used)";
  console.log(`\n${run.usages.length} calls, ${tokens} tokens, cost ${costText}`);

  const ok = meetsBar(report) && run.failedIds.length === 0;
  console.log(ok ? "\nThe AC-17.4 bar is met." : "\nThe AC-17.4 bar is NOT met.");
  process.exit(ok ? 0 : 1);
}

main().catch((error: unknown) => {
  // Error names only: a provider error must not echo prompts or output.
  console.error(`eval:emails: failed (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(2);
});
