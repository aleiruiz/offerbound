import { describe, expect, it } from "vitest";
import {
  formatCompensation,
  formatDate,
  formatLongDay,
  formatRelative,
  formatShortDate,
  formatTime,
  localDayKey,
  localMidnightIso,
  localTimeIso,
  zoneCity,
} from "./format";

const TZ = "America/Monterrey";
const comp = {
  min: null,
  max: null,
  currency: "USD",
  period: "month" as const,
  isEstimate: false,
  basis: null,
};

describe("formatCompensation", () => {
  it("writes monthly dollars as US$9.5–11k / month", () => {
    expect(
      formatCompensation({ ...comp, min: 9500, max: 11000, currency: "USD", period: "month" }),
    ).toBe("US$9.5–11k / month");
  });

  it("writes yearly euros as €95–110k / year", () => {
    expect(
      formatCompensation({ ...comp, min: 95000, max: 110000, currency: "EUR", period: "year" }),
    ).toBe("€95–110k / year");
  });

  it("handles one-sided, single, small and unknown values", () => {
    expect(formatCompensation({ ...comp, min: 9500, max: null })).toBe("From US$9.5k / month");
    expect(formatCompensation({ ...comp, min: null, max: 11000 })).toBe("Up to US$11k / month");
    expect(formatCompensation({ ...comp, min: 10000, max: 10000 })).toBe("US$10k / month");
    expect(formatCompensation({ ...comp, min: 85, max: 95, period: "hour" })).toBe(
      "US$85–95 / hour",
    );
    expect(
      formatCompensation({ ...comp, min: 90000, max: 100000, currency: "MXN", period: null }),
    ).toBe("MX$90–100k");
    expect(
      formatCompensation({ ...comp, min: 90000, max: 100000, currency: "CHF", period: "year" }),
    ).toBe("CHF 90–100k / year");
    expect(formatCompensation(comp)).toBeNull();
  });
});

describe("date and time formatting in the owner's time zone", () => {
  it("formats 2026-10-30T16:00:00Z in America/Monterrey as Fri, Oct 30 at 10:00", () => {
    expect(formatDate("2026-10-30T16:00:00Z", TZ)).toBe("Fri, Oct 30");
    expect(formatShortDate("2026-10-27T16:00:00Z", TZ)).toBe("Oct 27");
    expect(formatTime("2026-10-30T16:00:00Z", TZ)).toBe("10:00");
  });

  it("uses the owner's day, not UTC's, and a 24-hour clock", () => {
    expect(formatDate(new Date("2026-10-31T05:30:00Z"), TZ)).toBe("Fri, Oct 30");
    expect(formatTime("2026-10-30T06:05:00Z", TZ)).toBe("00:05");
    expect(formatTime("2026-10-30T23:00:00Z", TZ)).toBe("17:00");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  it("says 2 days ago, in 3 days, 5 hours ago, and just now", () => {
    expect(formatRelative("2026-10-28T12:00:00Z", now)).toBe("2 days ago");
    expect(formatRelative("2026-11-02T12:00:00Z", now)).toBe("in 3 days");
    expect(formatRelative("2026-10-30T07:00:00Z", now)).toBe("5 hours ago");
    expect(formatRelative("2026-10-30T11:50:00Z", now)).toBe("10 minutes ago");
    expect(formatRelative("2026-10-30T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-30T12:00:20Z", now)).toBe("just now");
  });
  it("uses weeks and months for older dates", () => {
    expect(formatRelative("2026-10-09T12:00:00Z", now)).toBe("3 weeks ago");
    expect(formatRelative("2026-08-30T12:00:00Z", now)).toBe("2 months ago");
  });
});

describe("localDayKey", () => {
  it("is the owner-local day: 23:30 in Monterrey is still the same day", async () => {
    const { localDayKey } = await import("./format");
    expect(localDayKey("2026-10-31T05:30:00Z", TZ)).toBe("2026-10-30");
    expect(localDayKey("2026-10-31T06:00:00Z", TZ)).toBe("2026-10-31");
  });
});

describe("formatLongDay and zoneCity", () => {
  it("writes an owner-local day out, whatever the machine's zone", () => {
    expect(formatLongDay("2026-10-29")).toBe("Thursday, October 29");
    expect(formatLongDay("not a day")).toBeNull();
    expect(formatLongDay("2026-13-40")).toBeNull();
  });

  it("names the city of an IANA zone", () => {
    expect(zoneCity("America/Monterrey")).toBe("Monterrey");
    expect(zoneCity("America/Mexico_City")).toBe("Mexico City");
    expect(zoneCity("UTC")).toBe("UTC");
  });
});

describe("localMidnightIso", () => {
  it("is the instant a calendar day begins in the owner's zone (UTC-6 all year in Monterrey)", () => {
    expect(localMidnightIso("2026-10-05", TZ)).toBe("2026-10-05T06:00:00.000Z");
    expect(localMidnightIso("2026-01-15", TZ)).toBe("2026-01-15T06:00:00.000Z");
    expect(localDayKey(localMidnightIso("2026-10-05", TZ)!, TZ)).toBe("2026-10-05");
  });

  it("follows a zone that observes daylight saving time", () => {
    expect(localMidnightIso("2026-07-01", "America/New_York")).toBe("2026-07-01T04:00:00.000Z");
    expect(localMidnightIso("2026-12-01", "America/New_York")).toBe("2026-12-01T05:00:00.000Z");
    expect(localMidnightIso("2026-07-01", "Europe/Madrid")).toBe("2026-06-30T22:00:00.000Z");
  });

  it("is null for anything that is not a calendar day", () => {
    expect(localMidnightIso("", TZ)).toBeNull();
    expect(localMidnightIso("2026-13-40", TZ)).toBeNull();
    expect(localMidnightIso("Oct 5", TZ)).toBeNull();
  });
});

describe("localTimeIso", () => {
  it("is the instant a wall-clock time falls on in the owner's zone", () => {
    expect(localTimeIso("2026-11-05", "10:00", TZ)).toBe("2026-11-05T16:00:00.000Z");
    expect(localTimeIso("2026-11-05", "23:30", TZ)).toBe("2026-11-06T05:30:00.000Z");
    expect(localTimeIso("2026-11-05", "00:00", TZ)).toBe(localMidnightIso("2026-11-05", TZ));
  });

  it("follows a zone that observes daylight saving time", () => {
    expect(localTimeIso("2026-07-01", "09:00", "America/New_York")).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(localTimeIso("2026-12-01", "09:00", "America/New_York")).toBe(
      "2026-12-01T14:00:00.000Z",
    );
  });

  it("is null for a day or a time that is not real", () => {
    expect(localTimeIso("", "10:00", TZ)).toBeNull();
    expect(localTimeIso("2026-11-05", "", TZ)).toBeNull();
    expect(localTimeIso("2026-11-05", "24:00", TZ)).toBeNull();
    expect(localTimeIso("2026-11-05", "9:5", TZ)).toBeNull();
    expect(localTimeIso("2026-11-31", "10:00", TZ)).toBeNull();
  });
});
