import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { EmailFixtureSchema, type EmailFixture } from "@offerbound/contracts";
import { repoRoot } from "./root.js";

/** The fictional owner address every fixture is sent to (or from, when outbound). Also in the README. */
export const FIXTURE_OWNER_EMAIL = "mateo.salgado@owner.example";

/** The backfill start the fixtures assume: 2026-09-01 in the owner's time zone (UTC−6). */
export const FIXTURE_BACKFILL_SINCE = new Date("2026-09-01T06:00:00.000Z");

/**
 * Applications that exist before the fixtures run. The two ambiguous fixtures need a company with
 * two open applications, and the pipeline's own rules never create a second application for a
 * company, so the pipeline test seeds these (as a sheet import would: by name, without domains).
 */
export type FixtureSeedApplication = {
  company: string;
  role: string;
  status: "applied";
  appliedOn: string;
};

export const FIXTURE_SEED_APPLICATIONS: readonly FixtureSeedApplication[] = [
  {
    company: "Driftwood Software",
    role: "Senior Backend Engineer",
    status: "applied",
    appliedOn: "2026-09-10",
  },
  {
    company: "Driftwood Software",
    role: "Frontend Engineer",
    status: "applied",
    appliedOn: "2026-09-10",
  },
  { company: "Fairhaven Labs", role: "Data Scientist", status: "applied", appliedOn: "2026-09-12" },
  {
    company: "Fairhaven Labs",
    role: "Machine Learning Engineer",
    status: "applied",
    appliedOn: "2026-09-12",
  },
];

/**
 * Reads every `*.json` file directly inside `dir` (a relative `dir` is resolved from the
 * repository root), validates each against {@link EmailFixtureSchema} and returns them sorted by
 * `internalDate`, then `id`.
 */
export function loadEmailFixtures(dir = "fixtures/emails"): EmailFixture[] {
  const absolute = isAbsolute(dir) ? dir : resolve(repoRoot(), dir);
  const files = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const fixtures = files.map((name): EmailFixture => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(absolute, name), "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid email fixture ${name}: not valid JSON (${reason})`);
    }
    const parsed = EmailFixtureSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid email fixture ${name}: ${parsed.error.message}`);
    }
    return parsed.data;
  });

  return fixtures.sort(
    (a, b) =>
      (a.internalDate < b.internalDate ? -1 : a.internalDate > b.internalDate ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
