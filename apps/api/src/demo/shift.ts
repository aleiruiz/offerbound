import type { EmailFixture } from "@offerbound/contracts";

/**
 * Moving fixtures and seed data in time (TECHNICAL_SPEC §12): the demo shows fixed synthetic data
 * that has to look current, so every timestamp moves by the same distance. Pure.
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** A full ISO datetime, with `Z` or an offset: the shape every timestamp in the seed and fixtures has. */
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** The offset of an ISO string in minutes (`Z` is 0). */
function offsetMinutes(offset: string): number {
  if (offset === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
}

/**
 * Moves an ISO datetime by `deltaMs`, keeping its offset (an instant 3 days later is the same
 * wall-clock time in the same offset). Anything that is not such a datetime comes back as it was.
 */
export function shiftIso(value: string, deltaMs: number): string {
  const match = ISO_DATETIME.exec(value);
  if (!match) return value;
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const off = offsetMinutes(offset as string);
  const instant =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)) -
    off * 60_000;
  const shifted = new Date(instant + deltaMs + off * 60_000);
  const wall = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  // Keep the shape of the input: seconds and fraction only when it had them.
  const seconds = s === undefined ? "" : `:${pad(shifted.getUTCSeconds())}${frac ?? ""}`;
  return `${wall}${seconds}${offset}`;
}

/** Moves a calendar date (`YYYY-MM-DD`) by the whole days nearest to `deltaMs`. */
function shiftDate(value: string, deltaMs: number): string {
  const moved = new Date(Date.parse(`${value}T00:00:00Z`) + Math.round(deltaMs / DAY_MS) * DAY_MS);
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/**
 * Moves every ISO datetime and calendar date found as a string value anywhere in `value`
 * (objects, arrays), and returns a copy. Other strings, numbers and keys are untouched.
 */
export function shiftTimestamps<T>(value: T, deltaMs: number): T {
  if (typeof value === "string") {
    if (ISO_DATETIME.test(value)) return shiftIso(value, deltaMs) as T;
    if (ISO_DATE.test(value)) return shiftDate(value, deltaMs) as T;
    return value;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => shiftTimestamps<unknown>(item, deltaMs)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftTimestamps(item, deltaMs)]),
    ) as T;
  }
  return value;
}

/**
 * The distance to move a fixture that is delivered at `to` although it is dated `from`: rounded
 * up to whole weeks, so weekdays and times of day in its text and calendar stay true ("Friday
 * 9 October" is still a Friday) and an event that lay ahead of the email still lies ahead of it.
 */
export function weekAlignedDelta(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / WEEK_MS)) * WEEK_MS;
}

// --- text ----------------------------------------------------------------------------------------

const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** A reference year for day arithmetic (not a leap year). */
const REF_YEAR = 2025;

function moveDay(month: number, day: number, days: number): { month: number; day: number } {
  const moved = new Date(Date.UTC(REF_YEAR, month, day));
  moved.setUTCDate(moved.getUTCDate() + days);
  return { month: moved.getUTCMonth(), day: moved.getUTCDate() };
}

/**
 * Moves "17 September", "September 17", "17th September" and the Spanish "17 de septiembre" by
 * `days`. A text that names a date without a month ("next Tuesday") is left alone.
 */
export function shiftDatePhrases(text: string, days: number): string {
  if (days === 0) return text;
  const en = MONTHS_EN.join("|");
  const es = MONTHS_ES.join("|");
  return text
    .replace(
      new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)?(\\s+)(${en})\\b`, "g"),
      (_all, d: string, suffix: string | undefined, space: string, month: string) => {
        const moved = moveDay(MONTHS_EN.indexOf(month), Number(d), days);
        return `${moved.day}${suffix ?? ""}${space}${MONTHS_EN[moved.month]}`;
      },
    )
    .replace(
      new RegExp(`\\b(${en})(\\s+)(\\d{1,2})(st|nd|rd|th)?\\b`, "g"),
      (_all, month: string, space: string, d: string, suffix: string | undefined) => {
        const moved = moveDay(MONTHS_EN.indexOf(month), Number(d), days);
        return `${MONTHS_EN[moved.month]}${space}${moved.day}${suffix ?? ""}`;
      },
    )
    .replace(
      new RegExp(`\\b(\\d{1,2})(\\s+de\\s+)(${es})\\b`, "g"),
      (_all, d: string, de: string, month: string) => {
        const moved = moveDay(MONTHS_ES.indexOf(month), Number(d), days);
        return `${moved.day}${de}${MONTHS_ES[moved.month]}`;
      },
    );
}

/** `DTSTART:20260917T160000Z`-style lines (UTC only) moved by `deltaMs`; other lines are kept. */
export function shiftIcs(ics: string, deltaMs: number): string {
  return ics.replace(
    /^(DTSTART|DTEND|DTSTAMP|RECURRENCE-ID)([^:\r\n]*):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/gm,
    (
      _line,
      name: string,
      params: string,
      y: string,
      mo: string,
      d: string,
      h: string,
      mi: string,
      s: string,
    ) => {
      const moved = shiftIso(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`, deltaMs);
      return `${name}${params}:${moved.replace(/[-:]/g, "")}`;
    },
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = MONTHS_EN.map((m) => m.slice(0, 3));

/** `Mon, 05 Oct 2026 10:00:00 +0000`, the form of a `Date` header. */
export function rfc2822(date: Date): string {
  return `${WEEKDAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${
    SHORT_MONTHS[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )} +0000`;
}

/**
 * A fixture as if it arrived at `arrivesAt`. The message itself is dated `arrivesAt`; everything
 * it says about other times (interview and deadline in the extraction, the calendar file, dates
 * written in the text) moves by `deltaMs`, so an interview the email proposes still lies ahead.
 * `id` replaces the fixture's own when given (a fixture delivered a second time); the thread stays,
 * so the message still lands in the thread its first delivery linked.
 */
export function deliverFixture(
  fixture: EmailFixture,
  opts: { arrivesAt: Date; deltaMs: number; id?: string },
): EmailFixture {
  const { arrivesAt, deltaMs } = opts;
  const days = Math.round(deltaMs / DAY_MS);
  const text = (value: string): string => shiftDatePhrases(value, days);
  const id = opts.id ?? fixture.id;
  const moved = shiftTimestamps(fixture.llm.extraction, deltaMs);
  const extraction = moved === null ? null : { ...moved, summary: text(moved.summary) };
  return {
    ...fixture,
    id,
    internalDate: arrivesAt.toISOString(),
    headers: {
      ...fixture.headers,
      subject: text(fixture.headers.subject),
      date: rfc2822(arrivesAt),
    },
    snippet: text(fixture.snippet),
    ...(fixture.bodyText === undefined ? {} : { bodyText: text(fixture.bodyText) }),
    ...(fixture.bodyHtml === undefined ? {} : { bodyHtml: text(fixture.bodyHtml) }),
    ...(fixture.ics === undefined ? {} : { ics: shiftIcs(fixture.ics, deltaMs) }),
    expected: {
      ...fixture.expected,
      ...(fixture.expected.interviewStart === undefined
        ? {}
        : { interviewStart: shiftIso(fixture.expected.interviewStart, deltaMs) }),
    },
    llm: {
      triage:
        fixture.llm.triage === null || id === fixture.id
          ? fixture.llm.triage
          : { ...fixture.llm.triage, id },
      extraction,
    },
  };
}
