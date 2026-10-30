import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import type { AiUsage as AiUsageDto, LlmPurpose } from "@offerbound/contracts";
import { useAiUsage } from "../../api/hooks";
import { ErrorState } from "../../components/States";
import { formatCount, formatShortDate, formatUsd } from "../../lib/format";
import { SectionPaper } from "./shared";
import { t, tn } from "../../i18n";

/**
 * Settings, AI usage (AC-15.1, TECHNICAL_SPEC §13): month-to-date cost, calls and cost by purpose
 * with the calls that have no known price counted as "unknown", and a 30-day bar chart.
 */

/** What each kind of call does, in the words the rest of the app uses. */
const PURPOSE_LABEL: Record<LlmPurpose, string> = {
  get triage() {
    return t("Sorting email");
  },
  get extract() {
    return t("Reading job emails");
  },
  get rank() {
    return t("Ranking leads");
  },
  get search() {
    return t("Searching for leads");
  },
  get parse_report() {
    return t("Reading reports");
  },
  get cv_profile() {
    return t("Reading your CV");
  },
};

export function AiUsage() {
  const usage = useAiUsage();
  return (
    <SectionPaper
      id="ai-usage-heading"
      title={t("AI usage")}
      caption={t("Cost of the calls to OpenAI")}
    >
      {usage.isPending ? (
        <Skeleton variant="rounded" height={200} aria-label={t("Loading AI usage")} />
      ) : usage.isError ? (
        <ErrorState what={t("AI usage")} error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <Usage usage={usage.data} />
      )}
    </SectionPaper>
  );
}

function Usage({ usage }: { usage: AiUsageDto }) {
  const unknown = usage.byPurpose.reduce((sum, row) => sum + row.unknownCostCalls, 0);
  return (
    <>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
        <Typography variant="caption" color="text.secondary">
          {t("Month to date")}
        </Typography>
        <Typography sx={{ fontSize: 28, lineHeight: "32px", fontWeight: 800 }}>
          {formatUsd(usage.monthToDateMicros)}
        </Typography>
        {unknown > 0 ? (
          <Typography variant="caption" color="text.secondary">
            {tn(
              unknown,
              "1 call has no known price and is not counted in this total.",
              "{count} calls have no known price and are not counted in this total.",
            )}
          </Typography>
        ) : null}
      </Box>

      {usage.byPurpose.length === 0 ? (
        <Typography color="text.secondary">{t("No AI calls this month yet.")}</Typography>
      ) : (
        <TableContainer sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Table aria-label={t("Cost by purpose")} sx={{ minWidth: 420 }}>
            <TableHead>
              <TableRow>
                <TableCell scope="col">{t("Purpose")}</TableCell>
                <TableCell scope="col" align="right">
                  {t("Calls")}
                </TableCell>
                <TableCell scope="col" align="right">
                  {t("Cost")}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {usage.byPurpose.map((row) => (
                <TableRow key={row.purpose}>
                  <TableCell>{PURPOSE_LABEL[row.purpose]}</TableCell>
                  <TableCell align="right">{formatCount(row.calls)}</TableCell>
                  <TableCell align="right">
                    {row.calls > 0 && row.unknownCostCalls >= row.calls
                      ? t("Unknown")
                      : row.unknownCostCalls > 0
                        ? tn(
                            row.unknownCostCalls,
                            "{cost}, 1 call unknown",
                            "{cost}, {count} calls unknown",
                            {
                              cost: formatUsd(row.costMicros),
                            },
                          )
                        : formatUsd(row.costMicros)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Box component="figure" sx={{ m: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Typography component="figcaption" variant="subtitle2">
          {t("Daily cost, last 30 days")}
        </Typography>
        <DailyChart days={usage.last30Days.slice(-30)} />
      </Box>
    </>
  );
}

// A simple bar chart drawn as SVG (DESIGN_SPEC §5.7): one bar a day in the route color, the highest
// day labelled, the first and last date under the baseline. Each bar has its day and cost in a
// <title> for pointers and assistive technology.
const W = 600;
const H = 170;
const LEFT = 44;
const TOP = 16;
const BASE = 142;

function DailyChart({ days }: { days: AiUsageDto["last30Days"] }) {
  const theme = useTheme();
  const max = Math.max(0, ...days.map((d) => d.costMicros));
  const slot = (W - LEFT - 8) / Math.max(days.length, 1);
  const barWidth = Math.max(slot * 0.68, 2);
  const label = { fontSize: 11, fill: theme.palette.text.secondary } as const;
  const day = (date: string) => formatShortDate(`${date}T12:00:00Z`, "UTC");

  return (
    <Box
      component="svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={t("Daily AI cost, last 30 days")}
      sx={{ width: "100%", maxWidth: 720, height: "auto", display: "block" }}
    >
      <line x1={LEFT} x2={W - 8} y1={BASE} y2={BASE} stroke={theme.palette.divider} />
      <text x={LEFT - 6} y={BASE + 4} textAnchor="end" {...label}>
        0
      </text>
      {max > 0 ? (
        <text x={LEFT - 6} y={TOP + 4} textAnchor="end" {...label}>
          {formatUsd(max)}
        </text>
      ) : null}
      {days.map((d, i) => {
        const height = max > 0 ? ((BASE - TOP) * d.costMicros) / max : 0;
        return (
          <rect
            key={d.date}
            data-bar=""
            x={LEFT + i * slot + (slot - barWidth) / 2}
            y={BASE - height}
            width={barWidth}
            height={height}
            rx={1.5}
            fill={theme.palette.primary.main}
          >
            <title>{`${day(d.date)}: ${formatUsd(d.costMicros)}`}</title>
          </rect>
        );
      })}
      {days.length > 0 ? (
        <>
          <text x={LEFT} y={H - 8} textAnchor="start" {...label}>
            {day(days[0]?.date ?? "")}
          </text>
          <text x={W - 8} y={H - 8} textAnchor="end" {...label}>
            {day(days[days.length - 1]?.date ?? "")}
          </text>
        </>
      ) : null}
    </Box>
  );
}
