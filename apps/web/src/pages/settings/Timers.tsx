import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Settings } from "@offerbound/contracts";
import { useState } from "react";
import {
  IntField,
  SaveBar,
  SectionPaper,
  SettingsGate,
  useSettingsSave,
  wholeNumberError,
} from "./shared";
import { t } from "../../i18n";

/**
 * Settings, Timers (F7, AC-7.4): the days without a reply after which an application is due for a
 * follow-up, and after which it is marked Abandoned. The rule is the contract's: abandon days are
 * greater than follow-up days, 1 to 60 and 2 to 90.
 */

interface Draft {
  followUpDays: number | null;
  abandonDays: number | null;
}

function rangeError(value: number | null, min: number, max: number): string | undefined {
  return (
    wholeNumberError(value) ??
    ((value ?? 0) < min || (value ?? 0) > max
      ? t("Use a number from {min} to {max}", { min, max })
      : undefined)
  );
}

function validate(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  const followUp = rangeError(draft.followUpDays, 1, 60);
  const abandon = rangeError(draft.abandonDays, 2, 90);
  if (followUp) errors["timers.followUpDays"] = followUp;
  if (abandon) errors["timers.abandonDays"] = abandon;
  else if (!followUp && (draft.abandonDays ?? 0) <= (draft.followUpDays ?? 0)) {
    errors["timers.abandonDays"] = t("Must be greater than the follow-up days");
  }
  return errors;
}

export function Timers() {
  return <SettingsGate>{(settings) => <TimersForm settings={settings} />}</SettingsGate>;
}

function TimersForm({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<Draft>(settings.timers);
  const [attempted, setAttempted] = useState(false);
  const save = useSettingsSave(draft);

  const clientErrors = attempted ? validate(draft) : {};
  const message = (key: string): string | undefined => clientErrors[key] ?? save.fields[key];

  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(draft)).length > 0) return;
    save.submit({
      ...settings,
      timers: { followUpDays: draft.followUpDays ?? 0, abandonDays: draft.abandonDays ?? 0 },
    });
  };

  return (
    <SectionPaper id="timers-heading" title={t("Timers")}>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
        <IntField
          label={t("Follow-up days")}
          min={1}
          max={60}
          value={draft.followUpDays}
          onChange={(followUpDays) => setDraft((d) => ({ ...d, followUpDays }))}
          error={message("timers.followUpDays")}
          width={160}
        />
        <IntField
          label={t("Abandon days")}
          min={2}
          max={90}
          value={draft.abandonDays}
          onChange={(abandonDays) => setDraft((d) => ({ ...d, abandonDays }))}
          error={message("timers.abandonDays")}
          width={160}
        />
      </Box>
      <Typography variant="caption" color="text.secondary" component="p">
        {t(
          "An application with no reply from the company shows as follow-up due after the first number of days, and becomes Abandoned after the second. A follow-up you send does not restart the count. Abandon days must be greater than follow-up days.",
        )}
      </Typography>
      <SaveBar save={save} onSave={submit} />
    </SectionPaper>
  );
}
