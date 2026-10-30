import type {
  ApplicationSummary,
  InterviewWithApplication,
  Lead,
  MessageDetail,
  NavCounts,
  ReviewItem,
  SyncStatus,
  TimelineEvent,
  Today,
} from "@offerbound/contracts";

/** Test data builders. Companies and people are fictional. */

export function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "l1",
    version: 1,
    company: { id: "c1", name: "Tidewater Labs" },
    title: "Senior Product Engineer",
    jobUrl: "https://jobs.example/tidewater/1",
    locationText: "Remote",
    country: null,
    workMode: "remote",
    remoteFromHomeCountry: "yes",
    sponsorship: "unknown",
    relocation: "unknown",
    sponsorshipText: null,
    eligible: "yes",
    eligibilityReason: null,
    compensationText: null,
    compensation: {
      min: 9500,
      max: 11000,
      currency: "USD",
      period: "month",
      isEstimate: false,
      basis: null,
    },
    seniority: "senior",
    track: "Remote from MX",
    fitScore: 91,
    fitReason: "React, TypeScript and Node match your CV.",
    gaps: ["Go"],
    status: "new",
    suppressedReason: null,
    dismissedReason: null,
    companySeenBefore: false,
    verification: "verified",
    source: "search_agent",
    foundAt: "2026-10-29T13:04:00Z",
    postedAt: null,
    applicationId: null,
    notes: null,
    ...overrides,
  };
}

export function makeApplication(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    id: "a1",
    version: 1,
    company: { id: "c2", name: "Northwind Robotics" },
    title: "Senior Full-stack Engineer",
    status: "applied",
    statusChangedAt: "2026-10-20T15:00:00Z",
    appliedAt: "2026-10-20T15:00:00Z",
    lastCompanyActivityAt: null,
    followUpDue: true,
    nextInterviewAt: null,
    workMode: "remote",
    country: null,
    source: "manual",
    ...overrides,
  };
}

export function makeInterview(
  overrides: Partial<InterviewWithApplication> = {},
): InterviewWithApplication {
  return {
    id: "i1",
    version: 1,
    applicationId: "a1",
    kind: "technical",
    status: "scheduled",
    startsAt: "2026-10-30T16:00:00Z",
    endsAt: "2026-10-30T17:00:00Z",
    timezoneHint: null,
    meetingUrl: "https://meet.example/kestrel",
    schedulingUrl: null,
    location: null,
    interviewers: ["Priya Natarajan", "Tom Salas"],
    notes: null,
    application: makeApplication({
      id: "a1",
      company: { id: "c3", name: "Kestrel Pay" },
      title: "Senior Frontend Engineer",
      status: "interviewing",
    }),
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "e1",
    type: "status_changed",
    occurredAt: "2026-10-27T20:12:00Z",
    actor: "system",
    summary: "Moved to Interviewing",
    messageId: null,
    toStatus: null,
    undoable: true,
    undoneAt: null,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: "m1",
    internalDate: "2026-10-27T20:00:00Z",
    direction: "inbound",
    fromName: "Dana Ortiz",
    fromEmail: "dana@kestrel.example",
    subject: "Next steps",
    summary: null,
    category: "interview_invite",
    bodyText: "Hello",
    toEmails: ["me@owner.example"],
    ...overrides,
  };
}

export function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    connection: "active",
    started: true,
    lastSyncAt: "2026-10-30T11:58:00Z",
    lastError: null,
    backfill: { state: "done", listed: 400, processed: 400 },
    queue: { discovered: 0, jobRelated: 0, extracted: 0, needsReview: 0, failed: 0 },
    ...overrides,
  };
}

export function makeNavCounts(overrides: Partial<NavCounts> = {}): NavCounts {
  return {
    openApplications: 20,
    newLeads: 24,
    upcomingInterviews: 3,
    openReview: 4,
    ...overrides,
  };
}

export function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    kind: "ambiguous_match",
    state: "open",
    createdAt: "2026-10-28T20:00:00Z",
    confidence: 0.64,
    message: {
      id: "m2",
      internalDate: "2026-10-28T20:00:00Z",
      direction: "inbound",
      fromName: "Dana Ortiz",
      fromEmail: "dana@quarry.example",
      subject: "Update on your application",
      summary: null,
      category: "rejection",
    },
    proposal: {
      description: "Is this a rejection from Quarry AI?",
      operations: [
        {
          entity: "application",
          action: "update",
          summary: "Would change Assessment to Rejected.",
        },
      ],
    },
    candidates: [],
    ...overrides,
  };
}

/** A populated Today answer: 41 applications, two follow-ups, one review item, one lead, one interview. */
export function makeToday(overrides: Partial<Today> = {}): Today {
  return {
    date: "2026-10-29",
    targets: {
      leads: { min: 20, max: 30 },
      applications: { min: 8, max: 12 },
      outreach: { min: 5 },
      followUps: { min: 3, max: 5 },
      prepMinutes: { min: 90 },
    },
    counts: { newLeads: 24, applications: 3, outreach: 2, followUps: 1, prepMinutes: 30 },
    followUpsDue: [
      makeApplication({ id: "a1", appliedAt: "2026-10-20T15:00:00Z" }),
      makeApplication({
        id: "a2",
        company: { id: "c4", name: "Caldera Energy" },
        title: "Senior Software Engineer, Platform",
        appliedAt: "2026-10-12T15:00:00Z",
        lastCompanyActivityAt: "2026-10-21T16:00:00Z",
      }),
    ],
    upcomingInterviews: [makeInterview()],
    topLeads: [makeLead()],
    review: { open: 4, first: [makeReviewItem()] },
    sync: makeSyncStatus(),
    pipeline: {
      byStatus: {
        applied: 12,
        screening: 3,
        assessment: 2,
        interviewing: 3,
        offer: 0,
        accepted: 0,
        rejected: 17,
        withdrawn: 1,
        abandoned: 3,
      },
      responseRate: 0.46,
      interviewRate: 0.2,
    },
    ...overrides,
  };
}
