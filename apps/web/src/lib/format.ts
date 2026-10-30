import type { Lead } from "@offerbound/contracts";

/**
 * Display formats from DESIGN_SPEC §10: dates written out, a 24-hour clock in the owner's time
 * zone, relative times with plain words, compensation as `US$9.5–11k / month`.
 */

/** The owner's time zone until `GET /me` has answered (TECHNICAL_SPEC §2, `USER_TIMEZONE`). */
export const DEFAULT_TIMEZONE = "America/Monterrey";

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(options)}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options });
    dateFormats.set(key, f);
  }
  return f;
}

function toDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(d) : d;
}

/** "Fri, Oct 30" */
export function formatDate(d: Date | string, tz: string): string {
  return formatter(tz, { weekday: "short", month: "short", day: "numeric" }).format(toDate(d));
}

/** "Oct 27" */
export function formatShortDate(d: Date | string, tz: string): string {
  return formatter(tz, { month: "short", day: "numeric" }).format(toDate(d));
}

/** "10:00" on a 24-hour clock. */
export function formatTime(d: Date | string, tz: string): string {
  return formatter(tz, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(toDate(d));
}

/** "Oct 27, 14:12" */
export function formatDateTime(d: Date | string, tz: string): string {
  return `${formatShortDate(d, tz)}, ${formatTime(d, tz)}`;
}

/** The owner-local calendar day as `YYYY-MM-DD`, for comparing days. */
export function localDayKey(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(toDate(d));
}

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });

/** "2 days ago", "in 3 days", "just now". The absolute date belongs in a tooltip or caption. */
export function formatRelative(d: Date | string, now: Date): string {
  const seconds = Math.round((toDate(d).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  const sign = seconds < 0 ? -1 : 1;
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return relative.format(sign * minutes, "minute");
  const hours = Math.round(abs / 3600);
  if (hours < 24) return relative.format(sign * hours, "hour");
  const days = Math.round(abs / 86400);
  if (days < 14) return relative.format(sign * days, "day");
  if (days < 60) return relative.format(sign * Math.round(days / 7), "week");
  if (days < 365) return relative.format(sign * Math.round(days / 30), "month");
  return relative.format(sign * Math.round(days / 365), "year");
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "US$",
  EUR: "€",
  GBP: "£",
  MXN: "MX$",
  CAD: "CA$",
  AUD: "A$",
};

/** "9.5k", "11k", "850": thousands with at most one decimal. */
function amount(n: number): { text: string; thousands: boolean } {
  if (Math.abs(n) < 1000) return { text: String(Math.round(n)), thousands: false };
  const k = Math.round(n / 100) / 10;
  return { text: `${k}`, thousands: true };
}

/** "US$9.5–11k / month", "€95–110k / year"; null when no amount is known. */
export function formatCompensation(c: Lead["compensation"]): string | null {
  const { min, max } = c;
  if (min === null && max === null) return null;
  const code = c.currency;
  const symbol = code === null ? "" : (CURRENCY_SYMBOL[code] ?? `${code} `);
  const period = c.period === null ? "" : ` / ${c.period}`;
  const lo = min === null ? null : amount(min);
  const hi = max === null ? null : amount(max);

  let body: string;
  if (lo && hi) {
    if (min === max) {
      body = `${symbol}${lo.text}${lo.thousands ? "k" : ""}`;
    } else if (lo.thousands === hi.thousands) {
      body = `${symbol}${lo.text}–${hi.text}${hi.thousands ? "k" : ""}`;
    } else {
      body = `${symbol}${lo.text}${lo.thousands ? "k" : ""}–${hi.text}${hi.thousands ? "k" : ""}`;
    }
  } else if (lo) {
    body = `From ${symbol}${lo.text}${lo.thousands ? "k" : ""}`;
  } else if (hi) {
    body = `Up to ${symbol}${hi.text}${hi.thousands ? "k" : ""}`;
  } else {
    return null;
  }
  return `${body}${period}`;
}
