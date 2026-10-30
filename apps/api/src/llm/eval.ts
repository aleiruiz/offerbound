import type { EmailCategory, EmailFixture, Extraction } from "@offerbound/contracts";
import { EmailCategorySchema } from "@offerbound/contracts";
import { normalizeCompanyName } from "@offerbound/domain";

/**
 * Scoring for the live email evaluation (AC-17.4, TECHNICAL_SPEC §15). Pure: the script
 * (`scripts/eval-emails.ts`) calls the model and hands the results here.
 */

/** One fixture and what the pipeline's two model steps made of it. */
export type EvalCase = {
  fixture: EmailFixture;
  /** Whether triage let the message through to extraction (`jobRelated`, or confidence < 0.70). */
  triageJobRelated: boolean;
  /** The extraction, or null when the message was not extracted or extraction failed. */
  extraction: Extraction | null;
};

/** `hits` of `total`; `rate` is null when there was nothing to measure. */
export type Rate = { hits: number; total: number; rate: number | null };

export type CategoryScore = {
  category: EmailCategory;
  /** Messages whose label is this category. */
  expected: number;
  /** Messages the pipeline put in this category. */
  predicted: number;
  truePositives: number;
  /** Null when nothing was predicted in this category. */
  precision: number | null;
  /** Null when no message carries this label. */
  recall: number | null;
};

export type EvalReport = {
  /** Fixtures scored. Messages the rules skip before any model call (`skipped`) are left out. */
  scored: number;
  perCategory: CategoryScore[];
  /** Of the messages labelled job-related, the share that triage passed on to extraction. */
  jobRelatedRecall: Rate;
  /** Of the messages labelled job-related, the share extracted with the right category. */
  categoryAccuracy: Rate;
  /** Of the job-related messages that name a company, the share extracted with that company. */
  companyMatch: Rate;
  /** Of the interviews labelled with a start time and a calendar invite, the exact starts. */
  startIcs: Rate;
  /** The same for interviews described only in the message text. */
  startText: Rate;
};

/** AC-17.4: Release 1 ships only when every figure meets its minimum. */
export const EVAL_BAR = {
  jobRelatedRecall: 0.98,
  categoryAccuracy: 0.9,
  companyMatch: 0.9,
  startIcs: 0.95,
  startText: 0.85,
} as const;

const rate = (hits: number, total: number): Rate => ({
  hits,
  total,
  rate: total === 0 ? null : hits / total,
});

/** The category the pipeline ended with: dropped by triage is `not_job_related`; null if unextracted. */
function predictedCategory(c: EvalCase): EmailCategory | null {
  if (!c.triageJobRelated) return "not_job_related";
  return c.extraction?.category ?? null;
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && !Number.isNaN(right) && left === right;
}

export function scoreEval(cases: EvalCase[]): EvalReport {
  const scoredCases = cases.filter((c) => c.fixture.expected.triage !== "skipped");
  const expectedOf = (c: EvalCase): EmailCategory =>
    c.fixture.expected.category ?? "not_job_related";

  const perCategory = EmailCategorySchema.options.map((category): CategoryScore => {
    const expected = scoredCases.filter((c) => expectedOf(c) === category).length;
    const predicted = scoredCases.filter((c) => predictedCategory(c) === category).length;
    const truePositives = scoredCases.filter(
      (c) => expectedOf(c) === category && predictedCategory(c) === category,
    ).length;
    return {
      category,
      expected,
      predicted,
      truePositives,
      precision: predicted === 0 ? null : truePositives / predicted,
      recall: expected === 0 ? null : truePositives / expected,
    };
  });

  const jobRelated = scoredCases.filter((c) => c.fixture.expected.triage === "job_related");
  const jobRelatedRecall = rate(
    jobRelated.filter((c) => c.triageJobRelated).length,
    jobRelated.length,
  );
  const categoryAccuracy = rate(
    jobRelated.filter((c) => predictedCategory(c) === expectedOf(c)).length,
    jobRelated.length,
  );

  const named = jobRelated.filter((c) => c.fixture.expected.company !== null);
  const companyMatch = rate(
    named.filter((c) => {
      const got = c.extraction?.company?.name;
      const want = c.fixture.expected.company;
      return (
        got !== undefined &&
        want !== null &&
        normalizeCompanyName(got) === normalizeCompanyName(want)
      );
    }).length,
    named.length,
  );

  const withStart = scoredCases.filter((c) => c.fixture.expected.interviewStart !== undefined);
  const exactStart = (c: EvalCase): boolean =>
    sameInstant(c.extraction?.interview?.startsAt, c.fixture.expected.interviewStart ?? "");
  const icsCases = withStart.filter((c) => c.fixture.ics !== undefined);
  const textCases = withStart.filter((c) => c.fixture.ics === undefined);

  return {
    scored: scoredCases.length,
    perCategory,
    jobRelatedRecall,
    categoryAccuracy,
    companyMatch,
    startIcs: rate(icsCases.filter(exactStart).length, icsCases.length),
    startText: rate(textCases.filter(exactStart).length, textCases.length),
  };
}

const KEYS = Object.keys(EVAL_BAR) as (keyof typeof EVAL_BAR)[];

/**
 * True when every figure meets its minimum. A figure with nothing to measure (for instance a
 * private set without a plain-text invite) cannot show the bar is met, so it fails it.
 */
export function meetsBar(r: EvalReport): boolean {
  return KEYS.every((key) => {
    const value = r[key].rate;
    return value !== null && value >= EVAL_BAR[key] - 1e-9;
  });
}

const pct = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

const LABELS: Record<keyof typeof EVAL_BAR, string> = {
  jobRelatedRecall: "Job-related recall",
  categoryAccuracy: "Category accuracy",
  companyMatch: "Company match",
  startIcs: "Interview start (calendar invite)",
  startText: "Interview start (plain text)",
};

/** The two tables the script prints: the bar, then per-category precision and recall. */
export function formatReport(r: EvalReport): string {
  const bar = KEYS.map((key) => {
    const { hits, total, rate: value } = r[key];
    const ok = value !== null && value >= EVAL_BAR[key] - 1e-9;
    return `${LABELS[key].padEnd(36)} ${pct(value).padStart(7)}  (${hits}/${total})  bar >= ${pct(EVAL_BAR[key])}  ${ok ? "PASS" : "FAIL"}`;
  });
  const rows = r.perCategory.map(
    (c) =>
      `${c.category.padEnd(26)} ${String(c.expected).padStart(8)} ${String(c.predicted).padStart(9)} ${pct(c.precision).padStart(10)} ${pct(c.recall).padStart(8)}`,
  );
  return [
    `Messages scored: ${r.scored}`,
    "",
    ...bar,
    "",
    `${"Category".padEnd(26)} ${"Expected".padStart(8)} ${"Predicted".padStart(9)} ${"Precision".padStart(10)} ${"Recall".padStart(8)}`,
    ...rows,
  ].join("\n");
}
