import {
  ApplicationStatusSchema,
  type ApplicationStatus,
  type ApplicationSummary,
} from "@offerbound/contracts";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import {
  useApplications,
  useNavCounts,
  usePipelineCounts,
  useTimezone,
  type ApplicationFilters,
  type ApplicationSort,
} from "../api/hooks";
import { AddApplicationDialog } from "../components/AddApplicationDialog";
import { EmptyState, ErrorState, ListSkeleton } from "../components/States";
import { FlagChip, STATUS_LABEL, StatusChip } from "../components/StatusChip";
import { formatDate, formatRelative, formatShortDate, formatTime } from "../lib/format";
import { useLinkSx, usePhone } from "../lib/link-sx";
import { useListKeyboard } from "../lib/shortcuts";

/**
 * Applications (DESIGN_SPEC §5.2; AC-6.1, AC-6.3): search, sort, *Follow-up due only*, status chips
 * and a table with cursor paging. The filters live in the address, so Today's pipeline stops can
 * link to a status and a filtered list can be shared or reloaded.
 */

const SORTS: { value: ApplicationSort; label: string }[] = [
  { value: "last_activity", label: "Last activity" },
  { value: "applied", label: "Applied date" },
  { value: "status", label: "Status" },
];
const DEFAULT_SORT: ApplicationSort = "last_activity";
const SEARCH_DEBOUNCE_MS = 300;

function readFilters(params: URLSearchParams): ApplicationFilters {
  const status = params
    .getAll("status")
    .flatMap((s) => {
      const parsed = ApplicationStatusSchema.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    })
    .filter((s, i, all) => all.indexOf(s) === i);
  const sort = SORTS.find((s) => s.value === params.get("sort"))?.value ?? DEFAULT_SORT;
  return {
    status,
    followUpDue: params.get("followUpDue") === "1",
    q: params.get("q") ?? "",
    sort,
  };
}

function filtersActive(f: ApplicationFilters): boolean {
  return f.status.length > 0 || f.followUpDue || f.q.trim() !== "";
}

const nextParams =
  (change: (next: URLSearchParams) => void) =>
  (prev: URLSearchParams): URLSearchParams => {
    const next = new URLSearchParams(prev);
    change(next);
    return next;
  };

// ---------------------------------------------------------------------------------------------
// Status chips

