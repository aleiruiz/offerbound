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
import { useColorMode, type ThemePreference } from "../../ColorModeProvider";
import { AiUsage } from "./AiUsage";
import { Automation } from "./Automation";
import { Cv } from "./Cv";
import { Gmail } from "./Gmail";
import { Import } from "./Import";
import { Search } from "./Search";
import { Targets } from "./Targets";
import { Timers } from "./Timers";

/**
 * Settings (DESIGN_SPEC §5.7): the section list on the left (above the section on phones) drives
 * `/settings/:section`. The *Theme* select and *Sign out* sit at the foot of the list.
 */

interface Section {
  key: string;
  label: string;
  element: ReactElement;
}

// The Data section joins this list with T10.3b.
const SECTIONS: readonly Section[] = [
  { key: "gmail", label: "Gmail", element: <Gmail /> },
  { key: "search", label: "Job search", element: <Search /> },
  { key: "cv", label: "CV", element: <Cv /> },
  { key: "targets", label: "Daily targets", element: <Targets /> },
  { key: "timers", label: "Timers", element: <Timers /> },
  { key: "automation", label: "Automation", element: <Automation /> },
  { key: "import", label: "Import", element: <Import /> },
  { key: "ai-usage", label: "AI usage", element: <AiUsage /> },
];

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsPage() {
  const { section: key } = useParams();
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return <Navigate to="/settings/gmail" replace />;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Typography variant="h4" component="h1">
        Settings
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
            aria-label="Settings sections"
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
          <SignOut />
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
      label="Theme"
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
        Sign out
      </Button>
      {signOut.isError ? (
        <Alert severity="error" role="alert">
          Couldn't sign out. Try again.
        </Alert>
      ) : null}
    </Box>
  );
}
