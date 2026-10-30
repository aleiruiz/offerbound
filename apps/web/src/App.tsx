import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { setDemoReadOnlyHandler, setUnauthorizedHandler } from "./api/client";
import { useUndoSnackbar } from "./components/UndoSnackbar";
import { DEMO_READ_ONLY_MESSAGE } from "./lib/demo";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { ImportReportPage } from "./pages/ImportReportPage";
import { LeadsPage } from "./pages/LeadsPage";
import { InterviewsPage } from "./pages/InterviewsPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { ReviewPage } from "./pages/ReviewPage";
import { TodayPage } from "./pages/TodayPage";
import { AppShell } from "./shell/AppShell";
import { RequireSession } from "./shell/RequireSession";

export function App() {
  const navigate = useNavigate();
  const snackbar = useUndoSnackbar();

  // A 401 from any request sends the visitor to the sign-in page (TECHNICAL_SPEC §11, AC-1.1).
  useEffect(() => {
    setUnauthorizedHandler(() => void navigate("/login", { replace: true }));
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // The demo refuses free text with a 403; whatever the control reported, the visitor is told why.
  useEffect(() => {
    setDemoReadOnlyHandler(() => snackbar.alert(DEMO_READ_ONLY_MESSAGE));
    return () => setDemoReadOnlyHandler(null);
  }, [snackbar]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireSession />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/import" element={<ImportReportPage />} />
          <Route path="/interviews" element={<InterviewsPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/settings" element={<Navigate to="/settings/gmail" replace />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
