import { DateTime } from "luxon";

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function requireZone(tz: string): void {
  if (!DateTime.local().setZone(tz).isValid) {
    throw new RangeError(`Invalid time zone: ${tz}`);
  }
}

function parseLocalDay(day: string, tz: string): DateTime {
  requireZone(tz);
  const parsed = DAY_FORMAT.test(day) ? DateTime.fromISO(day, { zone: tz }) : null;
  if (!parsed?.isValid) {
    throw new RangeError(`Invalid day (expected YYYY-MM-DD): ${day}`);
  }
  return parsed.startOf("day");
}

/** The owner's calendar day (`YYYY-MM-DD`) that contains `instant`. */
export function ownerLocalDay(instant: Date, tz: string): string {
  requireZone(tz);
  const local = DateTime.fromJSDate(instant, { zone: tz });
  if (!local.isValid) {
    throw new RangeError("Invalid instant");
  }
  return local.toFormat("yyyy-MM-dd");
}

/** The UTC instant of local midnight at the start of `day` in `tz`. */
export function localMidnightUtc(day: string, tz: string): Date {
  return parseLocalDay(day, tz).toUTC().toJSDate();
}

/** The half-open UTC range `[start, end)` covering local day `day` in `tz`. */
export function dayRangeUtc(day: string, tz: string): { start: Date; end: Date } {
  const start = parseLocalDay(day, tz);
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() };
}
