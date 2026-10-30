import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import { Navigate, Outlet, useLocation } from "react-router";
import { ApiClientError } from "../api/client";
import { useMe } from "../api/hooks";

/**
 * Guards every route except /login (AC-1.1): no session means a redirect to the sign-in page.
 * An owner who has not finished onboarding is sent to /onboarding (TECHNICAL_SPEC §11); one who has,
 * and the demo, are sent from /onboarding to /today.
 * While the session loads a skeleton shaped like the page is shown; other failures say what to do.
 */
export function RequireSession() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <Box aria-busy="true" sx={{ p: { xs: 2, md: 4 }, maxWidth: 1200 }}>
        <Skeleton variant="text" width={160} height={40} />
        <Skeleton variant="rounded" height={160} sx={{ mt: 2 }} />
      </Box>
    );
  }

  if (me.isError) {
    if (me.error instanceof ApiClientError && me.error.status === 401) {
      return <Navigate to="/login" replace />;
    }
    return (
      <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 720 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void me.refetch()}>
              Try again
            </Button>
          }
        >
          Couldn't load your account. Check your connection, then try again.
        </Alert>
      </Box>
    );
  }

  // Setup comes first: until the owner finishes it, every page leads to /onboarding. The public
  // demo has nothing to set up.
  if (
    me.data.mode === "private" &&
    !me.data.onboardingCompleted &&
    location.pathname !== "/onboarding"
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  // Nothing left to set up (a finished owner) or nothing to set up at all (the public demo).
  if (
    location.pathname === "/onboarding" &&
    (me.data.mode === "demo" || me.data.onboardingCompleted)
  ) {
    return <Navigate to="/today" replace />;
  }

  return <Outlet />;
}
