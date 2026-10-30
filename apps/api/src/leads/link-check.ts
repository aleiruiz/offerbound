import { convert } from "html-to-text";
import type { LinkFetcher } from "./ssrf.js";

export type { LinkFetcher } from "./ssrf.js";

/**
 * Link check for a lead's job URL (TECHNICAL_SPEC §7.2, AC-9.8). All network access goes through
 * the injected `LinkFetcher`, which is the SSRF-guarded one in production. A fetch that throws
 * (timeout, refused address, too many redirects, network error) is `unverified`; the reason is
 * dropped on purpose so nothing from a URL reaches a log.
 */
export type LinkCheckResult = {
  verdict: "dead" | "verified" | "unverified" | "unverifiable";
  finalUrl: string | null;
  pageExcerpt: string | null;
};

const EXCERPT_CHARS = 8000;

/** Phrases that mean the posting is closed (§7.2), compared after lower-casing and collapsing space. */
const CLOSED_MARKERS = [
  "no longer accepting",
  "job is no longer available",
  "position has been filled",
  "this job has expired",
  "job not found",
  "ya no está disponible",
  "vacante cerrada",
] as const;

/**
 * ATS hosts whose job pages live one level below the company's board, so that a URL with no job
 * path is the board's front page: the posting is gone and the ATS sent the visitor there.
 */
const BOARD_HOSTS: ReadonlySet<string> = new Set([
  "jobs.ashbyhq.com",
  "boards.greenhouse.io",
  "boards.eu.greenhouse.io",
  "job-boards.greenhouse.io",
  "job-boards.eu.greenhouse.io",
  "jobs.lever.co",
  "jobs.eu.lever.co",
  "apply.workable.com",
  "jobs.smartrecruiters.com",
]);

/** A query parameter that names one posting, as in `?gh_jid=123`. */
const JOB_PARAM = /(^|_)(jid|job|jobid|job_id|id|posting)$/i;

function isLinkedIn(url: URL): boolean {
  return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
}

function isBoardRoot(url: URL): boolean {
  if (!BOARD_HOSTS.has(url.hostname)) return false;
  if (url.pathname.split("/").filter((segment) => segment !== "").length > 1) return false;
  for (const name of url.searchParams.keys()) if (JOB_PARAM.test(name)) return false;
  return true;
}

function pageText(contentType: string | null, body: string): string {
  if (body === "") return "";
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "text/plain") return body.trim();
  return convert(body, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      ...(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
    ],
  }).trim();
}

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
}

function excerptOf(text: string): string | null {
  if (text === "") return null;
  let excerpt = text.slice(0, EXCERPT_CHARS);
  // Never end on half of a surrogate pair.
  const last = excerpt.charCodeAt(excerpt.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) excerpt = excerpt.slice(0, -1);
  return excerpt;
}

export async function checkLink(url: string, fetch: LinkFetcher): Promise<LinkCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { verdict: "unverified", finalUrl: null, pageExcerpt: null };
  }
  // Hosts that need a login are never fetched.
  if (isLinkedIn(parsed)) return { verdict: "unverifiable", finalUrl: null, pageExcerpt: null };

  let response: Awaited<ReturnType<LinkFetcher>>;
  try {
    response = await fetch(url);
  } catch {
    return { verdict: "unverified", finalUrl: null, pageExcerpt: null };
  }

  let final: URL | null = null;
  try {
    final = new URL(response.finalUrl);
  } catch {
    // A fetcher always returns a valid URL; treat anything else as an unusable answer.
    return { verdict: "unverified", finalUrl: null, pageExcerpt: null };
  }
  if (isLinkedIn(final)) return { verdict: "unverifiable", finalUrl: null, pageExcerpt: null };

  const finalUrl = response.finalUrl;
  if (response.status === 404 || response.status === 410) {
    return { verdict: "dead", finalUrl, pageExcerpt: null };
  }
  if (response.status !== 200) return { verdict: "unverified", finalUrl, pageExcerpt: null };

  const text = pageText(response.contentType, response.body);
  const haystack = normalize(text);
  if (isBoardRoot(final) || CLOSED_MARKERS.some((marker) => haystack.includes(marker))) {
    return { verdict: "dead", finalUrl, pageExcerpt: null };
  }
  return { verdict: "verified", finalUrl, pageExcerpt: excerptOf(text) };
}