function StatusFilterChip({
  label,
  count,
  status,
  pressed,
  onToggle,
}: {
  label: string;
  count: number | undefined;
  status?: ApplicationStatus;
  pressed: boolean;
  onToggle: () => void;
}) {
  const phone = usePhone();
  return (
    <Chip
      onClick={onToggle}
      aria-pressed={pressed}
      variant="outlined"
      icon={
        status ? (
          <Box
            component="span"
            aria-hidden="true"
            sx={(theme) => ({
              ml: "12px !important",
              width: 8,
              height: 8,
              borderRadius: "4px",
              boxSizing: "border-box",
              ...(status === "abandoned"
                ? { border: `1px dashed ${theme.palette.status.abandoned.main}` }
                : { bgcolor: theme.palette.status[status].main }),
            })}
          />
        ) : undefined
      }
      label={count === undefined ? label : `${label} ${count}`}
      sx={(theme) => ({
        height: phone ? "auto" : 32,
        minHeight: phone ? 44 : undefined,
        borderRadius: phone ? "22px" : "16px",
        fontWeight: 600,
        fontSize: 14,
        px: status ? 0 : 0.5,
        borderColor: pressed ? theme.palette.primary.main : theme.palette.text.secondary,
        color: pressed ? theme.palette.primary.main : theme.palette.text.primary,
        bgcolor: pressed ? theme.palette.tokens.routeTint : theme.palette.background.paper,
        "&:hover": {
          bgcolor: pressed ? theme.palette.tokens.routeTint : theme.palette.action.hover,
        },
      })}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Table

function Stacked({ children, caption }: { children: React.ReactNode; caption?: React.ReactNode }) {
  return (
    <>
      {children}
      {caption ? (
        <Typography variant="caption" color="text.secondary" component="p">
          {caption}
        </Typography>
      ) : null}
    </>
  );
}

function ApplicationRow({
  application,
  timezone,
  now,
  rowProps,
  focused,
}: {
  application: ApplicationSummary;
  timezone: string;
  now: Date;
  rowProps: object;
  focused: boolean;
}) {
  const { lastCompanyActivityAt, nextInterviewAt, appliedAt } = application;
  const linkSx = useLinkSx({ fontSize: "inherit", color: "text.primary" });
  return (
    <TableRow
      hover
      {...rowProps}
      sx={(theme) => ({
        ...(focused ? { bgcolor: theme.palette.tokens.surfaceSunken } : {}),
        "&:focus-visible": { outlineOffset: -2 },
      })}
    >
      <TableCell>
        <Link
          component={RouterLink}
          to={`/applications/${encodeURIComponent(application.id)}`}
          underline="none"
          sx={linkSx}
        >
          {application.company.name}
        </Link>
        <Typography variant="caption" color="text.secondary" component="p">
          {application.title}
        </Typography>
      </TableCell>
      <TableCell>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          <StatusChip status={application.status} />
          {application.followUpDue ? <FlagChip tone="signal" label="Follow-up due" /> : null}
        </Box>
      </TableCell>
      <TableCell>
        {lastCompanyActivityAt ? (
          <Stacked caption={formatShortDate(lastCompanyActivityAt, timezone)}>
            {formatRelative(lastCompanyActivityAt, now)}
          </Stacked>
        ) : (
          <Typography variant="caption" color="text.secondary">
            No reply yet
          </Typography>
        )}
      </TableCell>
      <TableCell>
        {nextInterviewAt ? (
          `${formatDate(nextInterviewAt, timezone)}, ${formatTime(nextInterviewAt, timezone)}`
        ) : (
          <Typography variant="caption" color="text.secondary">
            None
          </Typography>
        )}
      </TableCell>
      <TableCell>{appliedAt ? formatShortDate(appliedAt, timezone) : "Not set"}</TableCell>
    </TableRow>
  );
}

function ApplicationsTable({
  applications,
  timezone,
  now,
}: {
  applications: ApplicationSummary[];
  timezone: string;
  now: Date;
}) {
  const navigate = useNavigate();
  const { focusedIndex, getRowProps } = useListKeyboard(applications, {
    onOpen: (application) => void navigate(`/applications/${encodeURIComponent(application.id)}`),
  });
  return (
    <Paper component="section" variant="outlined" aria-label="Applications">
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table sx={{ minWidth: 880 }}>
          <TableHead>
            <TableRow>
              <TableCell scope="col">Company and role</TableCell>
              <TableCell scope="col">Status</TableCell>
              <TableCell scope="col">Last reply from company</TableCell>
              <TableCell scope="col">Next interview</TableCell>
              <TableCell scope="col">Applied</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {applications.map((application, i) => (
              <ApplicationRow
                key={application.id}
                application={application}
                timezone={timezone}
                now={now}
                rowProps={getRowProps(i)}
                focused={i === focusedIndex}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function ApplicationsPage() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const timezone = useTimezone();
  const query = useApplications(filters);
  const counts = usePipelineCounts().data;
  const open = useNavCounts().data?.openApplications;
  const [adding, setAdding] = useState(false);

  // The field answers at once; the address, and so the request, follows when typing pauses.
  const [text, setText] = useState(filters.q);
  /** The last search text that the address and the field agreed on. */
  const agreed = useRef(filters.q);
  useEffect(() => {
    // The address changed from outside (the nav link, Back): the field follows it.
    if (filters.q === agreed.current) return;
    agreed.current = filters.q;
    setText(filters.q);
  }, [filters.q]);
  useEffect(() => {
    if (text === filters.q) return;
    const timer = setTimeout(() => {
      agreed.current = text.trim() === "" ? "" : text;
      setParams(
        nextParams((next) => {
          if (text.trim() === "") next.delete("q");
          else next.set("q", text);
        }),
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, filters.q, setParams]);

  const change = (apply: (next: URLSearchParams) => void) =>
    setParams(nextParams(apply), { replace: true });

  const toggleStatus = (status: ApplicationStatus) =>
    change((next) => {
      const selected = filters.status.includes(status)
        ? filters.status.filter((s) => s !== status)
        : [...filters.status, status];
      next.delete("status");
      for (const s of selected) next.append("status", s);
    });
  const clearFilters = () => {
    setText("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const applications = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // One "now" per answer, so "2 days ago" stays still while the owner reads the list.
  const now = useMemo(() => new Date(), [query.dataUpdatedAt]);
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : undefined;
  const active = filtersActive(filters);

  const caption =
    total === undefined
      ? "Updated from Gmail every 5 minutes."
      : `${total === 1 ? "1 application" : `${total} applications`}${open === undefined ? "" : `, ${open} still open`}. Updated from Gmail every 5 minutes.`;

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
            Applications
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {caption}
          </Typography>
        </Box>
        <Button variant="outlined" onClick={() => setAdding(true)}>
          Add application
        </Button>
      </Box>

      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
        <TextField
          label="Search"
          type="search"
          placeholder="Company or role"
          value={text}
          onChange={(e) => setText(e.target.value)}
          sx={{ flex: "1 1 280px", maxWidth: 360 }}
        />
        <TextField
          select
          label="Sort by"
          value={filters.sort}
          onChange={(e) =>
            change((next) => {
              if (e.target.value === DEFAULT_SORT) next.delete("sort");
              else next.set("sort", e.target.value);
            })
          }
          sx={{ minWidth: 180 }}
        >
          {SORTS.map((s) => (
            <MenuItem key={s.value} value={s.value}>
              {s.label}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel
          label="Follow-up due only"
          control={
            <Switch
              checked={filters.followUpDue}
              onChange={(e) =>
                change((next) => {
                  if (e.target.checked) next.set("followUpDue", "1");
                  else next.delete("followUpDue");
                })
              }
            />
          }
        />
      </Box>

      <Box
        role="group"
        aria-label="Filter by status"
        sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}
      >
        <StatusFilterChip
          label="All"
          count={total}
          pressed={filters.status.length === 0}
          onToggle={() => change((next) => next.delete("status"))}
        />
        {ApplicationStatusSchema.options.map((status) => (
          <StatusFilterChip
            key={status}
            label={STATUS_LABEL[status]}
            count={counts?.[status]}
            status={status}
            pressed={filters.status.includes(status)}
            onToggle={() => toggleStatus(status)}
          />
        ))}
      </Box>

      {query.isError ? (
        <ErrorState what="applications" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <ListSkeleton label="Loading applications" />
      ) : applications.length === 0 ? (
        active ? (
          <EmptyState
            title="No applications match these filters"
            body="Change the search or the status, or clear the filters."
            actions={
              <Button variant="outlined" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No applications yet"
            body="Import your spreadsheet, or let Offerbound read your Gmail, and your applications show up here."
            actions={
              <>
                <Button component={RouterLink} to="/settings/import" variant="outlined">
                  Import spreadsheet
                </Button>
                <Button component={RouterLink} to="/settings/gmail" variant="outlined">
                  Start syncing Gmail
                </Button>
              </>
            }
          />
        )
      ) : (
        <>
          <ApplicationsTable applications={applications} timezone={timezone} now={now} />
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 1.5,
            }}
          >
            <Typography variant="caption" color="text.secondary" component="p">
              {!active && total !== undefined && total >= applications.length
                ? `Showing ${applications.length} of ${total}`
                : `Showing ${applications.length}`}
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

      <AddApplicationDialog open={adding} onClose={() => setAdding(false)} />
    </Box>
  );
}
