import type { InterviewWithApplication } from "@offerbound/contracts";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { useId, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useInterviews, useNavCounts, useTimezone, type InterviewRange } from "../api/hooks";
import { AddInterviewDialog } from "../components/AddInterviewDialog";
import { DemoLock } from "../lib/demo";
import { InterviewRow } from "../components/InterviewRow";
import { PrepNotesSheet } from "../components/PrepNotesSheet";
import { Key } from "../components/ShortcutDialog";
import { EmptyState, ErrorState, ListSkeleton } from "../components/States";
import { formatLongDay, localDayKey, zoneCity } from "../lib/format";
import { useListKeyboard } from "../lib/shortcuts";
import { t, tx } from "../i18n";

/**
 * Interviews (DESIGN_SPEC §5.6, §6.5; AC-8.4, 8.5): Upcoming and Past tabs. Upcoming opens with the
 * interviews still to schedule on an amber band, then one group per day. Times are on a 24-hour
 * clock in the owner's time zone. The tab lives in the address.
 */

const TABS: { key: InterviewRange; label: string }[] = [
  {
    key: "upcoming",
    get label() {
      return t("Upcoming");
    },
  },
  {
    key: "past",
    get label() {
      return t("Past");
    },
  },
];
const DEFAULT_TAB: InterviewRange = "upcoming";

function readTab(params: URLSearchParams): InterviewRange {
  return TABS.find((t) => t.key === params.get("tab"))?.key ?? DEFAULT_TAB;
}

interface DayGroup {
  key: string;
  label: string;
  items: InterviewWithApplication[];
}

const time = (i: InterviewWithApplication) => (i.startsAt ? Date.parse(i.startsAt) : null);

/**
 * Interviews with a time, one group per owner-local day, in the order asked for: earliest first for
 * Upcoming, latest first for Past. The server sorts too (AC-8.4); sorting here keeps the page right
 * when a page boundary or a refetch lands in a different order. Interviews with no time go last.
 */
function groupByDay(
  interviews: InterviewWithApplication[],
  timezone: string,
  order: "asc" | "desc",
): DayGroup[] {
  const sign = order === "asc" ? 1 : -1;
  const sorted = [...interviews].sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta === null || tb === null) return ta === tb ? 0 : ta === null ? 1 : -1;
    return sign * (ta - tb);
  });
  const groups: DayGroup[] = [];
  for (const interview of sorted) {
    const key = interview.startsAt ? localDayKey(interview.startsAt, timezone) : "none";
    let group = groups.at(-1);
    if (group?.key !== key) {
      group = { key, label: formatLongDay(key) ?? t("No date"), items: [] };
      groups.push(group);
    }
    group.items.push(interview);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Sections

type RowRenderer = (interview: InterviewWithApplication) => React.ReactNode;

/** The interviews still waiting for a time, on the signal tint. */
function ToScheduleBand({
  interviews,
  renderRow,
}: {
  interviews: InterviewWithApplication[];
  renderRow: RowRenderer;
}) {
  const headingId = useId();
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ overflow: "hidden" }}
    >
      <Box
        sx={(theme) => ({
          px: 2.5,
          py: 1.75,
          bgcolor: theme.palette.tokens.signalTint,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 1,
        })}
      >
        <Typography
          id={headingId}
          component="h2"
          sx={{ fontSize: 14, lineHeight: "20px", fontWeight: 700, color: "warning.main" }}
        >
          {t("To schedule")}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("You haven't picked a time yet")}
        </Typography>
      </Box>
      <Box component="ul" aria-labelledby={headingId} sx={{ m: 0, p: 0 }}>
        {interviews.map(renderRow)}
      </Box>
    </Paper>
  );
}

