import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { LlmPurposeSchema, type AiUsage } from "@offerbound/contracts";
import { dayRangeUtc, localMidnightUtc, ownerLocalDay } from "@offerbound/domain";
import type { AppDeps } from "../deps.js";

/** Days shown in the daily chart, today included. */
export const USAGE_DAYS = 30;

/**
 * `GET /ai-usage` (TECHNICAL_SPEC §10.1; AC-15.1): month-to-date cost, calls and cost by purpose,
 * and the cost of each of the last 30 local days. Costs are in micros. A call with unknown pricing
 * has a null cost: it adds nothing to a total and is counted in `unknownCostCalls`.
 *
 * "Month" and "day" are the owner's (`timezone`), so a call at 23:00 on the last evening of a
 * month in Monterrey belongs to that month although it is already the next one in UTC. Two grouped
 * queries answer everything, whatever the number of calls.
 */
export async function getAiUsage(
  prisma: PrismaClient,
  timezone: string,
  now: Date,
): Promise<AiUsage> {
  const today = ownerLocalDay(now, timezone);
  const todayEnd = dayRangeUtc(today, timezone).end;
  const monthStart = localMidnightUtc(`${today.slice(0, 7)}-01`, timezone);

  const days = Array.from({ length: USAGE_DAYS }, (_, index) =>
    DateTime.fromISO(today, { zone: "utc" })
      .minus({ days: USAGE_DAYS - 1 - index })
      .toFormat("yyyy-MM-dd"),
  );
  const windowStart = localMidnightUtc(days[0] ?? today, timezone);

  const [purposeRows, dayRows] = await Promise.all([
    prisma.$queryRaw<
      { purpose: string; calls: bigint; cost_micros: bigint; unknown_cost_calls: bigint }[]
    >(Prisma.sql`
      SELECT purpose::text AS purpose,
             count(*) AS calls,
             COALESCE(sum(cost_micros), 0) AS cost_micros,
             count(*) FILTER (WHERE cost_micros IS NULL) AS unknown_cost_calls
      FROM llm_call
      WHERE created_at >= ${monthStart} AND created_at < ${todayEnd}
      GROUP BY purpose`),
    prisma.$queryRaw<{ day: string; cost_micros: bigint }[]>(Prisma.sql`
      SELECT to_char(created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
             COALESCE(sum(cost_micros), 0) AS cost_micros
      FROM llm_call
      WHERE created_at >= ${windowStart} AND created_at < ${todayEnd}
      GROUP BY 1`),
  ]);

  const byPurpose = LlmPurposeSchema.options.flatMap((purpose) => {
    const row = purposeRows.find((r) => r.purpose === purpose);
    return row
      ? [
          {
            purpose,
            calls: Number(row.calls),
            costMicros: Number(row.cost_micros),
            unknownCostCalls: Number(row.unknown_cost_calls),
          },
        ]
      : [];
  });
  const costByDay = new Map(dayRows.map((r) => [r.day, Number(r.cost_micros)]));

  return {
    monthToDateMicros: byPurpose.reduce((sum, p) => sum + p.costMicros, 0),
    byPurpose,
    last30Days: days.map((date) => ({ date, costMicros: costByDay.get(date) ?? 0 })),
  };
}

export function registerAiUsageRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/ai-usage", (): Promise<AiUsage> =>
    getAiUsage(deps.prisma, deps.env.userTimezone, deps.clock()),
  );
}
