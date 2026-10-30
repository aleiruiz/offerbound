import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect } from "react";
import { setShortcutDialogOpen, useShortcutDialogOpen } from "../lib/shortcuts";
import { msg, t } from "../i18n";

interface ShortcutGroup {
  title: string;
  rows: { keys: string[]; label: string }[];
}

// DESIGN_SPEC §9.3.
const GROUPS: ShortcutGroup[] = [
  {
    title: msg("Any list"),
    rows: [
      { keys: ["j", "k"], label: msg("Move down or up (↓ and ↑ work inside a row)") },
      { keys: ["Enter"], label: msg("Open the focused row") },
    ],
  },
  {
    title: msg("Leads"),
    rows: [
      { keys: ["s"], label: msg("Shortlist") },
      { keys: ["d"], label: msg("Dismiss") },
      { keys: ["a"], label: msg("Mark applied") },
      { keys: ["o"], label: msg("Open the posting") },
    ],
  },
  { title: msg("Timeline"), rows: [{ keys: ["u"], label: msg("Undo the focused entry") }] },
  {
    title: msg("Anywhere"),
    rows: [
      { keys: ["g", "t"], label: msg("Go to Today") },
      { keys: ["g", "a"], label: msg("Go to Applications") },
      { keys: ["g", "l"], label: msg("Go to Leads") },
      { keys: ["g", "i"], label: msg("Go to Interviews") },
      { keys: ["g", "r"], label: msg("Go to Review") },
      { keys: ["?"], label: msg("Show this list") },
    ],
  },
];

export function Key({ children }: { children: string }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: "inline-block",
        minWidth: 24,
        px: 0.75,
        py: "1px",
        textAlign: "center",
        font: "inherit",
        fontSize: 13,
        fontWeight: 600,
        lineHeight: "20px",
        bgcolor: "action.hover",
        border: 1,
        borderColor: "divider",
        borderRadius: "4px",
      }}
    >
      {children}
    </Box>
  );
}

/** The shortcut list. Mount it once; `?` (or `setShortcutDialogOpen(true)`) opens it. */
export function ShortcutDialog() {
  const open = useShortcutDialogOpen();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const close = () => setShortcutDialogOpen(false);
  // A dialog left open must not survive its host unmounting.
  useEffect(() => close, []);

  return (
    <Dialog
      open={open}
      onClose={close}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="shortcuts-title"
    >
      <DialogTitle
        id="shortcuts-title"
        component="h2"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        {t("Keyboard shortcuts")}
        <IconButton aria-label={t("Close")} onClick={close} edge="end">
          <CloseOutlined fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t(
            "Shortcuts don't work while you're typing in a field. Every one has a button that does the same.",
          )}
        </Typography>
        {GROUPS.map((group) => (
          <Box key={group.title} component="section" aria-label={t(group.title)}>
            <Typography variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
              {t(group.title)}
            </Typography>
            <Box component="dl" sx={{ m: 0 }}>
              {group.rows.map((row) => (
                <Box
                  key={row.label}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    py: 0.75,
                    borderTop: 1,
                    borderColor: "divider",
                  }}
                >
                  <Box component="dt" sx={{ display: "flex", gap: 0.5, flex: "0 0 96px" }}>
                    {row.keys.map((k, i) => (
                      <Box
                        key={`${k}-${i}`}
                        sx={{ display: "flex", gap: 0.5, alignItems: "center" }}
                      >
                        {i > 0 ? (
                          <Typography variant="caption" color="text.secondary">
                            {t("then")}
                          </Typography>
                        ) : null}
                        <Key>{k}</Key>
                      </Box>
                    ))}
                  </Box>
                  <Box component="dd" sx={{ m: 0 }}>
                    <Typography variant="body2">{t(row.label)}</Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </DialogContent>
    </Dialog>
  );
}
