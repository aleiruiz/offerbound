import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Slider from "@mui/material/Slider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { Settings } from "@offerbound/contracts";
import { useState } from "react";
import { SaveBar, SectionPaper, SettingsGate, useSettingsSave } from "./shared";

/**
 * Settings, Automation (AC-4.1): the confidence at which a change is applied without asking
 * (0.50 to 0.99, shown in words), and the senders whose email is skipped.
 */

const MIN = 0.5;
const MAX = 0.99;

interface Draft {
  threshold: number;
  senders: string[];
}

export function Automation() {
  return <SettingsGate>{(settings) => <AutomationForm settings={settings} />}</SettingsGate>;
}

/** "0.8" from a slider whose float steps drift: two decimals, always. */
const snap = (value: number) => Math.round(value * 100) / 100;

function AutomationForm({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<Draft>({
    threshold: settings.automation.autoApplyMinConfidence,
    senders: settings.automation.senderIgnoreList,
  });
  const save = useSettingsSave(draft);
  const [entry, setEntry] = useState("");
  const [entryError, setEntryError] = useState<string | undefined>(undefined);

  const percent = Math.round(draft.threshold * 100);

  const add = () => {
    const sender = entry.trim().toLowerCase();
    if (sender === "") return;
    if (/\s/.test(sender) || sender.split("@").length > 2) {
      setEntryError("Use an email address or a domain, without spaces.");
      return;
    }
    if (draft.senders.includes(sender)) {
      setEntryError("That sender is already in the list.");
      return;
    }
    setDraft((d) => ({ ...d, senders: [...d.senders, sender] }));
    setEntry("");
    setEntryError(undefined);
  };

  const submit = () =>
    save.submit({
      ...settings,
      automation: {
        autoApplyMinConfidence: draft.threshold,
        senderIgnoreList: draft.senders,
      },
    });

  const thresholdError = save.fields["automation.autoApplyMinConfidence"];

  return (
    <SectionPaper id="automation-heading" title="Automation">
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 560 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
          <Typography id="threshold-label" variant="subtitle2" component="span">
            Auto-apply threshold
          </Typography>
          <Typography variant="subtitle2" component="span">
            {draft.threshold.toFixed(2)}
          </Typography>
        </Box>
        <Slider
          min={MIN}
          max={MAX}
          step={0.01}
          value={draft.threshold}
          onChange={(_, value) => setDraft((d) => ({ ...d, threshold: snap(value) }))}
          aria-labelledby="threshold-label"
          getAriaValueText={(value) => `${Math.round(value * 100)}% sure`}
          sx={{ mx: 1, width: "calc(100% - 16px)" }}
        />
        <Typography>
          {`Offerbound applies a change by itself when it is at least ${percent}% sure. Anything less goes to Review.`}
        </Typography>
        <Typography variant="caption" color={thresholdError ? "error" : "text.secondary"}>
          {thresholdError ??
            "A lower number applies more changes without asking, and you may need to undo more of them. A higher number sends more to Review."}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25, maxWidth: 560 }}>
        <Typography variant="subtitle2" component="h3">
          Ignored senders
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          Email from these senders is skipped without being read or sent anywhere. Add an email
          address or a domain.
        </Typography>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
          <TextField
            label="Add a sender or domain"
            value={entry}
            onChange={(event) => {
              setEntry(event.target.value);
              setEntryError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            error={Boolean(entryError)}
            helperText={entryError}
            sx={{ flex: 1 }}
          />
          <Button variant="outlined" onClick={add} sx={{ mt: 0.25 }}>
            Add sender
          </Button>
        </Box>
        {draft.senders.length > 0 ? (
          <Box
            component="ul"
            aria-label="Ignored senders"
            sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexWrap: "wrap", gap: 1 }}
          >
            {draft.senders.map((sender) => (
              <Box
                component="li"
                key={sender}
                sx={(theme) => ({
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.25,
                  pl: 1.25,
                  borderRadius: "16px",
                  border: 1,
                  borderColor: "divider",
                  bgcolor: theme.palette.tokens.surfaceSunken,
                })}
              >
                <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                  {sender}
                </Typography>
                <IconButton
                  size="small"
                  aria-label={`Remove ${sender}`}
                  onClick={() =>
                    setDraft((d) => ({ ...d, senders: d.senders.filter((s) => s !== sender) }))
                  }
                >
                  <CloseOutlined fontSize="inherit" />
                </IconButton>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No senders are ignored.
          </Typography>
        )}
      </Box>

      <SaveBar save={save} onSave={submit} />
    </SectionPaper>
  );
}
