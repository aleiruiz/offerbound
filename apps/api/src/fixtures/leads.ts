import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SearchResultSchema, type SearchResult } from "@offerbound/contracts";
import { repoRoot } from "./root.js";

/**
 * Reads every `*.json` file directly inside `dir` (a relative `dir` is resolved from the
 * repository root), validates each against {@link SearchResultSchema} and returns them in file name
 * order. Each file is one search round's answer, for the fake provider to hand out in turn.
 */
export function loadLeadBatches(dir = "fixtures/leads"): SearchResult[] {
  const absolute = isAbsolute(dir) ? dir : resolve(repoRoot(), dir);
  const files = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  return files.map((name): SearchResult => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(absolute, name), "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid lead batch ${name}: not valid JSON (${reason})`);
    }
    const parsed = SearchResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid lead batch ${name}: ${parsed.error.message}`);
    return parsed.data;
  });
}
