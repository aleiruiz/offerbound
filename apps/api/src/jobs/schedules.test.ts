import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { describe, expect, it } from "vitest";
import { RecordingQueue } from "../../test/queue.js";
import { registerSchedules, schedulesFor } from "./boss.js";

const COMMON = [
  { name: "email.triage", cron: "* * * * *" },
  { name: "email.apply", cron: "* * * * *" },
  { name: "timers.tick", cron: "*/15 * * * *" },
  { name: "maintenance.daily", cron: "0 4 * * *" },
];

describe("schedulesFor", () => {
  it("schedulesFor('private') and schedulesFor('demo') return the lists above", () => {
    expect(schedulesFor("private", DEFAULT_SETTINGS)).toEqual([
      COMMON[0],
      COMMON[1],
      COMMON[2],
      { name: "backup.nightly", cron: "30 3 * * *" },
      COMMON[3],
      { name: "leads.recheck", cron: "30 4 * * *" },
    ]);
    expect(schedulesFor("demo", DEFAULT_SETTINGS)).toEqual([
      COMMON[0],
      COMMON[1],
      COMMON[2],
      { name: "demo.reset", cron: "0 * * * *" },
      COMMON[3],
    ]);
  });

  it("leaves gmail.sync and search.run to the tasks that own them", () => {
    for (const mode of ["private", "demo"] as const) {
      const names = schedulesFor(mode, DEFAULT_SETTINGS).map((s) => s.name);
      expect(names).not.toContain("gmail.sync");
      expect(names).not.toContain("search.run");
    }
  });
});

describe("registerSchedules", () => {
  it("skips queues without a handler when given the handled set", async () => {
    const queue = new RecordingQueue();
    await registerSchedules(
      queue,
      "private",
      DEFAULT_SETTINGS,
      "America/Monterrey",
      new Set(["email.triage"] as const),
    );
    expect(queue.schedules.map((s) => s.name)).toEqual(["email.triage"]);
  });

  it("registers every schedule in the owner's time zone and drops the other mode's", async () => {
    const queue = new RecordingQueue();
    await registerSchedules(queue, "private", DEFAULT_SETTINGS, "America/Monterrey");
    expect(queue.schedules.map((s) => s.name)).toEqual(
      schedulesFor("private", DEFAULT_SETTINGS).map((s) => s.name),
    );
    expect(queue.schedules.every((s) => s.tz === "America/Monterrey")).toBe(true);
    expect(queue.unscheduled).toEqual(["demo.reset"]);

    const demo = new RecordingQueue();
    await registerSchedules(demo, "demo", DEFAULT_SETTINGS, "America/Monterrey");
    expect(demo.schedules.map((s) => s.name)).toContain("demo.reset");
    expect(demo.schedules.map((s) => s.name)).not.toContain("backup.nightly");
    expect(demo.schedules.map((s) => s.name)).not.toContain("leads.recheck");
    expect(demo.unscheduled).toEqual(["backup.nightly", "leads.recheck"]);
  });
});
