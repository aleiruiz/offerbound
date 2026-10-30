import {
  LeadStatusSchema,
  type Lead,
  type LeadStatus,
  type SearchRun,
} from "@offerbound/contracts";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useRef } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import {
  LEADS_COUNT_LIMIT,
  isApiError,
  isConflict,
  useLeadCounts,
  useLeads,
  useMarkLeadApplied,
  useReconsiderLead,
  useRefreshLeads,
  useRunSearch,
  useSearchRuns,
  useSetLeadStatus,
  useSettings,
  useTimezone,
  useUndoEvent,
  type LeadCount,
  type LeadFilters,
  type LeadSort,
} from "../api/hooks";
import { FilterChip } from "../components/FilterChip";
import { LeadRow } from "../components/LeadRow";
import { Key } from "../components/ShortcutDialog";
import { EmptyState, ErrorState, ListSkeleton } from "../components/States";
import { useUndoSnackbar } from "../components/UndoSnackbar";
import { formatShortDate, formatTime, localDayKey } from "../lib/format";
import { useLinkSx } from "../lib/link-sx";
import { useListKeyboard } from "../lib/shortcuts";
import { isHttpUrl } from "../lib/url";

/**
 * Leads (DESIGN_SPEC §5.4, §6.4, §9.3; AC-9.2, 9.6, 9.7, 10.2, 12.3, 12.4): the five lists as tabs,
 * track chips, the sort, one row per lead with its actions and the keys that do the same, and the
 * progress card while a search runs. The tab, the track and the sort live in the address.
 */

const TABS: { key: LeadStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "shortlisted", label: "Shortlisted" },
  { key: "applied", label: "Applied" },
  { key: "dismissed", label: "Dismissed" },
  { key: "suppressed", label: "Suppressed" },
];
const DEFAULT_TAB: LeadStatus = "new";

const SORTS: { value: LeadSort; label: string }[] = [
  { value: "track_fit", label: "Track, then fit" },
  { value: "newest", label: "Newest first" },
];
const DEFAULT_SORT: LeadSort = "track_fit";

const SEARCH_ROUNDS = 3;
const SEARCH_RUNNING = "A search is already running";
const CHANGED_ELSEWHERE = "Changes were made elsewhere. Leads have been refreshed.";

/** Each list's own empty state (DESIGN_SPEC §7: empty states name the next action). */
const EMPTY: Record<Exclude<LeadStatus, "new">, { title: string; body: string }> = {
  shortlisted: {
    title: "No shortlisted leads",
    body: "Shortlist a lead from New to keep it here while you decide.",
  },
  applied: {
    title: "No applied leads",
    body: "Leads you mark as applied are listed here, with a link to their application.",
  },
  dismissed: {
    title: "No dismissed leads",
    body: "Dismissed leads are kept here, and you can reconsider any of them.",
  },
  suppressed: {
    title: "No suppressed leads",
    body: "Leads Offerbound set aside, for example from companies you already know, are listed here with the reason.",
  },
};

function readFilters(params: URLSearchParams): LeadFilters {
  const status = LeadStatusSchema.safeParse(params.get("tab"));
  const track = params.get("track");
  return {
    status: status.success ? status.data : DEFAULT_TAB,
    track: track && track.trim() !== "" ? track : null,
    sort: SORTS.find((s) => s.value === params.get("sort"))?.value ?? DEFAULT_SORT,
  };
}

const nextParams =
  (change: (next: URLSearchParams) => void) =>
  (prev: URLSearchParams): URLSearchParams => {
    const next = new URLSearchParams(prev);
    change(next);
    return next;
  };

