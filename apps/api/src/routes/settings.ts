import type { FastifyInstance } from "fastify";
import { SettingsSchema, type Settings } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { registerSearchSchedule } from "../leads/search.js";
import { getSettings, saveSettings } from "../settings/service.js";

/**
 * `GET /settings` and `PUT /settings` (TECHNICAL_SPEC §10.1; AC-15.3).
 *
 * `PUT` takes the full `Settings`. `SettingsSchema` is the single validator, cross-field rules
 * included (`timers.abandonDays` must exceed `timers.followUpDays`); a failure becomes
 * `400 validation_failed` with the dotted field paths in `fields`. When `search.enabled` or
 * `search.runTime` changes, the daily search is re-registered (§9) before the settings are saved.
 * The demo has no search of its own, so nothing is registered there.
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/settings", (): Promise<Settings> => getSettings(deps.prisma));

  app.put("/settings", async (request): Promise<Settings> => {
    const next = SettingsSchema.parse(request.body);
    const previous = await getSettings(deps.prisma);

    // The schedule goes first: if the queue is down the request fails with nothing saved, so the
    // owner can retry. Saving first would leave the new settings stored and the schedule never
    // retried, since a repeat of the same PUT would then see no change.
    const scheduleChanged =
      previous.search.enabled !== next.search.enabled ||
      previous.search.runTime !== next.search.runTime;
    if (scheduleChanged && deps.env.mode === "private") {
      await registerSearchSchedule(deps.queue, next.search, deps.env.userTimezone);
    }
    await deps.prisma.$transaction((tx) => saveSettings(tx, next));
    return next;
  });
}