function DaySection({ group, renderRow }: { group: DayGroup; renderRow: RowRenderer }) {
  const headingId = useId();
  return (
    <Box component="div" sx={{ "&:not(:first-of-type)": { borderTop: 1, borderColor: "divider" } }}>
      <Typography
        id={headingId}
        component="h2"
        sx={(theme) => ({
          fontSize: 14,
          lineHeight: "20px",
          fontWeight: 700,
          px: 2.5,
          py: 1.5,
          bgcolor: theme.palette.tokens.surfaceSunken,
        })}
      >
        {group.label}
      </Typography>
      <Box component="ul" aria-labelledby={headingId} sx={{ m: 0, p: 0 }}>
        {group.items.map(renderRow)}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function InterviewsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = readTab(params);
  const timezone = useTimezone();
  const navCounts = useNavCounts();
  const query = useInterviews(tab);

  const [adding, setAdding] = useState(false);
  const [notesFor, setNotesFor] = useState<string | null>(null);

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // One "now" per answer, so the Tomorrow chip stays still while the owner reads.
  const now = useMemo(() => new Date(), [query.dataUpdatedAt]);

  const { toSchedule, groups } = useMemo(() => {
    const waiting = tab === "upcoming" ? items.filter((i) => i.startsAt === null) : [];
    const timed = tab === "upcoming" ? items.filter((i) => i.startsAt !== null) : items;
    return {
      toSchedule: waiting,
      groups: groupByDay(timed, timezone, tab === "upcoming" ? "asc" : "desc"),
    };
  }, [items, tab, timezone]);

  // The keyboard walks the rows in the order they are drawn: the band first, then the days.
  const ordered = useMemo(
    () => [...toSchedule, ...groups.flatMap((g) => g.items)],
    [toSchedule, groups],
  );
  const { focusedIndex, getRowProps } = useListKeyboard(ordered, {
    // Enter opens the application of the focused interview.
    onOpen: (interview) => void navigate(`/applications/${interview.applicationId}`),
  });

  const renderRow: RowRenderer = (interview) => {
    const index = ordered.indexOf(interview);
    return (
      <InterviewRow
        key={interview.id}
        interview={interview}
        timezone={timezone}
        now={now}
        rowProps={getRowProps(index)}
        focused={index === focusedIndex}
        onPrepNotes={(i) => setNotesFor(i.id)}
      />
    );
  };

  const selectTab = (value: InterviewRange) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === DEFAULT_TAB) next.delete("tab");
        else next.set("tab", value);
        return next;
      },
      { replace: true },
    );

  const upcomingCount = navCounts.data?.upcomingInterviews;
  const addButton = (
    <DemoLock reason="add">
      <Button variant="outlined" onClick={() => setAdding(true)}>
        {t("Add interview")}
      </Button>
    </DemoLock>
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
            {t("Interviews")}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {t(
              "Times are in {city} time. Interviews come from invitation emails and calendar invites.",
              { city: zoneCity(timezone) },
            )}
          </Typography>
        </Box>
        {addButton}
      </Box>

      <Tabs
        value={tab}
        aria-label={t("Interview lists")}
        onChange={(_event, value: InterviewRange) => selectTab(value)}
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 44 }}
      >
        {TABS.map((t) => {
          // The API has no total for Past, so only Upcoming carries a count.
          const count = t.key === "upcoming" ? upcomingCount : undefined;
          return (
            <Tab
              key={t.key}
              value={t.key}
              id={`interviews-tab-${t.key}`}
              aria-controls="interviews-panel"
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
        id="interviews-panel"
        role="tabpanel"
        aria-labelledby={`interviews-tab-${tab}`}
        sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}
      >
        {query.isError ? (
          <ErrorState
            what={t("interviews")}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : query.isPending ? (
          <ListSkeleton label={t("Loading interviews")} rows={3} />
        ) : items.length === 0 ? (
          tab === "upcoming" ? (
            <EmptyState
              title={t("No interviews coming up.")}
              body={t(
                t(
                  "Interviews from invitation emails and calendar invites are listed here. You can also add one yourself.",
                ),
              )}
              actions={addButton}
            />
          ) : (
            <EmptyState
              title={t("No past interviews yet.")}
              body={t("Interviews that have happened or were cancelled are listed here.")}
            />
          )
        ) : (
          <>
            {toSchedule.length > 0 ? (
              <ToScheduleBand interviews={toSchedule} renderRow={renderRow} />
            ) : null}
            {groups.length > 0 ? (
              <Paper
                component="section"
                variant="outlined"
                aria-label={tab === "upcoming" ? t("Scheduled interviews") : t("Past interviews")}
                sx={{ overflow: "hidden" }}
              >
                {groups.map((g) => (
                  <DaySection key={g.key} group={g} renderRow={renderRow} />
                ))}
              </Paper>
            ) : null}
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
                {tx("Keys: {j} {k} move, {enter} opens the application, {help} all shortcuts", {
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

      <AddInterviewDialog open={adding} onClose={() => setAdding(false)} />
      <PrepNotesSheet
        interview={items.find((i) => i.id === notesFor) ?? null}
        onClose={() => setNotesFor(null)}
        timezone={timezone}
      />
    </Box>
  );
}
