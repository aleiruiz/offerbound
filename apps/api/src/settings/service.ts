import type { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_SETTINGS, OnboardingSettingSchema, type Settings } from "@offerbound/contracts";

type Db = PrismaClient | Prisma.TransactionClient;

/** The `setting` rows that make up `Settings`; `onboarding` is stored apart (DATA_MODEL §4). */
const SETTINGS_KEYS = ["search", "dailyTargets", "timers", "automation"] as const;
const ONBOARDING_KEY = "onboarding";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stored sections merged over `DEFAULT_SETTINGS`: a missing row or a field added after the row
 * was written falls back to its default. The caller validates input; stored rows are trusted.
 */
export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.setting.findMany({ where: { key: { in: [...SETTINGS_KEYS] } } });
  const merged: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    const key = row.key as (typeof SETTINGS_KEYS)[number];
    if (isRecord(row.value)) {
      Object.assign(merged[key], row.value);
    }
  }
  return merged;
}

/** Writes all four sections. Rows are upserted, so a first save creates them. */
export async function saveSettings(db: Db, settings: Settings): Promise<void> {
  for (const key of SETTINGS_KEYS) {
    const value = settings[key] as unknown as Prisma.InputJsonValue;
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

/** `onboarding.completedAt`, or null while onboarding is not finished. */
export async function getOnboardingCompletedAt(db: Db): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: ONBOARDING_KEY } });
  if (!row) return null;
  const parsed = OnboardingSettingSchema.safeParse(row.value);
  if (!parsed.success || parsed.data.completedAt === null) return null;
  const at = new Date(parsed.data.completedAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Marks onboarding done. Calling it again keeps the first completion time. */
export async function setOnboardingCompleted(db: Db, now: Date): Promise<void> {
  const existing = await getOnboardingCompletedAt(db);
  if (existing) return;
  const value = { completedAt: now.toISOString() };
  await db.setting.upsert({
    where: { key: ONBOARDING_KEY },
    create: { key: ONBOARDING_KEY, value },
    update: { value },
  });
}
