import { describe, expect, it } from "vitest";
import { parseIcs } from "./ics.js";

const lines = (...l: string[]): string => l.join("\r\n") + "\r\n";

const NY_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:STANDARD",
  "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

describe("parseIcs", () => {
  it("converts DTSTART;TZID=America/New_York:20261103T150000 to 2026-11-03T20:00:00.000Z", () => {
    // With the VTIMEZONE in the file ...
    const withTz = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      ...NY_TZ,
      "BEGIN:VEVENT",
      "UID:a@quarry.example",
      "DTSTART;TZID=America/New_York:20261103T150000",
      "DTEND;TZID=America/New_York:20261103T160000",
      "SUMMARY:Screen",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [event] = parseIcs(withTz);
    expect(event?.start).toBe("2026-11-03T20:00:00.000Z");
    expect(event?.end).toBe("2026-11-03T21:00:00.000Z");
    expect(event?.timezone).toBe("America/New_York");

    // ... and without it (many senders omit VTIMEZONE for IANA names)
    const withoutTz = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:b@quarry.example",
      "DTSTART;TZID=America/New_York:20261103T150000",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [bare] = parseIcs(withoutTz);
    expect(bare?.start).toBe("2026-11-03T20:00:00.000Z");
    expect(bare?.end).toBeNull();
  });

  it("uses a VTIMEZONE that overrides the zone name, and registers every one of them", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Custom Zone A",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0200",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VTIMEZONE",
      "TZID:Custom Zone B",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:-0300",
      "TZOFFSETTO:-0300",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:c1",
      "DTSTART;TZID=Custom Zone A:20261103T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:c2",
      "DTSTART;TZID=Custom Zone B:20261103T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const events = parseIcs(text);
    expect(events.map((e) => e.start)).toEqual([
      "2026-11-03T08:00:00.000Z",
      "2026-11-03T13:00:00.000Z",
    ]);
  });

  it("reads METHOD:CANCEL, UID, LOCATION, URL, ORGANIZER and the first https link in DESCRIPTION", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:evt-77@quarry.example",
      "DTSTART:20261104T170000Z",
      "DTEND:20261104T173000Z",
      "SUMMARY:Technical interview",
      "LOCATION:Room 4\\, Quarry HQ",
      "URL:https://quarry.example/interviews/77",
      "ORGANIZER;CN=Ana Perez:mailto:Ana@Quarry.example",
      "DESCRIPTION:Join us.\\nDocs: http://old.example/x then https://meet.quarry.example/r/77.",
      "  Thanks\\, see you! https://other.example/y",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    expect(parseIcs(text)).toEqual([
      {
        uid: "evt-77@quarry.example",
        method: "CANCEL",
        start: "2026-11-04T17:00:00.000Z",
        end: "2026-11-04T17:30:00.000Z",
        timezone: null,
        summary: "Technical interview",
        location: "Room 4, Quarry HQ",
        url: "https://quarry.example/interviews/77",
        descriptionLink: "https://meet.quarry.example/r/77",
        organizer: "ana@quarry.example",
      },
    ]);
  });

  it("returns nulls for missing properties and null method for PUBLISH", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "SUMMARY:Bare",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    expect(parseIcs(text)).toEqual([
      {
        uid: null,
        method: null,
        start: null,
        end: null,
        timezone: null,
        summary: "Bare",
        location: null,
        url: null,
        descriptionLink: null,
        organizer: null,
      },
    ]);
  });

  it("treats STATUS:CANCELLED as a cancellation when no METHOD says so", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:s1",
      "STATUS:CANCELLED",
      "DTSTART:20261104T170000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    expect(parseIcs(text)[0]?.method).toBe("CANCEL");
  });

  it("returns every VEVENT and reads date-only starts as UTC midnight", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:1",
      "DTSTART;VALUE=DATE:20261105",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:2",
      "DTSTART:20261106T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const events = parseIcs(text);
    expect(events.map((e) => e.uid)).toEqual(["1", "2"]);
    expect(events[0]?.start).toBe("2026-11-05T00:00:00.000Z");
  });

  it("returns an empty list for garbage, empty input or a calendar without events", () => {
    expect(parseIcs("")).toEqual([]);
    expect(parseIcs("not a calendar at all")).toEqual([]);
    expect(parseIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")).toEqual([]);
  });

  it("leaves the instant unknown for a TZID that is neither registered nor a real zone", () => {
    for (const tzid of ["Not/AZone", "Eastern Standard Time", "local", "UTC+3"]) {
      const text = lines(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:z",
        `DTSTART;TZID=${tzid}:20261103T150000`,
        `DTEND;TZID=${tzid}:20261103T160000`,
        "END:VEVENT",
        "END:VCALENDAR",
      );
      const [event] = parseIcs(text);
      expect(event?.uid).toBe("z");
      expect(event?.timezone).toBe(tzid);
      expect(event?.start).toBeNull();
      expect(event?.end).toBeNull();
    }
  });

  it("lets STATUS:CANCELLED win over METHOD:REQUEST", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:s2",
      "STATUS:CANCELLED",
      "DTSTART:20261104T170000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    expect(parseIcs(text)[0]?.method).toBe("CANCEL");
  });

  it("trims sentence punctuation from the description link", () => {
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:p",
      "DESCRIPTION:Join (https://meet.quarry.example/r/1).",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    expect(parseIcs(text)[0]?.descriptionLink).toBe("https://meet.quarry.example/r/1");
  });

  it("stays fast on a description that is mostly punctuation", () => {
    const started = Date.now();
    const text = lines(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:dos",
      // a 200k character run, folded into 70-character lines like a real file
      ...foldedProperty("DESCRIPTION", "https://" + ".".repeat(200_000)),
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [event] = parseIcs(text);
    expect(event?.descriptionLink).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

function foldedProperty(name: string, value: string): string[] {
  const out: string[] = [];
  const full = `${name}:${value}`;
  for (let i = 0; i < full.length; i += 70) {
    out.push((i === 0 ? "" : " ") + full.slice(i, i + 70));
  }
  return out;
}
