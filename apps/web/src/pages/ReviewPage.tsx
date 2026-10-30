import type { ReviewAction, ReviewItem, ReviewKind } from "@offerbound/contracts";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  isApiError,
  useNavCounts,
  useResolveReviewItem,
  useReviewItems,
  useSettings,
  useTimezone,
  type ReviewListState,
} from "../api/hooks";
import { EmailSheet } from "../components/EmailSheet";
import { ReviewEditDialog } from "../components/ReviewEditDialog";
import { Key } from "../components/ShortcutDialog";
import { EmptyState, ErrorState, ListSkeleton } from "../components/States";
import { FlagChip } from "../components/StatusChip";
import { useUndoSnackbar } from "../components/UndoSnackbar";
import { formatDateTime, formatTime, localDayKey } from "../lib/format";
import { useLinkSx } from "../lib/link-sx";
import { useListKeyboard } from "../lib/shortcuts";

/**
 * Review (DESIGN_SPEC §5.5; AC-5.1–5.3): the decisions the automation needs. One card per item with
 * the email it came from, the kind's own body and the kind's own actions. Nothing changes until an
 * action is chosen. The tab lives in the address.
 */

const TABS: { key: ReviewListState; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
];
const DEFAULT_TAB: ReviewListState = "open";

const KIND_LABEL: Record<ReviewKind, string> = {
  low_confidence: "Not sure",
  ambiguous_match: "Which application?",
  unexpected_transition: "Unexpected change",
  possible_duplicate_company: "Same company?",
  extraction_failed: "Couldn't read",
  undone_change: "Undone change",
};

const STATE_LABEL: Record<Exclude<ReviewItem["state"], "open">, string> = {
  resolved: "Resolved",
  dismissed: "Dismissed",
};

/** The repeated verb of DESIGN_SPEC §10, one line per action. */
const DONE: Record<ReviewAction, string> = {
  apply: "Applied the change",
  edit_apply: "Applied your edits",
  dismiss: "Dismissed",
  attach: "Attached the email",
  create_new: "Created a new application",
  reopen: "Reopened the application",
  timeline_only: "Added to the timeline",
  merge: "Merged the companies",
  same_group: "Marked as the same group",
  keep_separate: "Kept the companies separate",
  retry: "Reading the email again",
  reprocess: "Reprocessing the email",
  ignore: "Ignored",
};

const CHANGED_ELSEWHERE = "Changes were made elsewhere. Review has been refreshed.";
const NOT_SAVED = "Couldn't save your choice. Try again.";

function readTab(params: URLSearchParams): ReviewListState {
  return TABS.find((t) => t.key === params.get("tab"))?.key ?? DEFAULT_TAB;
}

const percent = (fraction: number) => Math.round(fraction * 100);

/** "Today, 07:08" for today, otherwise "Oct 28, 18:20", in the owner's time zone. */
function whenLabel(iso: string, timezone: string, now: Date): string {
  return localDayKey(iso, timezone) === localDayKey(now, timezone)
    ? `Today, ${formatTime(iso, timezone)}`
    : formatDateTime(iso, timezone);
}

// ---------------------------------------------------------------------------------------------
// One item

function EmailSummary({ item, onShow }: { item: ReviewItem; onShow: () => void }) {
  const linkSx = useLinkSx({ fontSize: 13 });
  const { message } = item;
  if (!message) return null;
  const from = message.fromEmail ?? message.fromName;
  const caption = [from ? `From ${from}.` : null, message.summary].filter(Boolean).join(" ");
  return (
    <Box
      sx={(theme) => ({
        bgcolor: theme.palette.tokens.surfaceSunken,
        borderRadius: "6px",
        px: 1.75,
        py: 1.5,
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        alignItems: "flex-start",
      })}
    >
      <Typography sx={{ fontWeight: 600 }}>{message.subject ?? "No subject"}</Typography>
      {caption ? (
        <Typography variant="caption" color="text.secondary" component="p">
          {caption}
        </Typography>
      ) : null}
      <Link component="button" type="button" onClick={onShow} sx={linkSx}>
        Show the email
      </Link>
    </Box>
  );
}

