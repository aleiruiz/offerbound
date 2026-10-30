import { describe, expect, it } from "vitest";
import { dayRangeUtc, localMidnightUtc, ownerLocalDay } from "./time.js";

const TZ = "America/Monterrey";

describe("ownerLocalDay", () => {
  it("keeps 23:30 local on the same day", () => {
    expect(ownerLocalDay(new Date("2026-10-30T05:30:00Z"), TZ)).toBe("2026-10-29");
  });

  it("rolls over at local midnight", () => {
    expect(ownerLocalDay(new Date("2026-10-30T06:00:00Z"), TZ)).toBe("2026-10-30");
  });

  it("rejects an unknown time zone", () => {
    expect(() => ownerLocalDay(new Date("2026-10-30T06:00:00Z"), "Not/AZone")).toThrow(RangeError);
  });
});

describe("localMidnightUtc", () => {
  it("returns local midnight as a UTC instant", () => {
    expect(localMidnightUtc("2026-10-05", TZ).toISOString()).toBe("2026-10-05T06:00:00.000Z");
  });

  it("throws RangeError for an invalid day", () => {
    expect(() => localMidnightUtc("2026-13-01", TZ)).toThrow(RangeError);
  });

  it("throws RangeError for a malformed day", () => {
    expect(() => localMidnightUtc("10/05/2026", TZ)).toThrow(RangeError);
  });

  it("throws RangeError for an unknown time zone", () => {
    expect(() => localMidnightUtc("2026-10-05", "Not/AZone")).toThrow(RangeError);
  });
});

describe("dayRangeUtc", () => {
  it("spans local midnight to the next local midnight", () => {
    const { start, end } = dayRangeUtc("2026-10-29", TZ);
    expect(start.toISOString()).toBe("2026-10-29T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-30T06:00:00.000Z");
  });

  it("is 23 hours on a spring-forward day", () => {
    const { start, end } = dayRangeUtc("2026-03-08", "America/New_York");
    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
  });
});
