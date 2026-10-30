import { registrableDomain } from "./domains.js";

/** Query parameters that only track where a click came from (TECHNICAL_SPEC §6.1). */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gh_src",
  "lever-source",
  "source",
  "ref",
  "refid",
  "trk",
  "trackingid",
  "src",
]);

/** Query parameters that identify a posting on a site we have no dedicated rule for. */
const GENERIC_ID_PARAMS: ReadonlySet<string> = new Set([
  "id",
  "jid",
  "job",
  "job_id",
  "jobid",
  "req",
  "req_id",
  "reqid",
  "requisition_id",
  "position",
  "posting",
  "pid",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBDOMAIN_ONLY_DENY: ReadonlySet<string> = new Set(["www", "app", "api", "jobs", "careers"]);

type Parsed = { host: string; segments: string[]; params: URLSearchParams };

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

function parse(url: string): Parsed | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return null;
  const segments = u.pathname.split("/").filter((s) => s !== "");
  return { host, segments, params: u.searchParams };
}

/** First non-tracking value of a query parameter, matched case-insensitively. */
function param(params: URLSearchParams, name: string): string | null {
  for (const [key, value] of params) {
    if (key.toLowerCase() === name.toLowerCase() && !isTracking(key) && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function lower(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value.toLowerCase();
}

/** The single label in front of `suffix` (`acme.recruitee.com` → `acme`), or null. */
function subdomainOf(host: string, suffix: string): string | null {
  if (!host.endsWith(`.${suffix}`)) return null;
  const label = host.slice(0, -(suffix.length + 1));
  return label === "" || label.includes(".") || SUBDOMAIN_ONLY_DENY.has(label) ? null : label;
}

const GREENHOUSE_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "boards.eu.greenhouse.io",
  "job-boards.eu.greenhouse.io",
]);
const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const WORKDAY_HOST = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/;
const PERSONIO_HOST = /^([a-z0-9-]+)\.jobs\.personio\.[a-z]{2,}$/;

/** Greenhouse org: first path segment, or `for=` on the legacy embed URLs; never `embed`. */
function greenhouseOrg(p: Parsed): string | undefined {
  const first = p.segments[0]?.toLowerCase();
  if (first === "embed") return param(p.params, "for")?.toLowerCase();
  return first;
}

/** SmartRecruiters paths that are not `/{company}/{id}`. */
const SMARTRECRUITERS_RESERVED: ReadonlySet<string> = new Set(["oneclick-ui"]);

/** `{ats}:{org}` for the ATSs whose org is part of the host or path, or null. */
function slugOf(p: Parsed): string | null {
  const { host, segments } = p;
  if (host === "jobs.ashbyhq.com") return withOrg("ashby", segments[0]);
  if (LEVER_HOSTS.has(host)) return withOrg("lever", segments[0]);
  if (GREENHOUSE_HOSTS.has(host)) return withOrg("greenhouse", greenhouseOrg(p));
  if (host === "jobs.smartrecruiters.com") {
    const company = segments[0]?.toLowerCase();
    return company && SMARTRECRUITERS_RESERVED.has(company)
      ? null
      : withOrg("smartrecruiters", company);
  }
  if (host === "apply.workable.com") return withOrg("workable", segments[0]);
  const workday = WORKDAY_HOST.exec(host);
  if (workday) return withOrg("workday", workday[1]);
  const personio = PERSONIO_HOST.exec(host);
  if (personio) return withOrg("personio", personio[1]);
  if (registrableDomain(host) === "recruitee.com") {
    return withOrg("recruitee", subdomainOf(host, "recruitee.com") ?? undefined);
  }
  if (registrableDomain(host) === "teamtailor.com") {
    return withOrg("teamtailor", subdomainOf(host, "teamtailor.com") ?? undefined);
  }
  return null;
}

function withOrg(ats: string, org: string | undefined): string | null {
  const o = lower(org);
  return o === null ? null : `${ats}:${o}`;
}

function atsKey(p: Parsed): string | null {
  const { host, segments, params } = p;
  const [a, b, c] = segments;

  if (host === "jobs.ashbyhq.com" && a && b && UUID.test(b)) {
    return `ashby:${a.toLowerCase()}:${b.toLowerCase()}`;
  }
  if (LEVER_HOSTS.has(host) && a && b && UUID.test(b)) {
    return `lever:${a.toLowerCase()}:${b.toLowerCase()}`;
  }
  if (GREENHOUSE_HOSTS.has(host) && a && a !== "embed" && b === "jobs" && c && /^\d+$/.test(c)) {
    return `greenhouse:${a.toLowerCase()}:${c}`;
  }
  const workday = WORKDAY_HOST.exec(host);
  if (workday) {
    // .../job/{location}/{slug}_{reqId}[/apply[/autofillWithResume]]: only segments after
    // `job` count, and the location segment is skipped when a title segment follows it
    const jobAt = segments.indexOf("job");
    if (jobAt !== -1) {
      const after = segments.slice(jobAt + 1);
      const candidates = after.length > 1 ? after.slice(1) : after;
      const reqId = candidates.map((s) => /^.+_([^_]+)$/.exec(s)?.[1]).find((r) => r !== undefined);
      if (reqId) return `workday:${workday[1]}:${reqId}`;
    }
  }
  const personio = PERSONIO_HOST.exec(host);
  if (personio && a === "job" && b && /^\d+$/.test(b)) return `personio:${personio[1]}:${b}`;
  if (host === "jobs.smartrecruiters.com" && a && b && !SMARTRECRUITERS_RESERVED.has(a)) {
    const id = /^(\d+)(?:-.*)?$/.exec(b)?.[1];
    if (id) return `smartrecruiters:${a.toLowerCase()}:${id}`;
  }
  if (host === "apply.workable.com" && a && b === "j" && c) {
    return `workable:${a.toLowerCase()}:${c}`;
  }

  const domain = registrableDomain(host);
  if (domain === "linkedin.com") {
    const view = segments.findIndex((s, i) => s === "view" && segments[i - 1] === "jobs");
    const id =
      (view === -1 ? undefined : /^(?:.*-)?(\d+)$/.exec(segments[view + 1] ?? "")?.[1]) ??
      (/^\d+$/.test(param(params, "currentJobId") ?? "") ? param(params, "currentJobId") : null);
    if (id) return `linkedin:${id}`;
  }
  if (domain === "indeed.com") {
    const jk = param(params, "jk");
    if (jk) return `indeed:${jk}`;
  }

  // Greenhouse-hosted job pages embedded on a company's own site.
  const ghJid = param(params, "gh_jid");
  if (ghJid && /^\d+$/.test(ghJid)) {
    const org = GREENHOUSE_HOSTS.has(host) ? greenhouseOrg(p) : undefined;
    return `greenhouse:${org ?? host.replace(/^www\./, "")}:${ghJid}`;
  }
  return null;
}

function genericKey(p: Parsed): string {
  const host = p.host.replace(/^www\./, "");
  const path = p.segments.join("/");
  const ids = [...p.params]
    .filter(([k, v]) => GENERIC_ID_PARAMS.has(k.toLowerCase()) && !isTracking(k) && v !== "")
    .map(([k, v]): [string, string] => [k.toLowerCase(), v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = ids.length === 0 ? "" : `?${ids.map(([k, v]) => `${k}=${v}`).join("&")}`;
  return `url:${host}${path === "" ? "" : `/${path}`}${query}`;
}

/**
 * Stable identity of a job posting, used for duplicate detection (TECHNICAL_SPEC §6.1).
 * Returns null for anything that is not an http(s) URL.
 */
export function jobKey(url: string): string | null {
  const parsed = parse(url);
  if (parsed === null) return null;
  return atsKey(parsed) ?? genericKey(parsed);
}

/** `{ats}:{org}` for a posting hosted on a known ATS, otherwise null. */
export function atsSlug(url: string): string | null {
  const parsed = parse(url);
  return parsed === null ? null : slugOf(parsed);
}
