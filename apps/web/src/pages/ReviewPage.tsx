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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  isConflict,
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
import { DemoLock, type DemoReason } from "../lib/demo";
import { msg, t, tc, tn, tx } from "../i18n";

/**
 * Review (DESIGN_SPEC §5.5; AC-5.1–5.3): the decisions the automation needs. One card per item with
 * the email it came from, the kind's own body and the kind's own actions. Nothing changes until an
 * action is chosen. The tab lives in the address.
 */

const TABS: { key: ReviewListState; label: string }[] = [
  {
    key: "open",
    get label() {
      return tc("review tab", "Open");
    },
  },
  {
    key: "resolved",
    get label() {
      return tc("review tab", "Resolved");
    },
  },
];
const DEFAULT_TAB: ReviewListState = "open";

const KIND_LABEL: Record<ReviewKind, string> = {
  get low_confidence() {
    return t("Not sure");
  },
  get ambiguous_match() {
    return t("Which application?");
  },
  get unexpected_transition() {
    return t("Unexpected change");
  },
  get possible_duplicate_company() {
    return t("Same company?");
  },
  get extraction_failed() {
    return t("Couldn't read");
  },
  get undone_change() {
    return t("Undone change");
  },
};

const STATE_LABEL: Record<Exclude<ReviewItem["state"], "open">, string> = {
  get resolved() {
    return t("Resolved");
  },
  get dismissed() {
    return t("Dismissed");
  },
};

/** The repeated verb of DESIGN_SPEC §10, one line per action. */
const DONE: Record<ReviewAction, string> = {
  get apply() {
    return t("Applied the change");
  },
  get edit_apply() {
    return t("Applied your edits");
  },
  get dismiss() {
    return t("Dismissed");
  },
  get attach() {
    return t("Attached the email");
  },
  get create_new() {
    return t("Created a new application");
  },
  get reopen() {
    return t("Reopened the application");
  },
  get timeline_only() {
    return t("Added to the timeline");
  },
  get merge() {
    return t("Merged the companies");
  },
  get same_group() {
    return t("Marked as the same group");
  },
  get keep_separate() {
    return t("Kept the companies separate");
  },
  get retry() {
    return t("Reading the email again");
  },
  get reprocess() {
    return t("Reprocessing the email");
  },
  get ignore() {
    return t("Ignored");
  },
};

