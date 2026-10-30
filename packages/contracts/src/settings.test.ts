import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  OnboardingSettingSchema,
  SettingsSchema,
  type Settings,
} from "./index.js";

const withPatch = (patch: {
  search?: Partial<Settings["search"]>;
  timers?: Partial<Settings["timers"]>;
  automation?: Partial<Settings["automation"]>;
}): unknown => ({
  ...DEFAULT_SETTINGS,
  search: { ...DEFAULT_SETTINGS.search, ...patch.search },
  timers: { ...DEFAULT_SETTINGS.timers, ...patch.timers },
  automation: { ...DEFAULT_SETTINGS.automation, ...patch.automation },
});

const failedPaths = (input: unknown): string[] => {
  const result = SettingsSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("SettingsSchema", () => {
  it("rejects timers.abandonDays <= timers.followUpDays with the field path 'timers.abandonDays'", () => {
    expect(failedPaths(withPatch({ timers: { followUpDays: 14, abandonDays: 14 } }))).toContain(
      "timers.abandonDays",
    );
    expect(failedPaths(withPatch({ timers: { followUpDays: 14, abandonDays: 10 } }))).toContain(
      "timers.abandonDays",
    );
    expect(failedPaths(withPatch({ timers: { followUpDays: 7, abandonDays: 8 } }))).toEqual([]);
  });

  it("bounds followUpDays to 1..60 and abandonDays to 2..90", () => {
    expect(failedPaths(withPatch({ timers: { followUpDays: 0 } }))).toContain(
      "timers.followUpDays",
    );
    expect(failedPaths(withPatch({ timers: { followUpDays: 61, abandonDays: 90 } }))).toContain(
      "timers.followUpDays",
    );
    expect(failedPaths(withPatch({ timers: { followUpDays: 1, abandonDays: 91 } }))).toContain(
      "timers.abandonDays",
    );
  });

  it("rejects autoApplyMinConfidence 0.49 and 1.0; accepts 0.5 and 0.99", () => {
    const at = (autoApplyMinConfidence: number): boolean =>
      SettingsSchema.safeParse(withPatch({ automation: { autoApplyMinConfidence } })).success;
    expect(at(0.49)).toBe(false);
    expect(at(1.0)).toBe(false);
    expect(at(0.5)).toBe(true);
    expect(at(0.99)).toBe(true);
  });

  it("rejects a 12,001-character brief", () => {
    expect(failedPaths(withPatch({ search: { brief: "b".repeat(12_001) } }))).toContain(
      "search.brief",
    );
    expect(
      SettingsSchema.safeParse(withPatch({ search: { brief: "b".repeat(12_000) } })).success,
    ).toBe(true);
  });

  it("rejects runTime '7:00'; accepts '07:00'", () => {
    expect(failedPaths(withPatch({ search: { runTime: "7:00" } }))).toContain("search.runTime");
    expect(failedPaths(withPatch({ search: { runTime: "24:00" } }))).toContain("search.runTime");
    expect(SettingsSchema.safeParse(withPatch({ search: { runTime: "07:00" } })).success).toBe(
      true,
    );
    expect(SettingsSchema.safeParse(withPatch({ search: { runTime: "23:59" } })).success).toBe(
      true,
    );
  });

  it("rejects track priority 4 and duplicate track keys", () => {
    const track = { key: "A", label: "Remote", priority: 1 as const };
    expect(
      SettingsSchema.safeParse(
        withPatch({ search: { tracks: [{ ...track, priority: 4 as never }] } }),
      ).success,
    ).toBe(false);
    const dup = failedPaths(
      withPatch({ search: { tracks: [track, { key: "A", label: "Other", priority: 2 }] } }),
    );
    expect(dup).toContain("search.tracks.1.key");
  });

  it("rejects an inverted lead target", () => {
    expect(failedPaths(withPatch({ search: { leadTarget: { min: 30, max: 20 } } }))).toContain(
      "search.leadTarget.max",
    );
  });

  it("DEFAULT_SETTINGS passes SettingsSchema", () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(DEFAULT_SETTINGS.search.leadTarget).toEqual({ min: 20, max: 30 });
    expect(DEFAULT_SETTINGS.search.excludedSeniorities).toEqual([
      "junior",
      "staff_plus",
      "manager",
    ]);
    expect(DEFAULT_SETTINGS.search.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.dailyTargets).toEqual({
      leads: { min: 20, max: 30 },
      applications: { min: 8, max: 12 },
      outreach: { min: 5 },
      followUps: { min: 3, max: 5 },
      prepMinutes: { min: 90 },
    });
    expect(DEFAULT_SETTINGS.timers).toEqual({ followUpDays: 7, abandonDays: 14 });
    expect(DEFAULT_SETTINGS.automation).toEqual({
      autoApplyMinConfidence: 0.8,
      senderIgnoreList: [],
    });
    expect("onboarding" in DEFAULT_SETTINGS).toBe(false);
  });

  it("parses the onboarding setting", () => {
    expect(OnboardingSettingSchema.parse({ completedAt: null })).toEqual({ completedAt: null });
    expect(
      OnboardingSettingSchema.parse({ completedAt: "2026-10-30T12:00:00.000Z" }).completedAt,
    ).toBe("2026-10-30T12:00:00.000Z");
    expect(OnboardingSettingSchema.safeParse({}).success).toBe(false);
  });
});
