import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** Longest company name sent out as an exclusion, and the longest any pasted text field keeps. */
export const EXCLUSION_NAME_MAX_CHARS = 120;

/**
 * Text that is safe to put in a prompt or a list: control and format characters removed
 * (zero-width and bidirectional marks, line and paragraph separators), trimmed, at most
 * `maxChars` long and never ending on half a surrogate pair. Company names come from stored
 * records and from model output, which is untrusted (SECURITY §9). Returns null when nothing is
 * left.
 */
export function cleanText(raw: string, maxChars: number): string | null {
  let clean = raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
  if (clean.length > maxChars) {
    clean = clean.slice(0, maxChars);
    const last = clean.charCodeAt(clean.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1);
    clean = clean.trim();
  }
  return clean === "" ? null : clean;
}

/** A company name that is safe to list (`cleanText` at 120 characters). */
export const cleanName = (name: string): string | null => cleanText(name, EXCLUSION_NAME_MAX_CHARS);

export type SeenCompany = {
  id: string;
  name: string;
  aliases: string[];
  groupId: string | null;
  createdAt: Date;
};

/**
 * Every company the owner has already seen: any company with a lead or application, plus the other
 * members of its corporate group (AC-10.3). This is the one query behind both the search
 * exclusions and the copyable list.
 */
export async function loadSeenCompanies(db: Db): Promise<SeenCompany[]> {
  const [withLead, withApp, companies] = await Promise.all([
    db.lead.findMany({ distinct: ["companyId"], select: { companyId: true } }),
    db.application.findMany({ distinct: ["companyId"], select: { companyId: true } }),
    db.company.findMany({
      select: { id: true, name: true, aliases: true, groupId: true, createdAt: true },
    }),
  ]);
  const seen = new Set([...withLead, ...withApp].map((row) => row.companyId));
  const rootOf = (c: { id: string; groupId: string | null }): string => c.groupId ?? c.id;
  const seenRoots = new Set(companies.filter((c) => seen.has(c.id)).map(rootOf));
  return companies.filter((c) => seenRoots.has(rootOf(c)));
}

/**
 * The plain-text list of companies already seen (AC-9.5): one company name per line, its aliases
 * on the lines below, indented by two spaces. Every seen company is listed, with no cap. Groups
 * are kept together, the group with the newest company first and its root company before the others, then by name. Names are cleaned
 * (`cleanName`), so a line never holds a control character; a company with no usable name is left
 * out and an alias equal to its company's name is not repeated. Empty when nothing was seen yet.
 */
export async function exclusionListText(db: Db): Promise<string> {
  const companies = await loadSeenCompanies(db);
  const rootOf = (c: SeenCompany): string => c.groupId ?? c.id;
  const newestOfGroup = new Map<string, number>();
  for (const c of companies) {
    newestOfGroup.set(
      rootOf(c),
      Math.max(newestOfGroup.get(rootOf(c)) ?? 0, c.createdAt.getTime()),
    );
  }
  const ordered = [...companies].sort(
    (a, b) =>
      (newestOfGroup.get(rootOf(b)) ?? 0) - (newestOfGroup.get(rootOf(a)) ?? 0) ||
      rootOf(a).localeCompare(rootOf(b)) ||
      Number(a.groupId !== null) - Number(b.groupId !== null) ||
      a.name.localeCompare(b.name),
  );

  const lines: string[] = [];
  const listed = new Set<string>();
  for (const company of ordered) {
    const name = cleanName(company.name);
    if (name === null || listed.has(name.toLowerCase())) continue;
    listed.add(name.toLowerCase());
    lines.push(name);
    const aliases = new Set<string>();
    for (const raw of company.aliases) {
      const alias = cleanName(raw);
      if (alias !== null && alias.toLowerCase() !== name.toLowerCase()) aliases.add(alias);
    }
    for (const alias of [...aliases].sort((a, b) => a.localeCompare(b))) lines.push(`  ${alias}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
