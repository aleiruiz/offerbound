import { atsSlug } from "./job-key.js";
import { bareAddress, isNonCompanyDomain, registrableDomain } from "./domains.js";

/** Trailing legal and generic suffixes, as token sequences (TECHNICAL_SPEC §6.2). Longest first. */
const SUFFIXES: readonly (readonly string[])[] = [
  ["s", "de", "rl", "de", "cv"],
  ["sa", "de", "cv"],
  ...[
    "inc",
    "llc",
    "ltd",
    "limited",
    "gmbh",
    "ag",
    "bv",
    "nv",
    "ab",
    "as",
    "aps",
    "oy",
    "sa",
    "sas",
    "sl",
    "srl",
    "spa",
    "plc",
    "corp",
    "corporation",
    "co",
    "company",
    "pty",
    "pte",
    "kk",
  ].map((s) => [s] as const),
];

function endsWithTokens(tokens: readonly string[], suffix: readonly string[]): boolean {
  const start = tokens.length - suffix.length;
  return start >= 0 && suffix.every((t, i) => tokens[start + i] === t);
}

/**
 * Comparison form of a company name: NFKD, no diacritics, lower case, `&` as "and", no
 * punctuation, trailing legal suffixes dropped repeatedly (never the last remaining token).
 */
export function normalizeCompanyName(name: string): string {
  const tokens = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t !== "");
  for (;;) {
    const suffix = SUFFIXES.find((s) => tokens.length > s.length && endsWithTokens(tokens, s));
    if (suffix === undefined) break;
    tokens.length -= suffix.length;
  }
  return tokens.join(" ");
}

function tokenSet(name: string): Set<string> {
  return new Set(
    normalizeCompanyName(name)
      .split(" ")
      .filter((t) => t !== ""),
  );
}

/** Jaccard similarity of the normalised token sets; 0 when either side has no tokens. */
export function tokenSetJaccard(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** True when the tokens of `inner` appear as a contiguous run of whole words in `outer`. */
function containsWords(outer: string, inner: string): boolean {
  return ` ${outer} `.includes(` ${inner} `);
}

const DUPLICATE_JACCARD = 0.8;

function isPossibleDuplicate(a: string, b: string): boolean {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (na === "" || nb === "") return false;
  return (
    tokenSetJaccard(na, nb) >= DUPLICATE_JACCARD || containsWords(na, nb) || containsWords(nb, na)
  );
}

export type CompanyRef = {
  id: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  domains: string[];
  atsSlugs: string[];
  groupId: string | null;
};

export type CompanyIndex = {
  companies: CompanyRef[];
  contacts: { email: string; companyId: string | null }[];
};

export type NewCompany = {
  name: string;
  normalizedName: string;
  domains: string[];
  atsSlugs: string[];
  websiteDomain: string | null;
};

export type CompanyResolution =
  | { kind: "existing"; companyId: string; via: "contact" | "domain" | "ats_slug" | "name" }
  | { kind: "new"; company: NewCompany; possibleDuplicateOf: string[] }
  | { kind: "none" };

/** Registrable domain usable as a company domain: not generic, ATS or job-board. */
function companyDomain(hostOrEmail: string): string | null {
  const domain = registrableDomain(hostOrEmail);
  return domain === null || isNonCompanyDomain(domain) ? null : domain;
}

/** Company domain of an extracted website, given as a host or a URL. */
function websiteCompanyDomain(website: string | null): string | null {
  if (website === null) return null;
  const host = website
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#]/)[0];
  return host === undefined || host === "" ? null : companyDomain(host);
}

/**
 * Finds the company an email or posting belongs to, or describes the one to create
 * (TECHNICAL_SPEC §6.2). First hit wins: contact, sender domain, ATS slug, name or alias.
 */
export function resolveCompany(
  input: {
    senderEmail: string | null;
    extractedName: string | null;
    websiteDomain: string | null;
    jobUrl: string | null;
  },
  index: CompanyIndex,
): CompanyResolution {
  const sender = input.senderEmail === null ? "" : bareAddress(input.senderEmail);

  if (sender !== "") {
    const contact = index.contacts.find(
      (c) => c.companyId !== null && bareAddress(c.email) === sender,
    );
    if (contact?.companyId) {
      return { kind: "existing", companyId: contact.companyId, via: "contact" };
    }
  }

  const senderDomain = sender === "" ? null : companyDomain(sender);
  if (senderDomain !== null) {
    const hit = index.companies.find((c) =>
      c.domains.some((d) => d.trim().toLowerCase() === senderDomain),
    );
    if (hit) return { kind: "existing", companyId: hit.id, via: "domain" };
  }

  const slug = input.jobUrl === null ? null : atsSlug(input.jobUrl);
  if (slug !== null) {
    const hit = index.companies.find((c) =>
      c.atsSlugs.some((s) => s.trim().toLowerCase() === slug),
    );
    if (hit) return { kind: "existing", companyId: hit.id, via: "ats_slug" };
  }

  const name = input.extractedName?.trim() ?? "";
  const normalized = normalizeCompanyName(name);
  if (normalized === "") return { kind: "none" };

  const byName = index.companies.find(
    (c) =>
      c.normalizedName === normalized ||
      c.aliases.some((a) => normalizeCompanyName(a) === normalized),
  );
  if (byName) return { kind: "existing", companyId: byName.id, via: "name" };

  const websiteDomain = websiteCompanyDomain(input.websiteDomain);
  const domains = [senderDomain, websiteDomain].filter(
    (d, i, all): d is string => d !== null && all.indexOf(d) === i,
  );
  return {
    kind: "new",
    company: {
      name,
      normalizedName: normalized,
      domains,
      atsSlugs: slug === null ? [] : [slug],
      websiteDomain,
    },
    possibleDuplicateOf: index.companies
      .filter((c) => isPossibleDuplicate(normalized, c.normalizedName))
      .map((c) => c.id),
  };
}

/** Ids of every company sharing `companyId`'s group root (root = groupId ?? id), itself included. */
export function groupMembers(companyId: string, companies: CompanyRef[]): Set<string> {
  const root = companies.find((c) => c.id === companyId);
  const rootId = root?.groupId ?? companyId;
  const members = new Set<string>([companyId]);
  for (const c of companies) if ((c.groupId ?? c.id) === rootId) members.add(c.id);
  return members;
}
