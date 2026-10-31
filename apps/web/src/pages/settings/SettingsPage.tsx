import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Navigate, NavLink, useNavigate, useParams } from "react-router";
import { useSignOut } from "../../api/hooks";
import { LanguageSelect } from "../../components/LanguageSelect";
import { useColorMode, type ThemePreference } from "../../ColorModeProvider";
import { AiUsage } from "./AiUsage";
import { Automation } from "./Automation";
import { Cv } from "./Cv";
import { Data } from "./Data";
import { Gmail } from "./Gmail";
import { useIsDemo } from "../../lib/demo";
import { Import } from "./Import";
import { Search } from "./Search";
import { Targets } from "./Targets";
import { Timers } from "./Timers";
import { t } from "../../i18n";

/**
 * Settings (DESIGN_SPEC §5.7): the section list on the left (above the section on phones) drives
 * `/settings/:section`. The *Theme* and *Language* selects and *Sign out* sit at the foot of the list.
 */

interface Section {
  key: string;
  label: string;
  element: ReactElement;
}

const SECTIONS: readonly Section[] = [
  {
    key: "gmail",
    get label() {
      return t("Gmail");
    },
    element: <Gmail />,
  },
  {
    key: "search",
    get label() {
      return t("Job search");
    },
    element: <Search />,
  },
  { key: "cv", label: "CV", element: <Cv /> },
  {
    key: "targets",
    get label() {
      return t("Daily targets");
    },
    element: <Targets />,
  },
  {
    key: "timers",
    get label() {
      return t("Timers");
    },
    element: <Timers />,
  },
  {
    key: "automation",
    get label() {
      return t("Automation");
    },
    element: <Automation />,
  },
  {
    key: "import",
    get label() {
      return t("Import");
    },
    element: <Import />,
  },
  {
    key: "ai-usage",
    get label() {
      return t("AI usage");
    },
    element: <AiUsage />,
  },
  {
    key: "data",
    get label() {
      return t("Data");
    },
    element: <Data />,
  },
];

const THEMES: { value: ThemePreference; label: string }[] = [
  {
    value: "system",
    get label() {
      return t("System");
    },
  },
  {
    value: "light",
    get label() {
      return t("Light");
    },
  },
  {
    value: "dark",
    get label() {
      return t("Dark");
    },
  },
];

export function SettingsPage() {
  const { section: key } = useParams();
  const demo = useIsDemo();
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return <Navigate to="/settings/gmail" replace />;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Typography variant="h4" component="h1">
        {t("Settings")}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 3 }}>
        <Box
          sx={{
            flex: "1 1 180px",
            maxWidth: { sm: 220 },
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <Box
            component="nav"
            aria-label={t("Settings sections")}
            sx={{ display: "flex", flexDirection: "column", gap: "2px" }}
          >
            {SECTIONS.map((s) => (
              <Box
                key={s.key}
                component={NavLink}
                to={`/settings/${s.key}`}
                sx={(theme) => ({
                  display: "flex",
                  alignItems: "center",
                  minHeight: 40,
                  px: 1.5,
                  borderRadius: 1,
                  color: "text.primary",
                  textDecoration: "none",
                  fontSize: 14,
                  fontWeight: 600,
                  "&:hover": { bgcolor: theme.palette.action.hover },
                  "&[aria-current='page']": {
                    bgcolor: theme.palette.tokens.routeTint,
                    color: "primary.main",
                    fontWeight: 700,
                  },
                  [theme.breakpoints.down("sm")]: { minHeight: 44 },
                })}
              >
                {s.label}
              </Box>
            ))}
          </Box>
          <Divider />
          <Appearance />
          <LanguageSelect />
          {/* The demo has no sign-in, so nothing to sign out of. */}
          {demo ? null : <SignOut />}
        </Box>
        <Box
          sx={{
            flex: "999 1 560px",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {section.element}
        </Box>
      </Box>
    </Box>
  );
}

function Appearance() {
  const { preference, setPreference } = useColorMode();
  return (
    <TextField
      select
      label={t("Theme")}
      value={preference}
      onChange={(event) => setPreference(event.target.value as ThemePreference)}
      slotProps={{ select: { native: true } }}
    >
      {THEMES.map((theme) => (
        <option key={theme.value} value={theme.value}>
          {theme.label}
        </option>
      ))}
    </TextField>
  );
}

function SignOut() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Button
        variant="outlined"
        disabled={signOut.isPending}
        onClick={() =>
          signOut.mutate(undefined, {
            onSuccess: () => {
              void navigate("/login", { replace: true });
              // Nothing of this session should be shown to the next one.
              queryClient.clear();
            },
          })
        }
      >
        {t("Sign out")}
      </Button>
      {signOut.isError ? (
        <Alert severity="error" role="alert">
          {t("Couldn't sign out. Try again.")}
        </Alert>
      ) : null}
    </Box>
  );
}
