import { describe, expect, it } from "vitest";
import { gmailListQuery, scheduleGmailSync, syncCron } from "./sync.js";
import { RecordingQueue } from "../../test/queue.js";

describe("gmailListQuery", () => {
  it("is the day before the start, in Gmail's date form, without spam, trash and drafts", () => {
    expect(gmailListQuery(new Date("2026-09-01"))).toBe(
      "after:2026/08/31 -in:spam -in:trash -in:drafts",
    );
    expect(gmailListQuery(new Date("2026-03-01"))).toBe(
      "after:2026/02/28 -in:spam -in:trash -in:drafts",
    );
    expect(gmailListQuery(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "after:2025/12/31 -in:spam -in:trash -in:drafts",
    );
  });
});

describe("syncCron", () => {
  it("runs every N minutes, and every whole number of hours from 60 minutes", () => {
    expect(syncCron(5)).toBe("*/5 * * * *");
    expect(syncCron(1)).toBe("*/1 * * * *");
    expect(syncCron(59)).toBe("*/59 * * * *");
    expect(syncCron(60)).toBe("0 */1 * * *");
    expect(syncCron(180)).toBe("0 */3 * * *");
    expect(syncCron(100_000)).toBe("0 */24 * * *");
  });

  it("scheduleGmailSync registers gmail.sync in the given time zone", async () => {
    const queue = new RecordingQueue();
    await scheduleGmailSync(queue, 5, "America/Monterrey");
    expect(queue.schedules).toEqual([
      { name: "gmail.sync", cron: "*/5 * * * *", tz: "America/Monterrey" },
    ]);
  });
});
