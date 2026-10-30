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
/**
 * The most HTML given to the converter. html-to-text is synchronous and superlinear on deeply
 * nested markup (100k nested divs blocked the thread for seconds and then overflowed the stack),
 * so the input is cut first; 128 KiB is far more than the excerpt and the markers need, and is
 * the same cap used for email HTML.
 */
const MAX_HTML_CHARS = 128 * 1024;

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

/**
 * Query parameters that carry no job: tracking and display options. A board root is recognised
 * only when every parameter is one of these, so any other name (`gh_jid`, `job-id`,
 * `jobPostingId`, ...) is taken to name a posting. Wrongly calling a live job "dead" discards a
 * good lead, so the check errs toward "not a root".
 */
const HARMLESS_PARAM =
  /^(utm_[a-z0-9_]+|ref|ref_?src|source|src|gh_src|lng|lang|locale|fbclid|gclid|trk)$/i;

function isLinkedIn(url: URL): boolean {
  return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
}

function isBoardRoot(url: URL): boolean {
  if (!BOARD_HOSTS.has(url.hostname)) return false;
  if (url.pathname.split("/").filter((segment) => segment !== "").length > 1) return false;
  for (const name of url.searchParams.keys()) if (!HARMLESS_PARAM.test(name)) return false;
  return true;
}

function pageText(contentType: string | null, body: string): string {
  if (body === "") return "";
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "text/plain") return body.trim();
  return convert(body.slice(0, MAX_HTML_CHARS), {
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

  let text: string;
  try {
    text = pageText(response.contentType, response.body);
  } catch {
    // Markup the converter cannot handle: the page could not be read, so it is not verified.
    return { verdict: "unverified", finalUrl, pageExcerpt: null };
  }
  const haystack = normalize(text);
  if (isBoardRoot(final) || CLOSED_MARKERS.some((marker) => haystack.includes(marker))) {
    return { verdict: "dead", finalUrl, pageExcerpt: null };
  }
  return { verdict: "verified", finalUrl, pageExcerpt: excerptOf(text) };
}
