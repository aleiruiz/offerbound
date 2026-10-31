import { isTrackingParam } from "@offerbound/domain";
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
  "job is no longer open",
  "job you are looking for is no longer",
  "position is no longer available",
  "posting is no longer available",
  "this job is closed",
  "this position is closed",
  "this position has been closed",
  "this job posting has expired",
  "this posting has expired",
  "position has been filled",
  "this job has expired",
  "job not found",
  "the page you are looking for doesn't exist",
  "ya no está disponible",
  "ya no esta disponible",
  "ya no acepta solicitudes",
  "vacante cerrada",
  "esta vacante ha expirado",
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
 * Display and ad parameters that carry no job, besides the tracking ones that job keys drop
 * (`isTrackingParam`, the one list shared with `jobKey`, TECHNICAL_SPEC §6.1). A board root is
 * recognised only when every parameter is one of these, so any other name (`gh_jid`, `job-id`,
 * `jobPostingId`, ...) is taken to name a posting. Wrongly calling a live job "dead" discards a
 * good lead, so the check errs toward "not a root".
 */
const DISPLAY_PARAM = /^(ref_?src|lng|lang|locale|fbclid|gclid)$/i;

function isHarmlessParam(name: string): boolean {
  return isTrackingParam(name) || DISPLAY_PARAM.test(name);
}

function isLinkedIn(url: URL): boolean {
  return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
}

function isBoardRoot(url: URL): boolean {
  if (!BOARD_HOSTS.has(url.hostname)) return false;
  // Greenhouse sends a closed posting to the board with `?error=true`, whatever the path.
  if (url.searchParams.has("error")) return true;
  if (url.pathname.split("/").filter((segment) => segment !== "").length > 1) return false;
  for (const name of url.searchParams.keys()) if (!isHarmlessParam(name)) return false;
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

/**
 * Workday job pages are a script-only shell that answers 200 whether or not the posting is still
 * open, so they are judged from Workday's own posting API on the same host
 * (`/wday/cxs/{tenant}/{site}/job/...`), which answers 404 once the posting is gone.
 * Returns null for a URL that is not a Workday job page.
 */
export function workdayApiUrl(url: URL): string | null {
  const host = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(url.hostname);
  if (host === null) return null;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length > 0 && /^[a-z]{2}-[a-z]{2}$/i.test(segments[0]!)) segments.shift();
  const [site, kind, ...rest] = segments;
  if (site === undefined || kind !== "job" || rest.length === 0) return null;
  return `https://${url.hostname}/wday/cxs/${host[1]}/${site}/job/${rest.join("/")}`;
}

async function checkWorkday(apiUrl: string, finalUrl: string, fetch: LinkFetcher) {
  let response: Awaited<ReturnType<LinkFetcher>>;
  try {
    response = await fetch(apiUrl);
  } catch {
    return { verdict: "unverified", finalUrl, pageExcerpt: null } satisfies LinkCheckResult;
  }
  if (response.status === 404 || response.status === 410) {
    return { verdict: "dead", finalUrl, pageExcerpt: null } satisfies LinkCheckResult;
  }
  if (response.status !== 200) {
    return { verdict: "unverified", finalUrl, pageExcerpt: null } satisfies LinkCheckResult;
  }
  try {
    const data = JSON.parse(response.body) as {
      jobPostingInfo?: { title?: unknown; jobDescription?: unknown; canApply?: unknown };
    };
    const info = data.jobPostingInfo;
    if (info === undefined || typeof info.title !== "string") {
      return { verdict: "unverified", finalUrl, pageExcerpt: null } satisfies LinkCheckResult;
    }
    if (info.canApply === false) {
      return { verdict: "dead", finalUrl, pageExcerpt: null } satisfies LinkCheckResult;
    }
    const description =
      typeof info.jobDescription === "string" ? pageText("text/html", info.jobDescription) : "";
    return {
      verdict: "verified",
      finalUrl,
      pageExcerpt: excerptOf(`${info.title}\n\n${description}`.trim()),
    } satisfies LinkCheckResult;
  } catch {
    return { verdict: "unverified", finalUrl, pageExcerpt: null } satisfies LinkCheckResult;
  }
}

/** Words of a job title too common to show that a page is about this job. */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "the",
  "for",
  "with",
  "remote",
  "remoto",
  "hybrid",
  "para",
  "con",
]);

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word.length >= 2);
}

/**
 * Whether a page mentions the job: at least half of the title's meaningful words appear in it.
 * A careers site that sends a closed posting to its search page, or a script-only shell, answers
 * 200 without the job on it; such a page is not proof that the posting is open.
 */
export function mentionsTitle(text: string, title: string): boolean {
  const wanted = [...new Set(words(title).filter((word) => !TITLE_STOPWORDS.has(word)))];
  if (wanted.length === 0) return true;
  const present = new Set(words(text));
  const found = wanted.filter((word) => present.has(word)).length;
  return found * 2 >= wanted.length;
}

export type CheckLinkOptions = {
  /** The lead's job title. When given, a page that does not mention it is not `verified`. */
  title?: string | null;
};

export async function checkLink(
  url: string,
  fetch: LinkFetcher,
  options: CheckLinkOptions = {},
): Promise<LinkCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { verdict: "unverified", finalUrl: null, pageExcerpt: null };
  }
  // Hosts that need a login are never fetched.
  if (isLinkedIn(parsed)) return { verdict: "unverifiable", finalUrl: null, pageExcerpt: null };

  const workday = workdayApiUrl(parsed);
  if (workday !== null) return checkWorkday(workday, url, fetch);

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
  const workdayFinal = workdayApiUrl(final);
  if (workdayFinal !== null) return checkWorkday(workdayFinal, response.finalUrl, fetch);

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
  if (options.title && !mentionsTitle(text, options.title)) {
    return { verdict: "unverified", finalUrl, pageExcerpt: null };
  }
  return { verdict: "verified", finalUrl, pageExcerpt: excerptOf(text) };
}
