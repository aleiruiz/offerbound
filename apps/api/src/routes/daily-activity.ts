import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  DailyActivityBodySchema,
  type DailyActivityBody,
  type DailyCounts,
} from "@offerbound/contracts";
import { ownerLocalDay } from "@offerbound/domain";
import type { AppDeps } from "../deps.js";
import { dayColumn } from "./today.js";

/**
 * `POST /daily-activity` (TECHNICAL_SPEC §10.1; AC-13.2): +N outreach or +N minutes of interview
 * prep on the owner's local day. A tap adds to the day's counter in one statement, so taps that
 * arrive together are all counted. Follow-ups are never logged here: the pipeline and *Mark
 * followed up* count them (AC-7.3).
 */
export async function logDailyActivity(
  prisma: PrismaClient,
  timezone: string,
  now: Date,
  body: DailyActivityBody,
): Promise<DailyCounts> {
  const day = ownerLocalDay(now, timezone);
  const outreach = body.kind === "outreach" ? body.amount : 0;
  const prep = body.kind === "prep_minutes" ? body.amount : 0;
  const [row] = await prisma.$queryRaw<
    { outreach_count: number; prep_minutes: number; follow_ups: number }[]
  >`
    INSERT INTO daily_activity (day, outreach_count, prep_minutes, follow_ups, updated_at)
    VALUES (${dayColumn(day)}::date, ${outreach}, ${prep}, 0, ${now})
    ON CONFLICT (day) DO UPDATE SET
      outreach_count = daily_activity.outreach_count + EXCLUDED.outreach_count,
      prep_minutes = daily_activity.prep_minutes + EXCLUDED.prep_minutes,
      updated_at = EXCLUDED.updated_at
    RETURNING outreach_count, prep_minutes, follow_ups`;
  if (!row) throw new Error("The daily activity row was not written");
  return {
    date: day,
    outreach: row.outreach_count,
    prepMinutes: row.prep_minutes,
    followUps: row.follow_ups,
  };
}

export function registerDailyActivityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/daily-activity", (request): Promise<DailyCounts> => {
    const body = DailyActivityBodySchema.parse(request.body);
    return logDailyActivity(deps.prisma, deps.env.userTimezone, deps.clock(), body);
  });
}
