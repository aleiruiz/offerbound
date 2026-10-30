import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { DailyTargets, Settings } from "@offerbound/contracts";
import { useState } from "react";
import {
  IntField,
  SaveBar,
  SectionPaper,
  SettingsGate,
  useSettingsSave,
  wholeNumberError,
} from "./shared";

/**
 * Settings, Daily targets (DESIGN_SPEC §5.7, F13): a pair of number fields for each target that
 * has a range, one for each that has only a minimum.
 */

type TargetKey = keyof DailyTargets;

const TARGETS: { key: TargetKey; label: string; range: boolean; hint: string }[] = [
  { key: "leads", label: "New leads", range: true, hint: "New leads to look through each day." },
  {
    key: "applications",
    label: "Applications",
    range: true,
    hint: "Applications to send each day.",
  },
  {
    key: "outreach",
    label: "Outreach messages",
    range: false,
    hint: "Messages to recruiters or people at companies each day.",
  },
  { key: "followUps", label: "Follow-ups", range: true, hint: "Follow-up messages each day." },
  {
    key: "prepMinutes",
    label: "Prep minutes",
    range: false,
    hint: "Minutes of interview preparation each day.",
  },
];

/** The targets while they are edited: an empty field is `null`. */
type Draft = Record<TargetKey, { min: number | null; max: number | null }>;

function toDraft(targets: DailyTargets): Draft {
  const draft = {} as Draft;
  for (const { key, range } of TARGETS) {
    const value = targets[key] as { min: number; max?: number };
    draft[key] = { min: value.min, max: range ? (value.max ?? null) : null };
  }
  return draft;
}

function validate(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const { key, range } of TARGETS) {
    const { min, max } = draft[key];
    const base = `dailyTargets.${key}`;
    const minError = wholeNumberError(min) ?? ((min ?? 0) < 0 ? "Use 0 or more" : undefined);
    if (minError) errors[`${base}.min`] = minError;
    if (!range) continue;
    const maxError = wholeNumberError(max);
    if (maxError) errors[`${base}.max`] = maxError;
    else if (!minError && (max ?? 0) < (min ?? 0)) {
      errors[`${base}.max`] = "Must be at least the minimum";
    }
  }
  return errors;
}

export function Targets() {
  return <SettingsGate>{(settings) => <TargetsForm settings={settings} />}</SettingsGate>;
}

function TargetsForm({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings.dailyTargets));
  const [attempted, setAttempted] = useState(false);
  const save = useSettingsSave(draft);

  const clientErrors = attempted ? validate(draft) : {};
  const message = (key: string): string | undefined => clientErrors[key] ?? save.fields[key];

  const set = (key: TargetKey, part: "min" | "max", value: number | null) =>
    setDraft((previous) => ({ ...previous, [key]: { ...previous[key], [part]: value } }));

  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(draft)).length > 0) return;
    const n = (value: number | null) => value ?? 0;
    const dailyTargets: DailyTargets = {
      leads: { min: n(draft.leads.min), max: n(draft.leads.max) },
      applications: { min: n(draft.applications.min), max: n(draft.applications.max) },
      outreach: { min: n(draft.outreach.min) },
      followUps: { min: n(draft.followUps.min), max: n(draft.followUps.max) },
      prepMinutes: { min: n(draft.prepMinutes.min) },
    };
    save.submit({ ...settings, dailyTargets });
  };

  return (
    <SectionPaper
      id="targets-heading"
      title="Daily targets"
      caption="Shown as meters on Today. They guide you; nothing is blocked when you miss one."
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
        {TARGETS.map(({ key, label, range, hint }) => (
          <Box key={key} component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
            <Typography component="legend" variant="subtitle2">
              {label}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
              {hint}
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1 }}>
              <IntField
                label="At least"
                min={0}
                value={draft[key].min}
                onChange={(value) => set(key, "min", value)}
                error={message(`dailyTargets.${key}.min`)}
              />
              {range ? (
                <>
                  <Typography color="text.secondary" sx={{ pt: 1 }}>
                    to
                  </Typography>
                  <IntField
                    label="At most"
                    min={0}
                    value={draft[key].max}
                    onChange={(value) => set(key, "max", value)}
                    error={message(`dailyTargets.${key}.max`)}
                  />
                </>
              ) : null}
            </Box>
          </Box>
        ))}
      </Box>
      <SaveBar save={save} onSave={submit} />
    </SectionPaper>
  );
}
