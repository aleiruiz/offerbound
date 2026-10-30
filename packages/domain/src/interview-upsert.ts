import type { EmailCategory, Extraction, IcsEvent, InterviewKind } from "@offerbound/contracts";
import type { EntityRef, InterviewFields, InterviewRef, Operation } from "./plan.js";

/**
 * Interview upsert (TECHNICAL_SPEC §6.9; AC-8.1, AC-8.2). Pure: returns the one operation an
 * interview invite, reschedule or cancellation implies for the matched application, or null.
 *
 * On an update (`interviewId` set), a null `meetingUrl`, `schedulingUrl` or `location`, an empty
 * `interviewers` list and a null `timezoneHint` all mean "not provided": the executor keeps the
 * existing value rather than blanking it.
 */

type ExtractedInterview = NonNullable<Extraction["interview"]>;

const NEW_INTERVIEW = "new:interview";

function parseInstant(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Scheduled interviews by start time, then those still to be scheduled in their given order. */
function upcoming(list: InterviewRef[]): InterviewRef[] {
  const live = list.filter((i) => i.status === "scheduled" || i.status === "to_schedule");
  const scheduled = live
    .filter((i) => i.status === "scheduled")
    .sort((a, b) => (a.startsAt?.getTime() ?? Infinity) - (b.startsAt?.getTime() ?? Infinity));
  return [...scheduled, ...live.filter((i) => i.status === "to_schedule")];
}

function buildFields(
  extracted: ExtractedInterview | null,
  calendar: IcsEvent | null,
  target: InterviewRef | null,
): InterviewFields {
  const calendarStart = parseInstant(calendar?.start);
  const startsAt = calendarStart ?? parseInstant(extracted?.startsAt);
  let endsAt = parseInstant(calendar?.end);
  if (endsAt === null) {
    // The extraction's end only complements a calendar start if it still lies after it.
    const extractedEnd = parseInstant(extracted?.endsAt);
    endsAt =
      extractedEnd !== null && (startsAt === null || extractedEnd.getTime() > startsAt.getTime())
        ? extractedEnd
        : null;
  }
  return {
    kind: extracted?.kind ?? target?.kind ?? "other",
    status: startsAt === null ? "to_schedule" : "scheduled",
    startsAt,
    endsAt,
    timezoneHint: calendar?.timezone ?? extracted?.timezone ?? null,
    meetingUrl: calendar?.url ?? calendar?.descriptionLink ?? extracted?.meetingUrl ?? null,
    schedulingUrl: extracted?.schedulingUrl ?? null,
    location: calendar?.location ?? extracted?.location ?? null,
    interviewers: extracted?.interviewers ?? [],
    icsUid: calendar?.uid ?? target?.icsUid ?? null,
  };
}

export function planInterviewUpsert(
  existing: InterviewRef[],
  e: Extraction,
  ics: IcsEvent[],
  category: EmailCategory,
  appRef: EntityRef,
): Operation | null {
  if (
    category !== "interview_invite" &&
    category !== "interview_reschedule" &&
    category !== "interview_cancellation"
  ) {
    return null;
  }
  const extracted = e.interview;

  // 1. A calendar event whose UID is an existing interview's ics_uid.
  let target: InterviewRef | null = null;
  let calendar: IcsEvent | null = null;
  for (const event of ics) {
    if (event.uid === null) continue;
    const hit = existing.find((i) => i.icsUid === event.uid);
    if (hit) {
      target = hit;
      calendar = event;
      break;
    }
  }
  calendar ??=
    category === "interview_cancellation"
      ? (ics[0] ?? null)
      : (ics.find((ev) => ev.method !== "CANCEL") ?? ics[0] ?? null);
  const cancelling = category === "interview_cancellation" || calendar?.method === "CANCEL";

  // 2. Reschedule or cancellation: the next live interview of the same kind, else of any kind.
  if (target === null && (cancelling || category === "interview_reschedule")) {
    const live = upcoming(existing);
    const kind: InterviewKind | null = extracted?.kind ?? null;
    target = (kind === null ? undefined : live.find((i) => i.kind === kind)) ?? live[0] ?? null;
  }

  // 3. Invite: fill a to_schedule interview of the same kind.
  if (target === null && !cancelling && category === "interview_invite") {
    const kind = extracted?.kind ?? "other";
    target = existing.find((i) => i.status === "to_schedule" && i.kind === kind) ?? null;
  }

  if (cancelling) {
    if (target === null || target.status === "cancelled") return null;
    return { op: "cancel_interview", interviewId: target.id, expectedVersion: target.version };
  }

  return {
    op: "upsert_interview",
    application: appRef,
    interviewId: target?.id ?? null,
    expectedVersion: target?.version ?? null,
    ref: target?.id ?? NEW_INTERVIEW,
    fields: buildFields(extracted, calendar, target),
  };
}
