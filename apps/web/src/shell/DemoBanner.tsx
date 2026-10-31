import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { ApiClientError } from "../api/client";
import { useSimulateEmail } from "../api/hooks";
import { useUndoSnackbar } from "../components/UndoSnackbar";
import { useIsDemo } from "../lib/demo";
import { t } from "../i18n";

/**
 * The public demo's dark banner (DESIGN_SPEC §5.10, AC-16.3, AC-16.4): what the data is, when it
 * resets, and *Simulate an incoming email*, which feeds the next synthetic email through the real
 * pipeline so the visitor sees the status change and its timeline entry. Not shown for the owner.
 * The colours are the ink ground of the States board in both modes, as a snackbar's are.
 */
const INK = "#16202e";
const ON_INK = "#e7ece9";
const ROUTE_ON_INK = "#4fd1a5";

export function DemoBanner() {
  const demo = useIsDemo();
  const snackbar = useUndoSnackbar();
  const simulate = useSimulateEmail({
    onSuccess: () =>
      snackbar.show(t("Simulated an email. The change is on the application's timeline.")),
    onError: (error) =>
      snackbar.alert(
        error instanceof ApiClientError && error.status === 429
          ? t("Too many requests. Wait a minute and try again.")
          : t("Couldn't simulate an email. Try again."),
      ),
  });
  if (!demo) return null;

  return (
    <Box
      component="section"
      aria-label={t("Demo")}
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "12px 16px",
        px: 2,
        py: "10px",
        bgcolor: INK,
        color: ON_INK,
      }}
    >
      <Typography variant="body2" component="p" sx={{ flex: "1 1 320px", color: "inherit" }}>
        <Box component="span" sx={{ fontWeight: 700 }}>
          {t("Demo with made-up data.")}
        </Box>{" "}
        {t("Everything resets every hour. Writing notes and importing files are turned off.")}
      </Typography>
      <Button
        variant="outlined"
        size="small"
        disabled={simulate.isPending}
        onClick={() => simulate.mutate()}
        sx={{
          color: ROUTE_ON_INK,
          borderColor: ROUTE_ON_INK,
          "&:hover": { borderColor: ROUTE_ON_INK, bgcolor: "rgba(79,209,165,0.12)" },
          "&.Mui-disabled": { color: ON_INK, borderColor: ON_INK, opacity: 0.6 },
        }}
      >
        {simulate.isPending ? t("Simulating") : t("Simulate an incoming email")}
      </Button>
    </Box>
  );
}