/** *Confidence 64%. Changes apply on their own at 80% or more.* above a `role="meter"` (AC-5.1). */
function ConfidenceMeter({
  confidence,
  threshold,
}: {
  confidence: number;
  threshold: number | undefined;
}) {
  const captionId = useId();
  const value = Math.min(100, Math.max(0, percent(confidence)));
  const caption =
    threshold === undefined
      ? `Confidence ${value}%.`
      : `Confidence ${value}%. Changes apply on their own at ${percent(threshold)}% or more.`;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, maxWidth: 360 }}>
      <Typography id={captionId} variant="caption" color="text.secondary" component="p">
        {caption}
      </Typography>
      <Box
        role="meter"
        aria-label="Confidence"
        aria-describedby={captionId}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        sx={{ height: 6, borderRadius: "3px", bgcolor: "divider", overflow: "hidden" }}
      >
        <Box sx={{ width: `${value}%`, height: 6, borderRadius: "3px", bgcolor: "warning.main" }} />
      </Box>
    </Box>
  );
}

function Candidates({
  candidates,
  value,
  onChange,
}: {
  candidates: ReviewItem["candidates"];
  value: string;
  onChange: (id: string) => void;
}) {
  if (candidates.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No application matched this email. You can create a new one from it.
      </Typography>
    );
  }
  return (
    <FormControl component="fieldset" sx={{ gap: 1 }}>
      <FormLabel component="legend" sx={{ fontSize: 13, fontWeight: 600 }}>
        Attach it to
      </FormLabel>
      <RadioGroup value={value} onChange={(e) => onChange(e.target.value)} sx={{ gap: 1 }}>
        {candidates.map((c) => (
          <FormControlLabel
            key={c.id}
            value={c.id}
            control={<Radio />}
            label={c.label}
            sx={(theme) => ({
              m: 0,
              minHeight: 44,
              pr: 1.5,
              border: 1,
              borderRadius: "6px",
              borderColor: value === c.id ? "primary.main" : "divider",
              bgcolor: value === c.id ? theme.palette.tokens.routeTint : "transparent",
              "& .MuiFormControlLabel-label": { fontWeight: 600 },
            })}
          />
        ))}
      </RadioGroup>
    </FormControl>
  );
}

