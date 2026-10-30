import {
  DEFAULT_SETTINGS,
  type AiUsage,
  type ApplicationDetail,
  type ApplicationSummary,
  type CvProfile,
  type InterviewWithApplication,
  type Lead,
  type MessageDetail,
  type Me,
  type NavCounts,
  type ReviewItem,
  type SearchRun,
  type Settings,
  type SyncStatus,
  type TimelineEvent,
  type Today,
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

export function makeApplicationDetail(
  overrides: Partial<ApplicationDetail> = {},
): ApplicationDetail {
  return {
    ...makeApplication(),
    jobUrl: "https://jobs.example/northwind/42",
    locationText: "Remote, open to Mexico",
    compensationText: "US$9.5–11k / month",
    sponsorshipText: null,
    notes: null,
    leadId: null,
    interviews: [],
    messages: [],
    timeline: [],
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

/** The default settings, with any part replaced. */
export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    search: {
      ...DEFAULT_SETTINGS.search,
      brief: "Senior full-stack roles, remote from Mexico or with relocation support.",
      enabled: true,
    },
    ...overrides,
  };
}

export function makeSearchRun(overrides: Partial<SearchRun> = {}): SearchRun {
  return {
    id: "sr1",
    trigger: "schedule",
    status: "succeeded",
    startedAt: "2026-10-30T13:00:00Z",
    finishedAt: "2026-10-30T13:09:00Z",
    rounds: 3,
    returned: 36,
    accepted: 24,
    suppressed: 9,
    duplicates: 3,
    dead: 3,
    webSearchCalls: 58,
    costMicros: 610_000,
    error: null,
    ...overrides,
  };
}

export function makeCvProfile(overrides: Partial<CvProfile> = {}): CvProfile {
  return {
    headline: "Senior software engineer, 8 years, full-stack with a frontend focus",
    yearsExperience: 8,
    coreSkills: ["React", "TypeScript", "Node.js"],
    secondarySkills: ["Python", "Azure"],
    domains: ["Payments"],
    recentRoles: [{ title: "Senior Engineer", company: "Harbor Pay", years: "2021 to 2026" }],
    leadership: null,
    languages: ["English", "Spanish"],
    location: "Monterrey, Mexico",
    workAuthorization: null,
    ...overrides,
  };
}

/** Thirty days of AI cost ending 2026-10-30, a little more on the weekdays. */
export function makeAiUsage(overrides: Partial<AiUsage> = {}): AiUsage {
  const last30Days = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 30) - (29 - i) * 86_400_000);
    return { date: date.toISOString().slice(0, 10), costMicros: 20_000 + (i % 7) * 15_000 };
  });
  return {
    monthToDateMicros: 1_840_000,
    byPurpose: [
      { purpose: "triage", calls: 640, costMicros: 310_000, unknownCostCalls: 0 },
      { purpose: "extract", calls: 212, costMicros: 590_000, unknownCostCalls: 0 },
      { purpose: "rank", calls: 96, costMicros: 240_000, unknownCostCalls: 0 },
      { purpose: "search", calls: 14, costMicros: 700_000, unknownCostCalls: 2 },
    ],
    last30Days,
    ...overrides,
  };
}

/** The account `GET /me` answers with, as the owner signed in. */
export const OWNER_ME: Me = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

/** The account in the public demo: no sign-in, so no email. */
export const DEMO_ME: Me = {
  mode: "demo",
  email: null,
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};