const CHANGED_ELSEWHERE = msg("Changes were made elsewhere. Review has been refreshed.");
const NOT_SAVED = msg("Couldn't save your choice. Try again.");

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
  const caption = [from ? t("From {sender}.", { sender: from }) : null, message.summary]
    .filter(Boolean)
    .join(" ");
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
      <Typography sx={{ fontWeight: 600 }}>{message.subject ?? t("No subject")}</Typography>
      {caption ? (
        <Typography variant="caption" color="text.secondary" component="p">
          {caption}
        </Typography>
      ) : null}
      <Link component="button" type="button" onClick={onShow} sx={linkSx}>
        {t("Show the email")}
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
      ? t("Confidence {value}%.", { value })
      : t("Confidence {value}%. Changes apply on their own at {threshold}% or more.", {
          value,
          threshold: percent(threshold),
        });
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, maxWidth: 360 }}>
      <Typography id={captionId} variant="caption" color="text.secondary" component="p">
        {caption}
      </Typography>
      <Box
        role="meter"
        aria-label={t("Confidence")}
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
        {t("No application matched this email. You can create a new one from it.")}
      </Typography>
    );
  }
  return (
    <FormControl component="fieldset" sx={{ gap: 1 }}>
      <FormLabel component="legend" sx={{ fontSize: 13, fontWeight: 600 }}>
        {t("Attach it to")}
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
  /** Turned off, with the reason, in the public demo. */
  lock?: DemoReason;
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
          { key: "apply", label: t("Apply change"), onClick: act("apply") },
          { key: "edit", label: t("Edit and apply"), onClick: () => onEdit(item), lock: "edit" },
          { key: "dismiss", label: t("Dismiss"), onClick: act("dismiss") },
        ];
      case "ambiguous_match":
        return [
          {
            key: "attach",
            label: t("Attach email"),
            disabled: chosen === "",
            onClick: () => onResolve(item, { action: "attach", applicationId: chosen }),
          },
          { key: "create_new", label: t("Create new application"), onClick: act("create_new") },
          { key: "dismiss", label: t("Dismiss"), onClick: act("dismiss") },
        ];
      case "unexpected_transition":
        return [
          { key: "reopen", label: t("Reopen application"), onClick: act("reopen") },
          { key: "timeline_only", label: t("Add to timeline only"), onClick: act("timeline_only") },
        ];
      case "possible_duplicate_company":
        return [
          { key: "merge", label: t("Merge companies"), onClick: act("merge") },
          {
            key: "same_group",
            label: t("Same group, different companies"),
            onClick: act("same_group"),
          },
          { key: "keep_separate", label: t("Keep separate"), onClick: act("keep_separate") },
        ];
      case "extraction_failed":
        return [
          { key: "retry", label: t("Retry"), onClick: act("retry") },
          { key: "dismiss", label: t("Dismiss"), onClick: act("dismiss") },
        ];
      case "undone_change":
        return [
          { key: "reprocess", label: t("Reprocess"), onClick: act("reprocess") },
          { key: "ignore", label: t("Ignore"), onClick: act("ignore") },
        ];
    }
  })();

  const { operations } = item.proposal;
  return (
    <Paper
      component="li"
      variant="outlined"
      aria-labelledby={headingId}
      data-review-id={item.id}
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
            {t("Proposed change")}
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
        <Box
          role="group"
          aria-label={t("Actions")}
          sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}
        >
          {actions.map((a, i) => {
            const button = (
              <Button
                key={a.key}
                variant={i === 0 ? "outlined" : "text"}
                disabled={busy || a.disabled === true}
                onClick={a.onClick}
              >
                {a.label}
              </Button>
            );
            return a.lock ? (
              <DemoLock key={a.key} reason={a.lock}>
                {button}
              </DemoLock>
            ) : (
              button
            );
          })}
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

  // When an item leaves the list, focus goes to the next card, or to the heading if none is left;
  // otherwise it would fall to the page and a keyboard owner would start again from the top.
  const heading = useRef<HTMLHeadingElement>(null);
  const itemsRef = useRef<ReviewItem[]>([]);
  const [leaving, setLeaving] = useState<{ id: string; nextId: string | null } | null>(null);
  const itemLeaves = (id: string) => {
    const list = itemsRef.current;
    const at = list.findIndex((i) => i.id === id);
    setLeaving({ id, nextId: (list[at + 1] ?? list[at - 1])?.id ?? null });
  };

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
      itemLeaves(item.id);
    },
    onError: (error, { item }) => {
      settle(item.id);
      snackbar.show(isConflict(error) ? t(CHANGED_ELSEWHERE) : NOT_SAVED);
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
  itemsRef.current = items;
  useEffect(() => {
    if (leaving === null || query.isFetching) return;
    if (items.some((i) => i.id === leaving.id)) {
      // Still listed (the choice kept it open): nothing left, nothing to move.
      setLeaving(null);
      return;
    }
    const next = leaving.nextId
      ? document.querySelector<HTMLElement>(`[data-review-id="${CSS.escape(leaving.nextId)}"]`)
      : null;
    (next ?? heading.current)?.focus();
    setLeaving(null);
  }, [leaving, items, query.isFetching]);
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
      ? t("Decisions you have already made.")
      : openCount === undefined
        ? t("Nothing changes until you choose.")
        : openCount === 0
          ? t("Nothing needs a decision right now.")
          : tn(
              openCount,
              "1 email needs a decision. Nothing changes until you choose.",
              "{count} emails need a decision. Nothing changes until you choose.",
            );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Box component="header" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography
          variant="h4"
          component="h1"
          ref={heading}
          tabIndex={-1}
          sx={{ outline: "none" }}
        >
          {t("Review")}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {caption}
        </Typography>
      </Box>

      <Tabs
        value={tab}
        aria-label={t("Review lists")}
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
            what={t("review items")}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : query.isPending ? (
          <ListSkeleton label={t("Loading review items")} rows={3} />
        ) : items.length === 0 ? (
          tab === "open" ? (
            <EmptyState
              title={t(
                t("Nothing to review. Changes Offerbound is sure about are applied on their own."),
              )}
            />
          ) : (
            <EmptyState
              title={t("Nothing resolved yet.")}
              body={t("Items you decide on are listed here.")}
            />
          )
        ) : (
          <>
            <Box
              component="ul"
              aria-label={tab === "open" ? t("Open review items") : t("Resolved review items")}
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
                sx={{
                  display: { xs: "none", sm: "flex" },
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 0.75,
                }}
              >
                {tx("Keys: {j} {k} move, {enter} shows the email, {help} all shortcuts", {
                  j: <Key>j</Key>,
                  k: <Key>k</Key>,
                  enter: <Key>Enter</Key>,
                  help: <Key>?</Key>,
                })}
              </Typography>
              {query.hasNextPage ? (
                <Button
                  variant="outlined"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {t("Show more")}
                </Button>
              ) : null}
            </Box>
          </>
        )}
      </Box>

      <EmailSheet messageId={emailId} onClose={() => setEmailId(null)} timezone={timezone} />
      <ReviewEditDialog item={editing} onClose={() => setEditing(null)} onResolved={itemLeaves} />
    </Box>
  );
}
