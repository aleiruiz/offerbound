import { z } from "zod";
import { SenioritySchema } from "./enums.js";

// TECHNICAL_SPEC §10.2 `Settings`; defaults from DATA_MODEL §4.

export const BRIEF_MAX_CHARS = 12_000;

export const TrackSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export type Track = z.infer<typeof TrackSchema>;

const RangeSchema = z
  .object({ min: z.number().int().min(0), max: z.number().int().min(0) })
  .refine((range) => range.max >= range.min, {
    path: ["max"],
    message: "Must be at least the minimum",
  });
const MinOnlySchema = z.object({ min: z.number().int().min(0) });

export const LeadTargetSchema = RangeSchema;
export type LeadTarget = z.infer<typeof LeadTargetSchema>;

export const DailyTargetsSchema = z.object({
  leads: RangeSchema,
  applications: RangeSchema,
  outreach: MinOnlySchema,
  followUps: RangeSchema,
  prepMinutes: MinOnlySchema,
});
export type DailyTargets = z.infer<typeof DailyTargetsSchema>;

export const SearchSettingsSchema = z.object({
  brief: z.string().max(BRIEF_MAX_CHARS),
  tracks: z.array(TrackSchema).superRefine((tracks, ctx) => {
    const seen = new Set<string>();
    tracks.forEach((track, index) => {
      if (seen.has(track.key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "key"],
          message: "Track keys must be unique",
        });
      }
      seen.add(track.key);
    });
  }),
  excludedSeniorities: z.array(SenioritySchema),
  leadTarget: LeadTargetSchema,
  runTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm, for example 07:00"),
  enabled: z.boolean(),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

export const TimersSchema = z
  .object({
    followUpDays: z.number().int().min(1).max(60),
    abandonDays: z.number().int().min(2).max(90),
  })
  .refine((timers) => timers.abandonDays > timers.followUpDays, {
    path: ["abandonDays"],
    message: "Must be greater than the follow-up days",
  });
export type Timers = z.infer<typeof TimersSchema>;

export const AutomationSchema = z.object({
  autoApplyMinConfidence: z.number().min(0.5).max(0.99),
  senderIgnoreList: z.array(z.string()),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const SettingsSchema = z.object({
  search: SearchSettingsSchema,
  dailyTargets: DailyTargetsSchema,
  timers: TimersSchema,
  automation: AutomationSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Stored as the `onboarding` setting row, apart from `Settings`. */
export const OnboardingSettingSchema = z.object({ completedAt: z.string().nullable() });
export type OnboardingSetting = z.infer<typeof OnboardingSettingSchema>;

/** DATA_MODEL §4 without `onboarding`. */
export const DEFAULT_SETTINGS: Settings = {
  search: {
    brief:
      "Describe the roles, locations, work modes, compensation floors and exclusions you want. Edit this in Settings → Job search.",
    tracks: [
      { key: "A", label: "Remote from home country", priority: 1 },
      { key: "B", label: "Relocation with sponsorship", priority: 2 },
    ],
    excludedSeniorities: ["junior", "staff_plus", "manager"],
    leadTarget: { min: 20, max: 30 },
    runTime: "07:00",
    enabled: false,
  },
  dailyTargets: {
    leads: { min: 20, max: 30 },
    applications: { min: 8, max: 12 },
    outreach: { min: 5 },
    followUps: { min: 3, max: 5 },
    prepMinutes: { min: 90 },
  },
  timers: { followUpDays: 7, abandonDays: 14 },
  automation: { autoApplyMinConfidence: 0.8, senderIgnoreList: [] },
};
