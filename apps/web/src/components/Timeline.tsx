import type { EventType, TimelineEvent } from "@offerbound/contracts";
import MailOutlineOutlined from "@mui/icons-material/MailOutlineOutlined";
import UndoOutlined from "@mui/icons-material/UndoOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useRef, type KeyboardEvent } from "react";
import { DEFAULT_TIMEZONE, formatDateTime } from "../lib/format";
import { isTypingTarget } from "../lib/shortcuts";

/** What the stop's shape says about the entry (DESIGN_SPEC §6.3): never color alone. */
export type StopKind = "auto" | "email" | "owner" | "lead";

export function stopKind(event: TimelineEvent): StopKind {
  if (event.type === "lead_created" || event.type === "imported") return "lead";
  if (event.type === "email_received" || event.type === "email_sent") return "email";
  if (event.actor === "owner") return "owner";
  // An application created from an email is shown as the email it came from.
  if (event.type === "application_created" && event.messageId !== null) return "email";
  return "auto";
}

/**
 * The automatic changes that write a change set, and so can be undone (TECHNICAL_SPEC §6.6). An
 * entry of another type (a reminder, an email, an undo) never could be, so it says nothing.
 */
const UNDOABLE_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "application_created",
  "status_changed",
  "field_updated",
  "interview_created",
  "interview_updated",
  "interview_cancelled",
  "interview_completed",
  "abandoned",
  "reopened",
  "lead_converted",
]);

/** An entry that could have been undone but no longer can: the application changed after it. */
function lostUndo(event: TimelineEvent): boolean {
  if (event.undoable || event.undoneAt !== null || !UNDOABLE_TYPES.has(event.type)) return false;
  // Marking a lead as applied is the owner's own action, and it is undoable too.
  return event.actor === "system" || event.type === "lead_converted";
}

const STOP_BOX = 20;

function Stop({ event }: { event: TimelineEvent }) {
  const kind = stopKind(event);
  // A status event is colored by the status it moved to; without one the disc is neutral.
  const status = kind === "auto" ? event.toStatus : null;
  return (
    <Box
      data-stop={kind}
      {...(status ? { "data-status": status } : {})}
      aria-hidden="true"
      sx={(theme) => {
        const ring = `0 0 0 3px ${theme.palette.background.paper}`;
        const base = { position: "relative", zIndex: 1, boxSizing: "border-box" } as const;
        switch (kind) {
          case "auto":
            return {
              ...base,
              width: STOP_BOX,
              height: STOP_BOX,
              borderRadius: "50%",
              bgcolor: status ? theme.palette.status[status].main : theme.palette.text.secondary,
              boxShadow: ring,
            };
          case "email":
            return {
              ...base,
              width: STOP_BOX,
              height: STOP_BOX,
              borderRadius: "50%",
              bgcolor: "background.paper",
              border: `3px solid ${theme.palette.text.secondary}`,
            };
          case "owner":
            return {
              ...base,
              width: 18,
              height: 18,
              borderRadius: "3px",
              bgcolor: "text.primary",
              boxShadow: ring,
            };
          case "lead":
            return {
              ...base,
              width: 18,
              height: 18,
              borderRadius: "3px",
              bgcolor: "background.paper",
              border: `3px solid ${theme.palette.text.secondary}`,
            };
        }
      }}
    />
  );
}

/** Bold the leading phrase ("Moved to Interviewing") of a sentence like "Moved to X and added Y". */
function Summary({ text }: { text: string }) {
  const cut = text.indexOf(" and ");
  if (cut <= 0) return <strong>{text}</strong>;
  return (
    <>
      <strong>{text.slice(0, cut)}</strong>
      {text.slice(cut)}
    </>
  );
}

/** A new entry fades in over 400 ms (DESIGN_SPEC §8). */
const FADE_IN_MS = 400;
const fadeIn = keyframes`from { opacity: 0; } to { opacity: 1; }`;

/**
 * The ids of entries that arrived after the first render, for the fade-in. What is there when the
 * list first shows never fades (no entrance animation on page load).
 */
function useArrivedAfterFirstRender(events: TimelineEvent[]): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const arrived = useRef(new Set<string>());
  if (known.current === null) {
    known.current = new Set(events.map((e) => e.id));
  } else {
    for (const { id } of events) {
      if (!known.current.has(id)) {
        known.current.add(id);
        arrived.current.add(id);
      }
    }
  }
  return arrived.current;
}

export interface TimelineProps {
  events: TimelineEvent[];
  /** Undo the automatic change with this event id. */
  onUndo: (eventId: string) => void;
  /** Open the source email. */
  onViewEmail: (messageId: string) => void;
  /** The owner's time zone (from `GET /me`). */
  timezone?: string;
}

/**
 * The application timeline (DESIGN_SPEC §6.3): an ordered list, newest first, with a stop whose
 * shape says where the entry came from. `u` undoes the focused entry.
 */
export function Timeline({
  events,
  onUndo,
  onViewEmail,
  timezone = DEFAULT_TIMEZONE,
}: TimelineProps) {
  const arrived = useArrivedAfterFirstRender(events);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const sorted = [...events].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  return (
    <Box
      component="ol"
      aria-label="Application timeline"
      sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column" }}
    >
      {sorted.map((event) => {
        const canUndo = event.undoable && event.undoneAt === null;
        const cannotUndo = lostUndo(event);
        const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
          if (e.key !== "u" || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target))
            return;
          if (canUndo) {
            e.preventDefault();
            onUndo(event.id);
          }
        };
        return (
          <Box
            key={event.id}
            component="li"
            data-event-id={event.id}
            data-entering={arrived.has(event.id) && !reduced ? "true" : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
            sx={{
              display: "flex",
              gap: 2,
              pb: 3,
              borderRadius: "4px",
              ...(arrived.has(event.id) && !reduced
                ? { animation: `${fadeIn} ${FADE_IN_MS}ms ease-out` }
                : {}),
              "&:last-of-type": { pb: 0 },
              "&:last-of-type .rail::before": { display: "none" },
            }}
          >
            <Box
              className="rail"
              sx={{
                position: "relative",
                flex: `0 0 ${STOP_BOX}px`,
                display: "flex",
                justifyContent: "center",
                pt: "1px",
                "&::before": {
                  content: '""',
                  position: "absolute",
                  left: "calc(50% - 1.5px)",
                  top: 12,
                  bottom: -24,
                  width: 3,
                  bgcolor: "divider",
                },
              }}
            >
              <Stop event={event} />
            </Box>
            <Box
              sx={{
                flex: "1 1 auto",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 0.5,
              }}
            >
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(event.occurredAt, timezone)}
              </Typography>
              <Typography variant="body1">
                <Summary text={event.summary} />
              </Typography>
              {event.undoneAt !== null ? (
                <Typography variant="caption" color="text.secondary">
                  {`Undone on ${formatDateTime(event.undoneAt, timezone)}`}
                </Typography>
              ) : null}
              {cannotUndo ? (
                <Typography variant="caption" color="text.secondary">
                  Can't undo: the application changed after this.
                </Typography>
              ) : null}
              {canUndo || event.messageId !== null ? (
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, ml: -1 }}>
                  {canUndo ? (
                    <Button
                      size="small"
                      startIcon={<UndoOutlined />}
                      onClick={() => onUndo(event.id)}
                    >
                      Undo
                    </Button>
                  ) : null}
                  {event.messageId !== null ? (
                    <Button
                      size="small"
                      startIcon={<MailOutlineOutlined />}
                      onClick={() => onViewEmail(event.messageId as string)}
                    >
                      View email
                    </Button>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
