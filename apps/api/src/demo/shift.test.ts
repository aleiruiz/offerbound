import { describe, expect, it } from "vitest";
import { loadEmailFixtures } from "../fixtures/emails.js";
import {
  DAY_MS,
  WEEK_MS,
  deliverFixture,
  rfc2822,
  shiftDatePhrases,
  shiftIcs,
  shiftIso,
  shiftTimestamps,
  weekAlignedDelta,
} from "./shift.js";

describe("shiftIso", () => {
  it("moves the instant and keeps the offset", () => {
    expect(shiftIso("2026-09-17T10:00:00-06:00", 2 * DAY_MS)).toBe("2026-09-19T10:00:00-06:00");
    expect(shiftIso("2026-09-17T16:00:00.000Z", DAY_MS)).toBe("2026-09-18T16:00:00.000Z");
    expect(shiftIso("2026-09-17T16:00Z", 3_600_000)).toBe("2026-09-17T17:00Z");
  });

  it("crosses month and year ends", () => {
    expect(shiftIso("2026-12-31T23:30:00Z", 3_600_000)).toBe("2027-01-01T00:30:00Z");
  });

  it("leaves text that is not a datetime alone", () => {
    expect(shiftIso("next Tuesday", DAY_MS)).toBe("next Tuesday");
  });
});

describe("shiftTimestamps", () => {
  it("moves datetimes and dates anywhere in a structure, and nothing else", () => {
    const moved = shiftTimestamps(
      {
        at: "2026-10-01T12:00:00.000Z",
        nested: [{ day: "2026-10-01", name: "Quarry AI", n: 3 }],
        none: null,
      },
      2 * DAY_MS,
    );
    expect(moved).toEqual({
      at: "2026-10-03T12:00:00.000Z",
      nested: [{ day: "2026-10-03", name: "Quarry AI", n: 3 }],
      none: null,
    });
  });
});

describe("weekAlignedDelta", () => {
  it("rounds up to whole weeks and never goes negative", () => {
    const from = new Date("2026-09-14T14:05:00Z");
    expect(weekAlignedDelta(from, new Date("2026-09-14T14:05:01Z"))).toBe(WEEK_MS);
    expect(weekAlignedDelta(from, new Date("2026-09-28T14:05:00Z"))).toBe(2 * WEEK_MS);
    expect(weekAlignedDelta(from, new Date("2026-09-01T00:00:00Z"))).toBe(0);
  });
});

describe("shiftDatePhrases", () => {
  it("moves day-month phrases in English and Spanish", () => {
    expect(shiftDatePhrases("on 17 September at 10:00", 14)).toBe("on 1 October at 10:00");
    expect(shiftDatePhrases("by Friday 9 October", 14)).toBe("by Friday 23 October");
    expect(shiftDatePhrases("on September 17th", 7)).toBe("on September 24th");
    expect(shiftDatePhrases("el 17 de septiembre", 14)).toBe("el 1 de octubre");
  });

  it("leaves relative dates alone", () => {
    expect(shiftDatePhrases("next Tuesday 3pm EST", 14)).toBe("next Tuesday 3pm EST");
  });
});

describe("shiftIcs", () => {
  it("moves the UTC times and keeps the UID", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:quarry-int-0917-a1@quarry-ai.example",
      "DTSTAMP:20260910T172000Z",
      "DTSTART:20260917T160000Z",
      "DTEND:20260917T170000Z",
      "END:VEVENT",
    ].join("\r\n");
    const moved = shiftIcs(ics, WEEK_MS);
    expect(moved).toContain("UID:quarry-int-0917-a1@quarry-ai.example");
    expect(moved).toContain("DTSTART:20260924T160000Z");
    expect(moved).toContain("DTEND:20260924T170000Z");
    expect(moved).toContain("DTSTAMP:20260917T172000Z");
  });
});

describe("rfc2822", () => {
  it("writes the Date header form", () => {
    expect(rfc2822(new Date("2026-10-05T10:00:00Z"))).toBe("Mon, 05 Oct 2026 10:00:00 +0000");
  });
});

describe("deliverFixture", () => {
  const demo = loadEmailFixtures().filter((f) => f.demo);

  it("dates the message at its arrival and moves the interview with the delta", () => {
    const fixture = demo.find((f) => f.id === "reschedule-ics-quarry-ai");
    if (!fixture) throw new Error("fixture missing");
    const arrivesAt = new Date("2026-11-02T09:30:00Z");
    const delta = weekAlignedDelta(new Date(fixture.internalDate), arrivesAt);
    const delivered = deliverFixture(fixture, { arrivesAt, deltaMs: delta });

    expect(delivered.internalDate).toBe("2026-11-02T09:30:00.000Z");
    expect(delivered.headers.date).toBe("Mon, 02 Nov 2026 09:30:00 +0000");
    const start = delivered.llm.extraction?.interview?.startsAt;
    expect(start).toBeDefined();
    // Still ahead of the arrival, and the same weekday and hour as the original (11:00 -06:00).
    expect(new Date(start as string).getTime()).toBeGreaterThan(arrivesAt.getTime());
    expect(start).toMatch(/T11:00:00-06:00$/);
    expect(delivered.ics).toContain("UID:quarry-int-0917-a1@quarry-ai.example");
    expect(delivered.ics).not.toContain("20260918T170000Z");
    // The text says the same date as the calendar.
    expect(delivered.llm.extraction?.summary).not.toContain("18 September");
  });

  it("gives a second delivery its own id, in the triage verdict too", () => {
    const fixture = demo.find((f) => f.llm.triage !== null);
    if (!fixture) throw new Error("fixture missing");
    const delivered = deliverFixture(fixture, {
      arrivesAt: new Date("2026-11-02T09:30:00Z"),
      deltaMs: WEEK_MS,
      id: `${fixture.id}~2`,
    });
    expect(delivered.id).toBe(`${fixture.id}~2`);
    expect(delivered.llm.triage?.id).toBe(`${fixture.id}~2`);
  });
});
