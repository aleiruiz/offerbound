import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiUsageSchema,
  DEFAULT_SETTINGS,
  SettingsSchema,
  type ApiErrorBody,
  type Settings,
} from "@offerbound/contracts";
import { buildTestApp, buildTestDeps, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { RecordingQueue } from "../../test/queue.js";
import { getSettings } from "../settings/service.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
// The test clock (test/app.ts): 2026-10-01T12:00:00.000Z, which is 06:00 on 2026-10-01 in
// America/Monterrey (UTC-6 all year).
const apps: FastifyInstance[] = [];

async function appWith(overrides: Parameters<typeof buildTestApp>[0] = {}) {
  const queue = new RecordingQueue();
  const built = await buildTestApp({ queue, ...overrides });
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const call = (method: "GET" | "PUT", url: string, payload?: object) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, ...(method === "GET" ? {} : CSRF) },
      ...(payload ? { payload } : {}),
    });
  return { ...built, queue, cookie, call };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const withPatch = (patch: {
  search?: Partial<Settings["search"]>;
  timers?: Partial<Settings["timers"]>;
  automation?: Partial<Settings["automation"]>;
}): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  search: { ...DEFAULT_SETTINGS.search, ...patch.search },
  timers: { ...DEFAULT_SETTINGS.timers, ...patch.timers },
  automation: { ...DEFAULT_SETTINGS.automation, ...patch.automation },
});

