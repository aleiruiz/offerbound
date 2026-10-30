import type { ApplicationStatus } from "@offerbound/contracts";
import Box from "@mui/material/Box";
import Step from "@mui/material/Step";
import StepConnector, { stepConnectorClasses } from "@mui/material/StepConnector";
import Stepper from "@mui/material/Stepper";
import Typography from "@mui/material/Typography";
import { styled } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import { STATUS_LABEL, StatusChip } from "./StatusChip";

/** The five stops of the route, in order (DESIGN_SPEC §6.2). */
export const ROUTE_STOPS = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
] as const satisfies readonly ApplicationStatus[];

const CLOSED = [
  "rejected",
  "withdrawn",
  "abandoned",
] as const satisfies readonly ApplicationStatus[];

const MARKER_MS = 400;

/** 24px stops on the route, 16px on phones (counts shrink from 32px to 20px with them). */
const DISC = { xs: 16, sm: 24 };

const RouteConnector = styled(StepConnector)(({ theme }) => ({
  // alternativeLabel connectors run between the stops at the disc's vertical center.
  [theme.breakpoints.up("sm")]: { top: 10, left: "calc(-50% + 16px)", right: "calc(50% + 16px)" },
  [theme.breakpoints.down("sm")]: { top: 6, left: "calc(-50% + 12px)", right: "calc(50% + 12px)" },
  [`& .${stepConnectorClasses.line}`]: {
    borderTopWidth: 4,
    borderColor: theme.palette.divider,
    borderRadius: 2,
  },
}));

function stopHref(status: ApplicationStatus): string {
  return `/applications?status=${status}`;
}

function Stop({ status, count }: { status: (typeof ROUTE_STOPS)[number]; count: number }) {
  const hollow = count === 0;
  return (
    <Step component="li" sx={{ px: 0 }}>
      <Box
        data-stop-status={status}
        data-hollow={hollow ? "true" : "false"}
        aria-hidden="true"
        sx={(theme) => ({
          position: "relative",
          mx: "auto",
          width: DISC,
          height: DISC,
          borderRadius: "50%",
          boxSizing: "border-box",
          bgcolor: hollow ? "background.paper" : theme.palette.status[status].main,
          border: hollow ? `3px solid ${theme.palette.status[status].main}` : "none",
          boxShadow: `0 0 0 4px ${theme.palette.background.paper}`,
        })}
      />
      <Box
        component={RouterLink}
        to={stopHref(status)}
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          mt: 1,
          color: "text.primary",
          textDecoration: "none",
          borderRadius: "4px",
        }}
      >
        <Typography
          component="span"
          variant="h3"
          sx={{ fontSize: { xs: 20, sm: 32 }, lineHeight: { xs: "24px", sm: "36px" } }}
        >
          {count}
        </Typography>
        <Typography
          component="span"
          variant="subtitle2"
          sx={(theme) => ({
            color: theme.palette.status[status].main,
            // Five stops share a phone's width: a smaller label that may break keeps them apart.
            [theme.breakpoints.down("sm")]: {
              fontSize: 11,
              lineHeight: "14px",
              maxWidth: "100%",
              overflowWrap: "anywhere",
              textAlign: "center",
            },
          })}
        >
          {STATUS_LABEL[status]}
        </Typography>
      </Box>
    </Step>
  );
}

/** The application's marker: slides to its new stop in 400 ms ease-out, or jumps under reduced motion. */
function Marker({ from, to }: { from: ApplicationStatus; to: ApplicationStatus }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const toIndex = ROUTE_STOPS.indexOf(to as (typeof ROUTE_STOPS)[number]);
  const fromIndex = ROUTE_STOPS.indexOf(from as (typeof ROUTE_STOPS)[number]);
  const [at, setAt] = useState(reduced || fromIndex < 0 ? toIndex : fromIndex);

  useEffect(() => {
    if (reduced) {
      setAt(toIndex);
      return;
    }
    const frame = requestAnimationFrame(() => setAt(toIndex));
    return () => cancelAnimationFrame(frame);
  }, [toIndex, reduced]);

  return (
    <Box
      data-testid="route-marker"
      data-stop={to}
      role="img"
      aria-label={`This application is at ${STATUS_LABEL[to]}`}
      style={{
        left: `${(at + 0.5) * (100 / ROUTE_STOPS.length)}%`,
        ...(reduced ? {} : { transition: `left ${MARKER_MS}ms ease-out` }),
      }}
      sx={(theme) => ({
        position: "absolute",
        top: { xs: 8, sm: 12 },
        width: { xs: 8, sm: 10 },
        height: { xs: 8, sm: 10 },
        transform: "translate(-50%, -50%)",
        borderRadius: "50%",
        bgcolor: "text.primary",
        boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
        pointerEvents: "none",
        zIndex: 1,
      })}
    />
  );
}

export interface PipelineRouteProps {
  /** Application counts per status; a missing status counts as 0. */
  byStatus: Partial<Record<ApplicationStatus, number>>;
  /** While the owner is looking, a status change slides the marker from one stop to the next. */
  movement?: {
    from: ApplicationStatus;
    to: ApplicationStatus;
    /** Tells one movement from the next, so each starts at its own `from` stop. */
    key?: string | number;
  };
}

/**
 * The pipeline as a route line (DESIGN_SPEC §6.2): five stops with counts, each linking to
 * Applications filtered by that stage, and the closed branch below the first stop.
 */
export function PipelineRoute({ byStatus, movement }: PipelineRouteProps) {
  const count = (s: ApplicationStatus) => byStatus[s] ?? 0;
  const onLine = movement && (ROUTE_STOPS as readonly string[]).includes(movement.to);
  return (
    <Box sx={{ overflowX: "auto" }}>
      <Box
        sx={{ minWidth: { xs: 320, sm: 640 }, display: "flex", flexDirection: "column", gap: 2 }}
      >
        <Box sx={{ position: "relative" }}>
          <Stepper
            component="ol"
            alternativeLabel
            nonLinear
            connector={<RouteConnector />}
            aria-label="Active applications by stage"
            sx={{ m: 0, p: 0, listStyle: "none" }}
          >
            {ROUTE_STOPS.map((status) => (
              <Stop key={status} status={status} count={count(status)} />
            ))}
          </Stepper>
          {movement && onLine ? (
            <Marker
              key={movement.key ?? `${movement.from}>${movement.to}`}
              from={movement.from}
              to={movement.to}
            />
          ) : null}
        </Box>
        <Box
          role="group"
          aria-label="Closed"
          sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, pl: "4%" }}
        >
          <Box
            aria-hidden="true"
            sx={{
              width: 28,
              height: 16,
              mt: "-12px",
              borderLeft: 3,
              borderBottom: 3,
              borderColor: "divider",
              borderBottomLeftRadius: 6,
            }}
          />
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            Closed
          </Typography>
          {CLOSED.map((status) => (
            <Box
              key={status}
              component={RouterLink}
              to={stopHref(status)}
              sx={{ textDecoration: "none", borderRadius: "4px", display: "inline-flex" }}
            >
              <StatusChip status={status} label={`${STATUS_LABEL[status]} ${count(status)}`} />
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
