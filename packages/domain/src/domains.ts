import { getDomain } from "tldts";

/** ATS sender domains, matched on the registrable domain (TECHNICAL_SPEC §5.3). */
export const ATS_DOMAINS: readonly string[] = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "workable.com",
  "workablemail.com",
  "personio.com",
  "personio.de",
  "icims.com",
  "jobvite.com",
  "bamboohr.com",
  "recruitee.com",
  "teamtailor.com",
  "hirehive.com",
  "successfactors.com",
  "taleo.net",
  "breezy.hr",
  "pinpointhq.com",
  "rippling.com", // only senders on the host ats.rippling.com count; see isAtsSender
  "dover.com",
  "gem.com",
];

/** Host that makes a rippling.com sender an ATS sender. */
const RIPPLING_ATS_HOST = "ats.rippling.com";

/** Job-alert senders (TECHNICAL_SPEC §5.3). Matched on the full address. */
export const JOB_ALERT_SENDERS: readonly string[] = [
  "jobalerts-noreply@linkedin.com",
  "jobs-noreply@linkedin.com",
  "jobs-listings@linkedin.com",
  "alert@indeed.com",
  "noreply@indeed.com",
  "noreply@glassdoor.com",
  "alerts@glassdoor.com",
  "noreply@wellfound.com",
  "talent@otta.com",
  "noreply@welcometothejungle.com",
];

/** Personal mailbox providers; never a company domain (TECHNICAL_SPEC §6.2). */
export const GENERIC_MAILBOX_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
];

/** Job boards; never a company domain. */
export const JOB_BOARD_DOMAINS: readonly string[] = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "wellfound.com",
  "otta.com",
  "welcometothejungle.com",
];

/**
 * Lower-cased address from `a@b`, `Name <a@b>` or a bare host. Returns "" when empty.
 */
export function bareAddress(value: string): string {
  const trimmed = value.trim();
  const angle = /<([^<>]*)>\s*$/.exec(trimmed);
  return (angle?.[1] ?? trimmed).trim().toLowerCase();
}

/** Host part of an address (text after the last "@"), or the input itself when it has none. */
export function hostOf(hostOrEmail: string): string {
  const addr = bareAddress(hostOrEmail);
  const at = addr.lastIndexOf("@");
  return at === -1 ? addr : addr.slice(at + 1);
}

/** Registrable domain (tldts `getDomain`) of a host or an email address; null when there is none. */
export function registrableDomain(hostOrEmail: string): string | null {
  const host = hostOf(hostOrEmail);
  if (host === "" || /\s/.test(host)) return null;
  return getDomain(host)?.toLowerCase() ?? null;
}

/** True when `domain` is a personal mailbox, ATS or job-board domain, which no company may own. */
export function isNonCompanyDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (
    GENERIC_MAILBOX_DOMAINS.includes(d) || ATS_DOMAINS.includes(d) || JOB_BOARD_DOMAINS.includes(d)
  );
}

/** True when the sender's registrable domain is an ATS domain (rippling.com only on ats.rippling.com). */
export function isAtsSender(email: string): boolean {
  const domain = registrableDomain(email);
  if (domain === null || !ATS_DOMAINS.includes(domain)) return false;
  if (domain === "rippling.com") {
    const host = hostOf(email);
    return host === RIPPLING_ATS_HOST || host.endsWith(`.${RIPPLING_ATS_HOST}`);
  }
  return true;
}