describe("GET and PUT /settings", () => {
  it("GET returns DEFAULT_SETTINGS on a fresh database", async () => {
    const { call } = await appWith();
    const res = await call("GET", "/settings");
    expect(res.statusCode).toBe(200);
    expect(SettingsSchema.parse(res.json())).toEqual(DEFAULT_SETTINGS);
  });

  it("PUT saves the full settings and GET returns them", async () => {
    const { call } = await appWith();
    const next = withPatch({ timers: { followUpDays: 5, abandonDays: 20 } });
    const put = await call("PUT", "/settings", next);
    expect(put.statusCode).toBe(200);
    expect(SettingsSchema.parse(put.json())).toEqual(next);
    const get = await call("GET", "/settings");
    expect(SettingsSchema.parse(get.json())).toEqual(next);
    expect(await getSettings(prisma)).toEqual(next);
  });

  it("PUT with abandonDays 5 and followUpDays 7 → 400 with fields['timers.abandonDays']", async () => {
    const { call } = await appWith();
    const res = await call(
      "PUT",
      "/settings",
      withPatch({ timers: { followUpDays: 7, abandonDays: 5 } }),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json<ApiErrorBody>();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.fields?.["timers.abandonDays"]).toBeTruthy();
    // Nothing was stored.
    expect(await getSettings(prisma)).toEqual(DEFAULT_SETTINGS);
  });

  it("PUT reports a field message for each invalid value", async () => {
    const { call } = await appWith();
    const res = await call(
      "PUT",
      "/settings",
      withPatch({
        search: { runTime: "7am" },
        automation: { autoApplyMinConfidence: 0.2 },
      }),
    );
    expect(res.statusCode).toBe(400);
    const fields = res.json<ApiErrorBody>().error.fields ?? {};
    expect(fields["search.runTime"]).toBeTruthy();
    expect(fields["automation.autoApplyMinConfidence"]).toBeTruthy();
  });

  it("PUT with a partial body → 400 validation_failed", async () => {
    const { call } = await appWith();
    const res = await call("PUT", "/settings", { timers: DEFAULT_SETTINGS.timers });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("validation_failed");
  });

  it("PUT without the CSRF header → 403 csrf_header_missing", async () => {
    const { app, cookie } = await appWith();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: DEFAULT_SETTINGS,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ApiErrorBody>().error.code).toBe("csrf_header_missing");
  });

  it("PUT that changes search.enabled or runTime re-registers the search schedule; other changes don't", async () => {
    const { call, queue } = await appWith();

    // Enabling schedules the run at the default 07:00 in the owner's time zone.
    let res = await call("PUT", "/settings", withPatch({ search: { enabled: true } }));
    expect(res.statusCode).toBe(200);
    expect(queue.schedules).toEqual([
      { name: "search.run", cron: "0 7 * * *", tz: "America/Monterrey" },
    ]);

    // A change of run time replaces the schedule.
    res = await call(
      "PUT",
      "/settings",
      withPatch({ search: { enabled: true, runTime: "08:30" } }),
    );
    expect(res.statusCode).toBe(200);
    expect(queue.schedules).toEqual([
      { name: "search.run", cron: "30 8 * * *", tz: "America/Monterrey" },
    ]);

    // Other changes (a timer, the brief) leave the schedule alone.
    queue.schedules = [];
    queue.unscheduled = [];
    res = await call(
      "PUT",
      "/settings",
      withPatch({
        search: { enabled: true, runTime: "08:30", brief: "Backend roles, remote." },
        timers: { followUpDays: 6, abandonDays: 12 },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(queue.schedules).toEqual([]);
    expect(queue.unscheduled).toEqual([]);

    // Disabling removes it.
    res = await call(
      "PUT",
      "/settings",
      withPatch({ search: { enabled: false, runTime: "08:30" } }),
    );
    expect(res.statusCode).toBe(200);
    expect(queue.unscheduled).toEqual(["search.run"]);
    expect(queue.schedules).toEqual([]);
  });

  it("PUT that is rejected does not touch the schedule", async () => {
    const { call, queue } = await appWith();
    const res = await call(
      "PUT",
      "/settings",
      withPatch({ search: { enabled: true }, timers: { followUpDays: 7, abandonDays: 3 } }),
    );
    expect(res.statusCode).toBe(400);
    expect(queue.schedules).toEqual([]);
    expect(queue.unscheduled).toEqual([]);
  });

  it("in demo mode a changed schedule is not registered", async () => {
    const demoEnv = buildTestDeps().env;
    const { call, queue } = await appWith({ env: { ...demoEnv, mode: "demo" } });
    const res = await call("PUT", "/settings", withPatch({ search: { enabled: true } }));
    expect(res.statusCode).toBe(200);
    expect(queue.schedules).toEqual([]);
    expect(queue.unscheduled).toEqual([]);
  });

  it("GET and PUT answer 401 without a session", async () => {
    const { app } = await appWith();
    const get = await app.inject({ method: "GET", url: "/api/v1/settings" });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: CSRF,
      payload: DEFAULT_SETTINGS,
    });
    expect(put.statusCode).toBe(401);
    const usage = await app.inject({ method: "GET", url: "/api/v1/ai-usage" });
    expect(usage.statusCode).toBe(401);
    expect(usage.json<ApiErrorBody>().error.code).toBe("unauthenticated");
  });
});

type CallSeed = {
  purpose?: "triage" | "extract" | "rank" | "search" | "parse_report" | "cv_profile";
  at: string;
  costMicros: number | null;
};
async function seedCalls(calls: CallSeed[]) {
  await prisma.llmCall.createMany({
    data: calls.map((c) => ({
      purpose: c.purpose ?? "triage",
      model: "gpt-6-luna",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      costMicros: c.costMicros === null ? null : BigInt(c.costMicros),
      latencyMs: 50,
      status: "ok" as const,
      createdAt: new Date(c.at),
    })),
  });
}