interface ActionSpec {
  key: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

interface CardProps {
  item: ReviewItem;
  timezone: string;
  now: Date;
  threshold: number | undefined;
  busy: boolean;
  rowProps: object;
  focused: boolean;
  onResolve: (item: ReviewItem, resolve: { action: ReviewAction; applicationId?: string }) => void;
  onEdit: (item: ReviewItem) => void;
  onShowEmail: (messageId: string) => void;
}

function ReviewCard({
  item,
  timezone,
  now,
  threshold,
  busy,
  rowProps,
  focused,
  onResolve,
  onEdit,
  onShowEmail,
}: CardProps) {
  const headingId = useId();
  const [selected, setSelected] = useState("");
  const chosen = item.candidates.some((c) => c.id === selected) ? selected : "";
  const open = item.state === "open";

  const act =
    (action: ReviewAction): ActionSpec["onClick"] =>
    () =>
      onResolve(item, { action });
  const actions: ActionSpec[] = (() => {
    switch (item.kind) {
      case "low_confidence":
        return [
          { key: "apply", label: "Apply change", onClick: act("apply") },
          { key: "edit", label: "Edit and apply", onClick: () => onEdit(item) },
          { key: "dismiss", label: "Dismiss", onClick: act("dismiss") },
        ];
      case "ambiguous_match":
        return [
          {
            key: "attach",
            label: "Attach email",
            disabled: chosen === "",
            onClick: () => onResolve(item, { action: "attach", applicationId: chosen }),
          },
          { key: "create_new", label: "Create new application", onClick: act("create_new") },
          { key: "dismiss", label: "Dismiss", onClick: act("dismiss") },
        ];
      case "unexpected_transition":
        return [
          { key: "reopen", label: "Reopen application", onClick: act("reopen") },
          { key: "timeline_only", label: "Add to timeline only", onClick: act("timeline_only") },
        ];
      case "possible_duplicate_company":
        return [
          { key: "merge", label: "Merge companies", onClick: act("merge") },
          {
            key: "same_group",
            label: "Same group, different companies",
            onClick: act("same_group"),
          },
          { key: "keep_separate", label: "Keep separate", onClick: act("keep_separate") },
        ];
      case "extraction_failed":
        return [
          { key: "retry", label: "Retry", onClick: act("retry") },
          { key: "dismiss", label: "Dismiss", onClick: act("dismiss") },
        ];
      case "undone_change":
        return [
          { key: "reprocess", label: "Reprocess", onClick: act("reprocess") },
          { key: "ignore", label: "Ignore", onClick: act("ignore") },
        ];
    }
  })();

  const { operations } = item.proposal;
  return (
    <Paper
      component="li"
      variant="outlined"
      aria-labelledby={headingId}
      {...rowProps}
      {...(focused ? { "aria-current": "true" } : {})}
      sx={{
        listStyle: "none",
        p: { xs: 2, sm: 2.5 },
        display: "flex",
        flexDirection: "column",
        gap: 1.75,
        "&[aria-current='true']": {
          outline: (theme) => `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 0,
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
          <FlagChip tone="neutral" label={KIND_LABEL[item.kind]} size="small" />
          {item.state !== "open" ? (
            <FlagChip tone="route" label={STATE_LABEL[item.state]} size="small" />
          ) : null}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {whenLabel(item.createdAt, timezone, now)}
        </Typography>
      </Box>

      <Typography id={headingId} variant="h6" component="h2">
        {item.proposal.description}
      </Typography>

      {item.message ? (
        <EmailSummary
          item={item}
          onShow={() => {
            if (item.message) onShowEmail(item.message.id);
          }}
        />
      ) : null}

      {item.kind === "ambiguous_match" && open ? (
        <Candidates candidates={item.candidates} value={chosen} onChange={setSelected} />
      ) : null}

      {operations.length > 0 ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            Proposed change
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {operations.map((op, i) => (
              <Typography key={i} component="li">
                {op.summary}
              </Typography>
            ))}
          </Box>
        </Box>
      ) : null}

      {item.confidence !== null ? (
        <ConfidenceMeter confidence={item.confidence} threshold={threshold} />
      ) : null}

      {open ? (
        <Box role="group" aria-label="Actions" sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
          {actions.map((a, i) => (
            <Button
              key={a.key}
              variant={i === 0 ? "outlined" : "text"}
              disabled={busy || a.disabled === true}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </Box>
      ) : null}
    </Paper>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const tab = readTab(params);
  const timezone = useTimezone();
  const settings = useSettings();
  const navCounts = useNavCounts();
  const query = useReviewItems(tab);
  const snackbar = useUndoSnackbar();

  const [emailId, setEmailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReviewItem | null>(null);

  // One change at a time per item: a second press would answer an item that is already settled.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(new Set<string>());
  const settle = (id: string) => {
    busy.current.delete(id);
    setPending(new Set(busy.current));
  };

  const resolve = useResolveReviewItem({
    onSuccess: (_resolved, { item, resolve: choice }) => {
      settle(item.id);
      snackbar.show(DONE[choice.action]);
    },
    onError: (error, { item }) => {
      settle(item.id);
      snackbar.show(isApiError(error, "version_conflict") ? CHANGED_ELSEWHERE : NOT_SAVED);
    },
  });
  const onResolve: CardProps["onResolve"] = (item, choice) => {
    if (busy.current.has(item.id)) return;
    busy.current.add(item.id);
    setPending(new Set(busy.current));
    resolve.mutate({ item, resolve: choice });
  };

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // One "now" per answer, so "Today, 07:08" versus "Oct 28" stays still while the owner reads.
  const now = useMemo(() => new Date(), [query.dataUpdatedAt]);
  const { focusedIndex, getRowProps } = useListKeyboard(items, {
    // Enter shows the email behind the focused card.
    onOpen: (item) => {
      if (item.message) setEmailId(item.message.id);
    },
  });

  const threshold = settings.data?.automation.autoApplyMinConfidence;
  const openCount = navCounts.data?.openReview;

  const selectTab = (value: ReviewListState) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === DEFAULT_TAB) next.delete("tab");
        else next.set("tab", value);
        return next;
      },
      { replace: true },
    );

  const caption =
    tab === "resolved"
      ? "Decisions you have already made."
      : openCount === undefined
        ? "Nothing changes until you choose."
        : openCount === 0
          ? "Nothing needs a decision right now."
          : `${openCount} ${openCount === 1 ? "email needs" : "emails need"} a decision. Nothing changes until you choose.`;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Box component="header" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="h4" component="h1">
          Review
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {caption}
        </Typography>
      </Box>

      <Tabs
        value={tab}
        aria-label="Review lists"
        onChange={(_event, value: ReviewListState) => selectTab(value)}
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 44 }}
      >
        {TABS.map((t) => {
          // The API has no total for the Resolved list, so only Open carries a count.
          const count = t.key === "open" ? openCount : undefined;
          return (
            <Tab
              key={t.key}
              value={t.key}
              id={`review-tab-${t.key}`}
              aria-controls="review-panel"
              sx={{ minHeight: 44, minWidth: 0, px: 0.5, mr: 3, fontWeight: 600 }}
              label={
                <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                  {t.label}
                  {count !== undefined ? (
                    <Box
                      component="span"
                      sx={(theme) => ({
                        fontSize: 12,
                        lineHeight: "18px",
                        px: 0.75,
                        borderRadius: "9px",
                        bgcolor: theme.palette.tokens.surfaceSunken,
                        color: "text.secondary",
                      })}
                    >
                      {count}
                    </Box>
                  ) : null}
                </Box>
              }
            />
          );
        })}
      </Tabs>

      <Box
        id="review-panel"
        role="tabpanel"
        aria-labelledby={`review-tab-${tab}`}
        sx={{ display: "flex", flexDirection: "column", gap: 2 }}
      >
        {query.isError ? (
          <ErrorState
            what="review items"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : query.isPending ? (
          <ListSkeleton label="Loading review items" rows={3} />
        ) : items.length === 0 ? (
          tab === "open" ? (
            <EmptyState title="Nothing to review. Changes Offerbound is sure about are applied on their own." />
          ) : (
            <EmptyState title="Nothing resolved yet." body="Items you decide on are listed here." />
          )
        ) : (
          <>
            <Box
              component="ul"
              aria-label={tab === "open" ? "Open review items" : "Resolved review items"}
              sx={{ m: 0, p: 0, display: "flex", flexDirection: "column", gap: 2 }}
            >
              {items.map((item, i) => (
                <ReviewCard
                  key={item.id}
                  item={item}
                  timezone={timezone}
                  now={now}
                  threshold={threshold}
                  busy={pending.has(item.id)}
                  rowProps={getRowProps(i)}
                  focused={i === focusedIndex}
                  onResolve={onResolve}
                  onEdit={setEditing}
                  onShowEmail={setEmailId}
                />
              ))}
            </Box>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1.5,
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                component="p"
                sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75 }}
              >
                Keys: <Key>j</Key> <Key>k</Key> move, <Key>Enter</Key> shows the email, <Key>?</Key>{" "}
                all shortcuts
              </Typography>
              {query.hasNextPage ? (
                <Button
                  variant="outlined"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Show more
                </Button>
              ) : null}
            </Box>
          </>
        )}
      </Box>

      <EmailSheet messageId={emailId} onClose={() => setEmailId(null)} timezone={timezone} />
      <ReviewEditDialog item={editing} onClose={() => setEditing(null)} />
    </Box>
  );
}