function countLabel(count: LeadCount | undefined): string | null {
  if (!count) return null;
  return count.atLeast ? `${LEADS_COUNT_LIMIT}+` : String(count.count);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// Search: caption and progress

/** A link into the Job search section of Settings. */
function SearchSettingsLink({ children }: { children: string }) {
  const sx = useLinkSx({ fontSize: "inherit" });
  return (
    <Link component={RouterLink} to="/settings/search" sx={sx}>
      {children}
    </Link>
  );
}

function SearchCaption({
  runs,
  timezone,
  now,
}: {
  runs: SearchRun[] | undefined;
  timezone: string;
  now: Date;
}) {
  if (!runs) return <Skeleton variant="text" width={320} />;
  // A running search has its own card; the caption speaks of the last one that ended.
  const last = runs.find((run) => run.status !== "running");
  if (!last) {
    return (
      <Typography variant="caption" color="text.secondary" component="p">
        No search has run yet.
      </Typography>
    );
  }
  if (last.status === "failed") {
    return (
      <Typography variant="caption" color="text.secondary" component="p">
        {"The last search failed. Its error is listed under "}
        <SearchSettingsLink>Recent runs</SearchSettingsLink>
        {" in Settings."}
      </Typography>
    );
  }
  const when =
    localDayKey(last.startedAt, timezone) === localDayKey(now, timezone)
      ? `at ${formatTime(last.startedAt, timezone)}`
      : `on ${formatShortDate(last.startedAt, timezone)} at ${formatTime(last.startedAt, timezone)}`;
  return (
    <Typography variant="caption" color="text.secondary" component="p">
      {`The last search ran ${when}: ${last.accepted} new, ${last.suppressed} suppressed, ${plural(last.dead, "closed posting", "closed postings")} dropped.`}
    </Typography>
  );
}

/** The States board's *Search running* card. */
function SearchProgress({ run }: { run: SearchRun }) {
  const round = Math.min(Math.max(run.rounds, 1), SEARCH_ROUNDS);
  return (
    <Paper
      variant="outlined"
      role="status"
      aria-label="Search progress"
      aria-live="polite"
      sx={{ p: 2.25, display: "flex", flexDirection: "column", gap: 1.25 }}
    >
      <Typography sx={{ fontWeight: 600 }}>Searching for new leads</Typography>
      <LinearProgress aria-hidden="true" sx={{ height: 6, borderRadius: "3px" }} />
      <Typography variant="caption" color="text.secondary" component="p">
        {`Round ${round} of ${SEARCH_ROUNDS}. ${plural(run.accepted, "new lead", "new leads")} so far. You can keep working; they appear in Leads when it finishes.`}
      </Typography>
    </Paper>
  );
}

// ---------------------------------------------------------------------------------------------
// The list

interface ListProps {
  leads: Lead[];
  timezone: string;
  now: Date;
  trackLabels: Record<string, string>;
  onShortlist: (lead: Lead) => void;
  onDismiss: (lead: Lead) => void;
  onMarkApplied: (lead: Lead) => void;
  onReconsider: (lead: Lead) => void;
}

const isOpen = (lead: Lead) => lead.status === "new" || lead.status === "shortlisted";

function LeadList({
  leads,
  timezone,
  now,
  trackLabels,
  onShortlist,
  onDismiss,
  onMarkApplied,
  onReconsider,
  label,
}: ListProps & { label: string }) {
  const navigate = useNavigate();
  const { focusedIndex, getRowProps } = useListKeyboard(leads, {
    // Enter opens what the row leads to: its application once there is one.
    onOpen: (lead) => {
      if (lead.status === "applied" && lead.applicationId) {
        void navigate(`/applications/${encodeURIComponent(lead.applicationId)}`);
      }
    },
    keys: {
      s: (lead) => {
        if (lead.status === "new") onShortlist(lead);
      },
      d: (lead) => {
        if (isOpen(lead)) onDismiss(lead);
      },
      a: (lead) => {
        if (isOpen(lead)) onMarkApplied(lead);
      },
      o: (lead) => {
        if (isHttpUrl(lead.jobUrl)) window.open(lead.jobUrl, "_blank", "noopener,noreferrer");
      },
    },
  });
  return (
    <Paper component="section" variant="outlined" aria-label={label} sx={{ overflow: "hidden" }}>
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {leads.map((lead, i) => (
          <LeadRow
            key={lead.id}
            lead={lead}
            timezone={timezone}
            now={now}
            trackLabels={trackLabels}
            focused={i === focusedIndex}
            rowProps={getRowProps(i)}
            onShortlist={onShortlist}
            onDismiss={onDismiss}
            onMarkApplied={onMarkApplied}
            onReconsider={onReconsider}
          />
        ))}
      </Box>
    </Paper>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const timezone = useTimezone();
  const settings = useSettings();
  const query = useLeads(filters);
  const counts = useLeadCounts();
  const runs = useSearchRuns();
  const snackbar = useUndoSnackbar();
  const refreshLeads = useRefreshLeads();

  const tracks = useMemo(
    () =>
      [...(settings.data?.search.tracks ?? [])].sort(
        (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
      ),
    [settings.data],
  );
  const trackLabels = useMemo(
    () => Object.fromEntries(tracks.map((t) => [t.key, t.label])),
    [tracks],
  );
  const trackKnown = filters.track !== null && tracks.some((t) => t.key === filters.track);

  const change = (apply: (next: URLSearchParams) => void) =>
    setParams(nextParams(apply), { replace: true });

  // --- search ---
  const latestRun = runs.data?.[0];
  const running = latestRun?.status === "running" ? latestRun : undefined;
  const runSearch = useRunSearch({
    onSuccess: () => snackbar.show("Search started"),
    onError: (error) =>
      snackbar.show(
        isApiError(error, "already_running")
          ? SEARCH_RUNNING
          : "Couldn't start the search. Try again.",
      ),
  });
  // When the run being shown ends, the leads it found are fetched.
  const seenRunning = useRef<string | null>(null);
  const latestId = latestRun?.id;
  const latestStatus = latestRun?.status;
  useEffect(() => {
    if (latestId === undefined) return;
    if (latestStatus === "running") {
      seenRunning.current = latestId;
    } else if (seenRunning.current === latestId) {
      seenRunning.current = null;
      void refreshLeads();
    }
    // `refreshLeads` is a new function each render; the run's id and status are what matter.
  }, [latestId, latestStatus]);

  // --- actions ---
  // One change at a time per lead: a second press on the same lead would carry a stale version.
  // Other leads stay free to act on.
  const busy = useRef(new Set<string>());
  const settle = (lead: Lead) => {
    busy.current.delete(lead.id);
  };
  const failed = (verb: string, lead: Lead) => `Couldn't ${verb} ${lead.company.name}. Try again.`;

  const restore = useSetLeadStatus();
  const setStatus = useSetLeadStatus({
    onSuccess: (updated, { lead, status }) => {
      settle(lead);
      // Undo goes back to where the lead was: New, or Shortlisted for a dismissed shortlisted lead.
      const before = lead.status === "shortlisted" ? "shortlisted" : "new";
      snackbar.show(
        `${status === "shortlisted" ? "Shortlisted" : "Dismissed"} ${lead.company.name}`,
        async () => {
          await restore.mutateAsync({ lead: updated, status: before });
        },
      );
    },
    onError: (error, { lead, status }) => {
      settle(lead);
      snackbar.show(
        isApiError(error, "version_conflict")
          ? CHANGED_ELSEWHERE
          : failed(status === "shortlisted" ? "shortlist" : "dismiss", lead),
      );
    },
  });
  const reconsiderDismissed = useSetLeadStatus({
    onSuccess: (_updated, { lead }) => {
      settle(lead);
      snackbar.show(`Reconsidered ${lead.company.name}`);
    },
    onError: (error, { lead }) => {
      settle(lead);
      snackbar.show(
        isApiError(error, "version_conflict") ? CHANGED_ELSEWHERE : failed("reconsider", lead),
      );
    },
  });
  const reconsiderSuppressed = useReconsiderLead({
    onSuccess: (_updated, lead) => {
      settle(lead);
      snackbar.show(`Reconsidered ${lead.company.name}`);
    },
    onError: (error, lead) => {
      settle(lead);
      snackbar.show(isConflict(error) ? CHANGED_ELSEWHERE : failed("reconsider", lead));
    },
  });
  const undo = useUndoEvent();
  const markApplied = useMarkLeadApplied({
    onSuccess: (application, lead) => {
      settle(lead);
      // The undo is the `lead_converted` event the conversion wrote (AC-9.6).
      const converted = application.timeline.find(
        (event) => event.type === "lead_converted" && event.undoable && event.undoneAt === null,
      );
      snackbar.show(
        "Marked as applied",
        converted
          ? async () => {
              await undo.mutateAsync(converted.id);
            }
          : undefined,
      );
    },
    onError: (error, lead) => {
      settle(lead);
      // Mark applied sends no version; a 409 means the lead was converted or changed elsewhere.
      snackbar.show(
        isConflict(error)
          ? CHANGED_ELSEWHERE
          : `Couldn't mark ${lead.company.name} as applied. Try again.`,
      );
    },
  });

  const act = (lead: Lead, start: () => void) => {
    if (busy.current.has(lead.id)) return;
    busy.current.add(lead.id);
    start();
  };
  const onShortlist = (lead: Lead) =>
    act(lead, () => setStatus.mutate({ lead, status: "shortlisted" }));
  const onDismiss = (lead: Lead) =>
    act(lead, () => setStatus.mutate({ lead, status: "dismissed" }));
  const onMarkApplied = (lead: Lead) => act(lead, () => markApplied.mutate(lead));
  const onReconsider = (lead: Lead) =>
    act(lead, () =>
      lead.status === "suppressed"
        ? reconsiderSuppressed.mutate(lead)
        : reconsiderDismissed.mutate({ lead, status: "new" }),
    );

  const leads = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // One "now" per answer, so "at 07:04" versus "on Oct 27" stays still while the owner reads.
  const now = useMemo(() => new Date(), [query.dataUpdatedAt, runs.dataUpdatedAt]);
  const tabLabel = TABS.find((t) => t.key === filters.status)?.label ?? "New";
  const searchEnabled = settings.data?.search.enabled;
  const runTime = settings.data?.search.runTime;

  const runSearchButton = (
    <Button
      variant="contained"
      startIcon={<SearchOutlined />}
      disabled={runSearch.isPending || running !== undefined}
      onClick={() => runSearch.mutate()}
    >
      Run search now
    </Button>
  );

  const emptyNew = (
    <EmptyState
      title={
        searchEnabled === undefined
          ? "No new leads"
          : searchEnabled
            ? `No new leads. The next search runs at ${runTime}.`
            : "No new leads. The daily search is off."
      }
      body={
        searchEnabled === false ? (
          <>
            {"Run a search now, or turn the daily search on in "}
            <SearchSettingsLink>Settings</SearchSettingsLink>
            {"."}
          </>
        ) : (
          "You can also run a search now."
        )
      }
      actions={
        <Button
          variant="outlined"
          disabled={runSearch.isPending || running !== undefined}
          onClick={() => runSearch.mutate()}
        >
          Run search now
        </Button>
      }
    />
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Box
        component="header"
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="h4" component="h1">
            Leads
          </Typography>
          <SearchCaption runs={runs.data} timezone={timezone} now={now} />
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5 }}>
          <Button variant="outlined" component={RouterLink} to="/leads/import">
            Import a report
          </Button>
          {runSearchButton}
        </Box>
      </Box>

      {running ? <SearchProgress run={running} /> : null}

      <Tabs
        value={filters.status}
        aria-label="Lead lists"
        variant="scrollable"
        scrollButtons={false}
        onChange={(_event, value: LeadStatus) =>
          change((next) => {
            if (value === DEFAULT_TAB) next.delete("tab");
            else next.set("tab", value);
          })
        }
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 44 }}
      >
        {TABS.map((t) => {
          const count = countLabel(counts[t.key]);
          return (
            <Tab
              key={t.key}
              value={t.key}
              id={`leads-tab-${t.key}`}
              aria-controls="leads-panel"
              sx={{ minHeight: 44, minWidth: 0, px: 0.5, mr: 3, fontWeight: 600 }}
              label={
                <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                  {t.label}
                  {count ? (
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
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1.5,
        }}
      >
        <Box
          role="group"
          aria-label="Filter by track"
          sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}
        >
          <FilterChip
            label="All tracks"
            pressed={!trackKnown}
            onToggle={() => change((next) => next.delete("track"))}
          />
          {tracks.map((t) => (
            <FilterChip
              key={t.key}
              label={t.label}
              pressed={filters.track === t.key}
              onToggle={() =>
                change((next) => {
                  if (filters.track === t.key) next.delete("track");
                  else next.set("track", t.key);
                })
              }
            />
          ))}
        </Box>
        <TextField
          select
          label="Sort"
          value={filters.sort}
          onChange={(e) =>
            change((next) => {
              if (e.target.value === DEFAULT_SORT) next.delete("sort");
              else next.set("sort", e.target.value);
            })
          }
          sx={{ minWidth: 190 }}
        >
          {SORTS.map((s) => (
            <MenuItem key={s.value} value={s.value}>
              {s.label}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      <Box
        id="leads-panel"
        role="tabpanel"
        aria-labelledby={`leads-tab-${filters.status}`}
        sx={{ display: "flex", flexDirection: "column", gap: 2 }}
      >
        {query.isError ? (
          <ErrorState what="leads" error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isPending ? (
          <ListSkeleton label="Loading leads" />
        ) : leads.length === 0 ? (
          filters.track !== null ? (
            <EmptyState
              title="No leads in this track"
              body="Show every track to see the rest of this list."
              actions={
                <Button variant="outlined" onClick={() => change((next) => next.delete("track"))}>
                  Show every track
                </Button>
              }
            />
          ) : filters.status === "new" ? (
            emptyNew
          ) : (
            <EmptyState {...EMPTY[filters.status]} />
          )
        ) : (
          <>
            <LeadList
              label={`${tabLabel} leads`}
              leads={leads}
              timezone={timezone}
              now={now}
              trackLabels={trackLabels}
              onShortlist={onShortlist}
              onDismiss={onDismiss}
              onMarkApplied={onMarkApplied}
              onReconsider={onReconsider}
            />
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
                Keys: <Key>j</Key> <Key>k</Key> move, <Key>s</Key> shortlist, <Key>d</Key> dismiss,{" "}
                <Key>a</Key> mark applied, <Key>o</Key> open posting, <Key>?</Key> all shortcuts
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
    </Box>
  );
}
