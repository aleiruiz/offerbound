import ICAL from "ical.js";
import { DateTime, IANAZone } from "luxon";
import type { IcsEvent } from "@offerbound/contracts";

/** Calendars come from untrusted email: cap how many events one file may yield. */
const MAX_EVENTS = 50;

const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]"]);

const HTTPS_LINK = /https:\/\/[^\s<>"'\\]+/i;

function textProp(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

function firstHttpsLink(description: string | null): string | null {
  if (description === null) return null;
  const match = HTTPS_LINK.exec(description);
  if (match === null) return null;
  // Drop punctuation that ends a sentence rather than the URL.
  // A backwards scan: a regex such as /[.,]+$/ is quadratic on a long run of punctuation.
  const raw = match[0];
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(raw.charAt(end - 1))) end -= 1;
  const link = raw.slice(0, end);
  return link.length <= "https://".length ? null : link;
}

function organizerOf(component: ICAL.Component): string | null {
  const value = textProp(component, "organizer");
  if (value === null) return null;
  const address = value.replace(/^mailto:/i, "").trim();
  return address === "" ? null : address.toLowerCase();
}

function isKnownIana(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/** ISO 8601 UTC for a DTSTART/DTEND property, or null when absent or unreadable. */
function timeOf(
  component: ICAL.Component,
  name: string,
): { iso: string | null; tzid: string | null } {
  const prop = component.getFirstProperty(name);
  if (prop === null) return { iso: null, tzid: null };
  const value = prop.getFirstValue() as unknown;
  if (!(value instanceof ICAL.Time)) return { iso: null, tzid: null };
  const tzidParam = prop.getParameter("tzid");
  const tzid = typeof tzidParam === "string" && tzidParam !== "" ? tzidParam : null;

  if (value.isDate) {
    return { iso: toIso(Date.UTC(value.year, value.month - 1, value.day)), tzid };
  }
  const wall = {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
  };
  if (tzid !== null && !ICAL.TimezoneService.has(tzid)) {
    // No VTIMEZONE in the file: ical.js cannot resolve IANA names, so use the platform's tz data.
    if (isKnownIana(tzid)) {
      const zoned = DateTime.fromObject(wall, { zone: tzid });
      return { iso: zoned.isValid ? zoned.toUTC().toISO() : null, tzid };
    }
    // A zone we cannot resolve (for example an Outlook name with no VTIMEZONE): leave the instant
    // unknown instead of guessing, so the calendar does not override a correct email body.
    return { iso: null, tzid };
  }
  const ms = value.toUnixTime() * 1000;
  return { iso: toIso(ms), tzid };
}

function toIso(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function methodOf(calendar: ICAL.Component, event: ICAL.Component): IcsEvent["method"] {
  // A cancelled event is a cancellation whatever METHOD says (some senders only set STATUS).
  if (textProp(event, "status")?.toUpperCase() === "CANCELLED") return "CANCEL";
  const method = textProp(calendar, "method")?.toUpperCase();
  if (method === "CANCEL") return "CANCEL";
  if (method === "REQUEST") return "REQUEST";
  return null;
}

function parseCalendar(calendar: ICAL.Component, out: IcsEvent[]): void {
  // Register every VTIMEZONE first so the event times can resolve their TZID.
  for (const vtimezone of calendar.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(vtimezone);
    } catch {
      // A malformed VTIMEZONE only affects events that use it.
    }
  }
  for (const event of calendar.getAllSubcomponents("vevent")) {
    if (out.length >= MAX_EVENTS) return;
    const start = timeOf(event, "dtstart");
    const end = timeOf(event, "dtend");
    out.push({
      uid: textProp(event, "uid"),
      method: methodOf(calendar, event),
      start: start.iso,
      end: end.iso,
      timezone: start.tzid ?? end.tzid,
      summary: textProp(event, "summary"),
      location: textProp(event, "location"),
      url: textProp(event, "url"),
      descriptionLink: firstHttpsLink(textProp(event, "description")),
      organizer: organizerOf(event),
    });
  }
}

/**
 * Parse an iCalendar document into one IcsEvent per VEVENT. Never throws: a document that
 * cannot be parsed yields no events. The caller bounds the input size (256 KB).
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  try {
    const parsed = ICAL.parse(text) as unknown;
    const jcals = (
      Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed : [parsed]
    ) as unknown[];
    for (const jcal of jcals) {
      const calendar = new ICAL.Component(jcal as unknown[]);
      if (calendar.name !== "vcalendar") continue;
      try {
        parseCalendar(calendar, events);
      } finally {
        // VTIMEZONEs belong to this calendar only.
        ICAL.TimezoneService.reset();
      }
    }
  } catch {
    // Untrusted input: report what was read so far.
  }
  return events;
}
