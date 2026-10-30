import LockOutlined from "@mui/icons-material/LockOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import GlobalStyles from "@mui/material/GlobalStyles";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useSearchParams } from "react-router";

const SIGN_IN_URL = "/api/v1/auth/google/start";
const DEMO_URL = "https://offerbound.northsoftmx.com";

// Colours of the identity band and route line (DESIGN_SPEC §5.9, Login.dc.html).
const INK = "#16202e";
const PAPER = "#f4f6f3";
const SIGNAL = "#f2b24c";

const BAND = [
  { weight: 18, color: "#2f55a4" },
  { weight: 14, color: "#6a46a8" },
  { weight: 46, color: "#0a7356" },
  { weight: 22, color: SIGNAL },
] as const;

const STOPS = [
  { left: 9, label: "Applied", mid: false },
  { left: 25, label: "Screening", mid: true },
  { left: 45, label: "Assessment", mid: true },
  { left: 63, label: "Interviewing", mid: true },
] as const;

// Inline styles are allowed by the CSP (SECURITY §10), so the animation lives in a GlobalStyles block.
const loginStyles = {
  ".ob-hero": {
    position: "relative",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    flex: "3 1 560px",
    minWidth: 0,
    minHeight: 520,
    background: INK,
    color: PAPER,
  },
  ".ob-band, .ob-line": {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: "58%",
  },
  ".ob-band": { display: "flex" },
  ".ob-rail": {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: 8,
    marginTop: -4,
    background: PAPER,
  },
  ".ob-stop": {
    position: "absolute",
    top: "50%",
    width: 20,
    height: 20,
    margin: "-10px 0 0 -10px",
    borderRadius: 10,
    background: PAPER,
  },
  ".ob-stop-offer": {
    width: 44,
    height: 44,
    margin: "-22px 0 0 -22px",
    borderRadius: 22,
    boxShadow: `inset 0 0 0 10px ${INK}`,
  },
  ".ob-stop-label": {
    position: "absolute",
    top: "calc(50% + 22px)",
    transform: "translateX(-50%)",
    fontSize: 13,
    lineHeight: "18px",
    fontWeight: 700,
    color: PAPER,
    whiteSpace: "nowrap",
  },
  ".ob-stop-label-offer": {
    top: "calc(50% + 32px)",
    color: INK,
    fontSize: 15,
    fontWeight: 900,
  },
  ".ob-marker": {
    position: "absolute",
    top: "50%",
    left: "9%",
    width: 14,
    height: 14,
    margin: "-7px 0 0 -7px",
    borderRadius: 7,
    background: INK,
    boxShadow: `0 0 0 3px ${SIGNAL}`,
    animation: "ob-ride 2.6s cubic-bezier(.45,0,.2,1) .4s both",
  },
  "@keyframes ob-ride": {
    "0%": { left: "9%" },
    "22%": { left: "25%" },
    "44%": { left: "45%" },
    "66%": { left: "63%" },
    "100%": { left: "89%" },
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".ob-marker": { animation: "none", left: "89%" },
  },
  "@media (max-width: 640px)": {
    ".ob-stop-label-mid": { display: "none" },
  },
};

export function LoginPage() {
  const [params] = useSearchParams();
  const expired = params.get("error") === "expired";

  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        minHeight: "100vh",
        bgcolor: "background.default",
        color: "text.primary",
      }}
    >
      <GlobalStyles styles={loginStyles} />

      <section className="ob-hero" aria-label="Offerbound">
        <div className="ob-band" aria-hidden="true">
          {BAND.map((segment) => (
            <div
              key={segment.color}
              style={{ flex: `${segment.weight} 1 0`, background: segment.color }}
            />
          ))}
        </div>
        <div className="ob-line" aria-hidden="true">
          <div className="ob-rail" />
          {STOPS.map((stop) => (
            <span key={stop.label} className="ob-stop" style={{ left: `${stop.left}%` }} />
          ))}
          <span className="ob-stop ob-stop-offer" style={{ left: "89%" }} />
          {STOPS.map((stop) => (
            <span
              key={stop.label}
              className={stop.mid ? "ob-stop-label ob-stop-label-mid" : "ob-stop-label"}
              style={{ left: `${stop.left}%` }}
            >
              {stop.label}
            </span>
          ))}
          <span className="ob-stop-label ob-stop-label-offer" style={{ left: "89%" }}>
            Offer
          </span>
          <span className="ob-marker" data-testid="route-marker" aria-hidden="true" />
        </div>
        <Box
          sx={{
            position: "relative",
            px: "max(16px, 4vw)",
            pb: 6,
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          <Typography
            component="p"
            sx={{
              fontSize: "clamp(44px, 8.4vw, 132px)",
              lineHeight: 0.9,
              fontWeight: 900,
              letterSpacing: "-0.035em",
              color: PAPER,
            }}
          >
            Offerbound
          </Typography>
          <Typography
            component="p"
            sx={{ maxWidth: 460, fontSize: 18, lineHeight: "26px", color: "#c3cbc8" }}
          >
            Every application, interview and lead, kept current from your inbox. Next stop: the
            offer.
          </Typography>
        </Box>
      </section>

      <Box
        component="section"
        aria-labelledby="signin-heading"
        sx={{
          flex: "2 1 400px",
          minWidth: 0,
          py: 7,
          px: "max(16px, 4vw)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <Box
          sx={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 3 }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            {window.location.host}
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <Typography
              id="signin-heading"
              component="h1"
              sx={{ fontSize: 40, lineHeight: "44px", fontWeight: 800, letterSpacing: "-0.02em" }}
            >
              Welcome back
            </Typography>
            <Typography color="text.secondary">
              This Offerbound is private. Sign in with its owner's Google account.
            </Typography>
          </Box>
          {expired && <Alert severity="error">Sign-in took too long. Try again.</Alert>}
          <Button
            component="a"
            href={SIGN_IN_URL}
            variant="contained"
            fullWidth
            sx={{ height: 48, px: 3, fontSize: 16, lineHeight: "22px", fontWeight: 700 }}
          >
            Sign in with Google
          </Button>
          <Paper sx={{ display: "flex", gap: 1.5, px: 2, py: "14px" }}>
            <LockOutlined
              sx={{ fontSize: 20, mt: "1px", flexShrink: 0, color: "text.secondary" }}
              aria-hidden
            />
            <Typography variant="body2" color="text.secondary">
              <Box component="span" sx={{ fontWeight: 700, color: "text.primary" }}>
                Read-only Gmail access.
              </Box>{" "}
              Offerbound never sends, deletes or labels email. Google will say the app isn't
              verified; that's expected for a personal app.
            </Typography>
          </Paper>
          <Typography variant="body2" color="text.secondary">
            Just looking around?{" "}
            <Link href={DEMO_URL} underline="none" sx={{ fontWeight: 700 }}>
              Open the public demo
            </Link>
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
