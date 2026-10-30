import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { loadEmailFixtures } from "../fixtures/emails.js";
import { FakeMailbox } from "./fake-mailbox.js";
import { loadSeed, shiftWallClock } from "./seed.js";
import { DAY_MS } from "./shift.js";

const TZ = "America/Monterrey";
const fixtures = loadEmailFixtures();
const demoFixtures = fixtures.filter((f) => f.demo);

describe("fixtures/demo/seed.json", () => {
  const seed = loadSeed();

  it("is valid and consistent", () => {
    // loadSeed validates the schema and every cross reference.
    expect(seed.applications.length).toBeGreaterThan(5);
    expect(seed.leads.length).toBeGreaterThan(4);
  });

  it("makes its messages and its walk from demo fixtures that carry an extraction", () => {
    const byId = new Map(demoFixtures.map((f) => [f.id, f]));
    const ids = [...seed.messages.map((m) => m.fixture), ...seed.mailbox.order];
    for (const id of ids) {
      const fixture = byId.get(id);
      expect(fixture, id).toBeDefined();
      expect(fixture?.llm.extraction, id).not.toBeNull();
    }
    // A fixture is either already in the mailbox or still to come, never both.
    const stored = new Set(seed.messages.map((m) => m.fixture));
    expect(seed.mailbox.order.filter((id) => stored.has(id))).toEqual([]);
  });

  it("names every company once, and keeps addresses on reserved example domains", () => {
    const names = seed.companies.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    // Fictional companies only (DS-9): addresses and sites live on reserved example domains.
    const hosts = [
      ...seed.companies.flatMap((c) => c.domains),
      ...seed.contacts.map((c) => c.email.split("@")[1] ?? ""),
      ...seed.leads.map((l) => new URL(l.jobUrl).hostname),
      ...seed.applications.flatMap((a) => (a.jobUrl === null ? [] : [new URL(a.jobUrl).hostname])),
    ];
    const allowedReal = /(ashbyhq\.com|lever\.co|greenhouse\.io|myworkdayjobs\.com)$/;
    for (const host of hosts) {
      expect(host.endsWith(".example") || allowedReal.test(host), host).toBe(true);
    }
  });

  it("holds no history after its anchor except interviews that lie ahead", () => {
    const anchor = Date.parse(seed.anchor);
    const ahead = seed.interviews.filter(
      (i) => i.startsAt !== null && Date.parse(i.startsAt) > anchor,
    );
    expect(ahead.length).toBeGreaterThan(0);
    const newest = Math.max(...seed.events.map((e) => Date.parse(e.at)));
    // The newest event is within the hour before the anchor (AC-16.2: data looks current).
    expect(anchor - newest).toBeGreaterThan(0);
    expect(anchor - newest).toBeLessThanOrEqual(3_600_000);
  });
});

describe("shiftWallClock", () => {
  const anchor = "2026-10-09T18:00:00.000Z";

  it("moves the date and keeps the time of day in the owner's zone", () => {
    // 10:00 in Monterrey (UTC-6), 24 days and 13 hours later.
    const moved = shiftWallClock(
      "2026-10-13T16:00:00.000Z",
      anchor,
      24 * DAY_MS + 13 * 3_600_000,
      TZ,
    );
    const local = DateTime.fromJSDate(moved, { zone: TZ });
    expect(local.toFormat("HH:mm")).toBe("10:00");
    expect(local.toISODate()).toBe("2026-11-07");
  });

  it("keeps an interview that lay ahead of the anchor ahead of the moved clock", () => {
    const delta = 24 * DAY_MS + 20 * 3_600_000;
    const authored = "2026-10-13T16:00:00.000Z";
    const plain = Date.parse(authored) + delta;
    expect(shiftWallClock(authored, anchor, delta, TZ).getTime()).toBeGreaterThanOrEqual(plain);
    expect(shiftWallClock(authored, anchor, delta, TZ).getTime() - plain).toBeLessThan(DAY_MS);
  });

  it("keeps one in the past behind it", () => {
    const delta = 24 * DAY_MS + 20 * 3_600_000;
    const authored = "2026-10-05T16:00:00.000Z";
    const plain = Date.parse(authored) + delta;
    expect(shiftWallClock(authored, anchor, delta, TZ).getTime()).toBeLessThanOrEqual(plain);
  });
});

describe("FakeMailbox", () => {
  const order = ["reschedule-ics-quarry-ai", "offer-arbor-analytics", "reject-tidewater-labs"];
  const mailbox = () => new FakeMailbox(demoFixtures, order);

  it("hands out the walk in order, skipping what the database already holds", () => {
    const box = mailbox();
    expect(box.nextId(new Set())).toBe("reschedule-ics-quarry-ai");
    expect(box.nextId(new Set(["reschedule-ics-quarry-ai"]))).toBe("offer-arbor-analytics");
    expect(box.nextId(new Set(["offer-arbor-analytics"]))).toBe("reschedule-ics-quarry-ai");
  });

  it("starts over with suffixed ids once every email is used", () => {
    const box = mailbox();
    const used = new Set(order);
    expect(box.nextId(used)).toBe("reschedule-ics-quarry-ai~2");
    used.add("reschedule-ics-quarry-ai~2");
    expect(box.nextId(used)).toBe("offer-arbor-analytics~2");
    for (const id of order) used.add(`${id}~2`);
    expect(box.nextId(used)).toBe("reschedule-ics-quarry-ai~3");
  });

  it("serves the delivered email dated at its arrival, and the originals until then", async () => {
    const box = mailbox();
    const original = await box.getMetadata("offer-arbor-analytics");
    expect(original.internalDate.toISOString()).toBe("2026-10-05T19:30:00.000Z");

    const now = new Date("2026-11-02T10:00:00.000Z");
    const delivered = box.deliverNext(new Set(["reschedule-ics-quarry-ai"]), now);
    expect(delivered.id).toBe("offer-arbor-analytics");
    expect((await box.getMetadata("offer-arbor-analytics")).internalDate).toEqual(now);
    const full = await box.getFull("offer-arbor-analytics");
    expect(full.id).toBe("offer-arbor-analytics");

    box.reset();
    expect((await box.getMetadata("offer-arbor-analytics")).internalDate.toISOString()).toBe(
      "2026-10-05T19:30:00.000Z",
    );
  });

  it("serves only fixtures marked demo, and refuses a walk that names anything else", () => {
    const real = fixtures.find((f) => !f.demo);
    expect(real).toBeDefined();
    expect(() => new FakeMailbox(fixtures, [real?.id ?? ""])).toThrow(/not there/);
    expect(
      mailbox()
        .fixtures()
        .every((f) => f.demo),
    ).toBe(true);
  });
});