describe("GET /ai-usage", () => {
  it("returns zeros and 30 empty days on a fresh database", async () => {
    const { call } = await appWith();
    const res = await call("GET", "/ai-usage");
    expect(res.statusCode).toBe(200);
    const usage = AiUsageSchema.parse(res.json());
    expect(usage.monthToDateMicros).toBe(0);
    expect(usage.byPurpose).toEqual([]);
    expect(usage.last30Days).toHaveLength(30);
    expect(usage.last30Days.every((d) => d.costMicros === 0)).toBe(true);
  });

  it("AI usage sums the month to date in America/Monterrey and per purpose, counting calls with null cost as unknownCostCalls", async () => {
    await seedCalls([
      // 2026-09-30 23:00 in Monterrey: last month there, although it is October in UTC.
      { at: "2026-10-01T05:00:00.000Z", costMicros: 9_000_000, purpose: "triage" },
      // 2026-10-01 00:00 in Monterrey: the first moment of the month.
      { at: "2026-10-01T06:00:00.000Z", costMicros: 1_500, purpose: "triage" },
      { at: "2026-10-01T09:00:00.000Z", costMicros: 2_500, purpose: "triage" },
      { at: "2026-10-01T10:00:00.000Z", costMicros: null, purpose: "triage" },
      { at: "2026-10-01T10:30:00.000Z", costMicros: 40_000, purpose: "extract" },
      { at: "2026-10-01T11:00:00.000Z", costMicros: null, purpose: "search" },
    ]);
    const { call } = await appWith();
    const res = await call("GET", "/ai-usage");
    expect(res.statusCode).toBe(200);
    const usage = AiUsageSchema.parse(res.json());
    expect(usage.monthToDateMicros).toBe(44_000);
    const byPurpose = Object.fromEntries(usage.byPurpose.map((p) => [p.purpose, p]));
    expect(byPurpose["triage"]).toEqual({
      purpose: "triage",
      calls: 3,
      costMicros: 4_000,
      unknownCostCalls: 1,
    });
    expect(byPurpose["extract"]).toEqual({
      purpose: "extract",
      calls: 1,
      costMicros: 40_000,
      unknownCostCalls: 0,
    });
    expect(byPurpose["search"]).toEqual({
      purpose: "search",
      calls: 1,
      costMicros: 0,
      unknownCostCalls: 1,
    });
    expect(usage.byPurpose).toHaveLength(3);
  });

  it("last30Days has one entry per local day, 30 entries in all", async () => {
    await seedCalls([
      // Local 2026-09-30 23:00 → belongs to 2026-09-30.
      { at: "2026-10-01T05:00:00.000Z", costMicros: 700 },
      // Local 2026-10-01.
      { at: "2026-10-01T06:00:00.000Z", costMicros: 100 },
      { at: "2026-10-01T11:59:00.000Z", costMicros: 20 },
      // Local 2026-09-02, the oldest day shown (2026-09-02 .. 2026-10-01).
      { at: "2026-09-02T06:00:00.000Z", costMicros: 5 },
      // Local 2026-09-01 23:59: one day too old.
      { at: "2026-09-02T05:59:00.000Z", costMicros: 999 },
    ]);
    const { call } = await appWith();
    const usage = AiUsageSchema.parse((await call("GET", "/ai-usage")).json());
    expect(usage.last30Days).toHaveLength(30);
    expect(usage.last30Days[0]).toEqual({ date: "2026-09-02", costMicros: 5 });
    expect(usage.last30Days[29]).toEqual({ date: "2026-10-01", costMicros: 120 });
    expect(usage.last30Days[28]).toEqual({ date: "2026-09-30", costMicros: 700 });
    const dates = usage.last30Days.map((d) => d.date);
    expect(new Set(dates).size).toBe(30);
    expect([...dates].sort()).toEqual(dates);
    expect(usage.last30Days.reduce((sum, d) => sum + d.costMicros, 0)).toBe(825);
  });

  it("covers a month-to-date longer than the 30 days shown", async () => {
    await seedCalls([
      { at: "2026-10-01T09:00:00.000Z", costMicros: 10 }, // local 2026-10-01 03:00
    ]);
    // Clock at local 2026-10-31 12:00; the 30-day window starts 2026-10-02, the month on 10-01.
    const { call } = await appWith({ clock: () => new Date("2026-10-31T18:00:00.000Z") });
    const usage = AiUsageSchema.parse((await call("GET", "/ai-usage")).json());
    expect(usage.monthToDateMicros).toBe(10);
    expect(usage.last30Days[0]?.date).toBe("2026-10-02");
    expect(usage.last30Days.reduce((sum, d) => sum + d.costMicros, 0)).toBe(0);
  });
});
