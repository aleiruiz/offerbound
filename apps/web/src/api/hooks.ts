import {
  AiUsageSchema,
  ApplicationDetailSchema,
  ApplicationSummarySchema,
  CvProfileSchema,
  CvUploadFailedSchema,
  DailyCountsSchema,
  InterviewSchema,
  InterviewWithApplicationSchema,
  LeadSchema,
  ImportSummarySchema,
  MeSchema,
  MessageDetailSchema,
  NavCountsSchema,
  PageSchema,
  ReviewItemSchema,
  SearchRunSchema,
  SearchRunsSchema,
  SettingsSchema,
  SheetPreviewSchema,
  SyncStatusSchema,
  TodaySchema,
  UndoResultSchema,
  type AiUsage,
  type ApplicationCreate,
  type ApplicationDetail,
  type ApplicationPatch,
  type ApplicationStatus,
  type ApplicationSummary,
  type CvProfile,
  type DailyActivityBody,
  type Interview,
  type InterviewCreate,
  type InterviewPatch,
  type Lead,
  type SearchRun,
  type LeadStatus,
  type ReviewItem,
  type ReviewResolve,
  type Settings,
  type Today,
} from "@offerbound/contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { DEFAULT_TIMEZONE } from "../lib/format";
import { ApiClientError, apiFetch, apiFetchWithStatus } from "./client";

export const queryKeys = {
  me: ["me"] as const,
  /** Every applications query: lists and details. */
  applications: ["applications"] as const,
  applicationList: (filters: ApplicationFilters) => ["applications", "list", filters] as const,
  applicationLists: ["applications", "list"] as const,
  application: (id: string) => ["applications", "detail", id] as const,
  /** Every review query: the Open and Resolved lists. */
  reviewItems: ["review-items"] as const,
  reviewList: (state: ReviewListState) => ["review-items", "list", state] as const,
  /** Every leads query: lists and the counts behind the tabs. */
  leads: ["leads"] as const,
  leadLists: ["leads", "list"] as const,
  leadCounts: ["leads", "count"] as const,
  leadList: (filters: LeadFilters) => ["leads", "list", filters] as const,
  leadCount: (status: LeadStatus) => ["leads", "count", status] as const,
  /** Every interviews query: the Upcoming and Past lists. */
  interviews: ["interviews"] as const,
  interviewList: (range: InterviewRange) => ["interviews", "list", range] as const,
  searchRuns: ["search-runs"] as const,
  message: (id: string) => ["message", id] as const,
  syncStatus: ["sync-status"] as const,
  navCounts: ["nav-counts"] as const,
  settings: ["settings"] as const,
  /** The active CV profile, or null when there is none. */
  cv: ["cv"] as const,
  /** True after an upload whose profile step failed, until a profile exists again. */
  cvProfileFailed: ["cv", "profile-failed"] as const,
  aiUsage: ["ai-usage"] as const,
  today: ["today"] as const,
};

/** TECHNICAL_SPEC §11: sync status polls every 30 s, the navigation counts every 60 s. */
export const SYNC_STATUS_POLL_MS = 30_000;
export const NAV_COUNTS_POLL_MS = 60_000;
export const TODAY_POLL_MS = 30_000;

/** `GET /me`: who is signed in, the instance mode and whether onboarding is done. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => apiFetch("/me", { schema: MeSchema, signal }),
  });
}

/** The owner's time zone from `GET /me`; the default until it has answered (TECHNICAL_SPEC §2). */
export function useTimezone(): string {
  return useMe().data?.timezone ?? DEFAULT_TIMEZONE;
}

/** `GET /messages/:id`: one email with its body text. The body is personal content: never log it. */
export function useMessage(id: string | null) {
  return useQuery({
    queryKey: queryKeys.message(id ?? ""),
    queryFn: ({ signal }) =>
      apiFetch(`/messages/${encodeURIComponent(id ?? "")}`, {
        schema: MessageDetailSchema,
        signal,
      }),
    enabled: id !== null,
  });
}

/** `GET /gmail/status`: connection state, last sync and first-sync progress. Polls every 30 s. */
export function useSyncStatus() {
  return useQuery({
    queryKey: queryKeys.syncStatus,
    queryFn: ({ signal }) => apiFetch("/gmail/status", { schema: SyncStatusSchema, signal }),
    refetchInterval: SYNC_STATUS_POLL_MS,
  });
}

/** `GET /nav-counts`: the four navigation badges. Polls every 60 s. */
export function useNavCounts() {
  return useQuery({
    queryKey: queryKeys.navCounts,
    queryFn: ({ signal }) => apiFetch("/nav-counts", { schema: NavCountsSchema, signal }),
    refetchInterval: NAV_COUNTS_POLL_MS,
  });
}

/** `POST /gmail/sync`: ask for a sync now, then refresh the status and the counts. */
export function useSyncGmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/gmail/sync", { method: "POST" }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus }),
        queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
      ]),
  });
}

/** `POST /gmail/disconnect`: revoke Google's access, delete the tokens and stop syncing (AC-2.8). */
export function useDisconnectGmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/gmail/disconnect", { method: "POST" }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus }),
        queryClient.invalidateQueries({ queryKey: queryKeys.today }),
      ]),
  });
}

/** `GET /ai-usage`: month-to-date cost, calls by purpose and the last 30 days (AC-15.1). */
export function useAiUsage() {
  return useQuery<AiUsage>({
    queryKey: queryKeys.aiUsage,
    queryFn: ({ signal }) => apiFetch("/ai-usage", { schema: AiUsageSchema, signal }),
  });
}

/**
 * What `POST /data/purge-email-content` answers. The contracts package has no schema for this
 * route, so the response is described here, next to the hook that reads it.
 */
export const PurgeEmailContentSchema = z.object({ messagesPurged: z.number().int().nonnegative() });
export type PurgeEmailContent = z.infer<typeof PurgeEmailContentSchema>;

/**
 * `POST /data/purge-email-content`: clear the stored text of every email (AC-15.2). Records and
 * timelines stay. The caller sends the typed `DELETE`; the server checks it again.
 */
export function usePurgeEmailContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/data/purge-email-content", {
        method: "POST",
        body: { confirm: "DELETE" },
        schema: PurgeEmailContentSchema,
      }),
    // Any email already on screen would still show its old text.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["message"] }),
  });
}

/** `POST /auth/logout`: end the session on the server (AC-1.4). */
export function useSignOut() {
  return useMutation({ mutationFn: () => apiFetch("/auth/logout", { method: "POST" }) });
}

/** `GET /settings`: the full settings, which `PUT /settings` replaces as a whole. */
export function useSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => apiFetch("/settings", { schema: SettingsSchema, signal }),
    enabled: options.enabled ?? true,
  });
}

/** `PUT /settings`: save the full settings and keep the cached copy current. */
export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Settings) =>
      apiFetch("/settings", { method: "PUT", body: settings, schema: SettingsSchema }),
    onSuccess: (saved) => queryClient.setQueryData(queryKeys.settings, saved),
  });
}

function fileForm(file: File): FormData {
  const formData = new FormData();
  formData.append("file", file);
  return formData;
}

/** What `POST /cv` came to: a profile (201), or the text stored without one (202). */
export type CvUploadOutcome =
  { profileStatus: "ok"; profile: CvProfile } | { profileStatus: "failed"; profile: null };

/** `GET /cv`: the active CV profile, or null when none has been uploaded (or its profile failed). */
export function useCv() {
  return useQuery({
    queryKey: queryKeys.cv,
    queryFn: ({ signal }) => apiFetch("/cv", { schema: CvProfileSchema.nullable(), signal }),
  });
}

/**
 * Whether the last upload of this session stored the CV text without a profile (a 202). `GET /cv`
 * answers null both then and when there is no CV, so the page remembers the difference itself; a
 * reload loses it, and the owner is offered a new upload instead.
 */
export function useCvProfileFailed(): boolean {
  return (
    useQuery({
      queryKey: queryKeys.cvProfileFailed,
      queryFn: () => false,
      initialData: false,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? false
  );
}

/**
 * `POST /cv`: upload a PDF or DOCX. TECHNICAL_SPEC §10.1: 201 with a bare `CvProfile`, or 202 with
 * `profileStatus: "failed"`; the HTTP status says which. The answer also updates the cached
 * profile, so Settings shows it without another request.
 */
export function useUploadCv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<CvUploadOutcome> => {
      const { status, data } = await apiFetchWithStatus<CvProfile | { profileStatus: "failed" }>(
        "/cv",
        {
          method: "POST",
          formData: fileForm(file),
          schema: (code) => (code === 202 ? CvUploadFailedSchema : CvProfileSchema),
        },
      );
      return status === 202
        ? { profileStatus: "failed", profile: null }
        : { profileStatus: "ok", profile: data as CvProfile };
    },
    onSuccess: (outcome) => {
      // A new CV whose profile failed is the one on file now: the old profile no longer applies.
      queryClient.setQueryData(queryKeys.cv, outcome.profile);
      queryClient.setQueryData(queryKeys.cvProfileFailed, outcome.profileStatus === "failed");
    },
  });
}

/** `POST /cv/retry-profile`: build the profile again from the stored CV text. */
export function useRetryCvProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/cv/retry-profile", { method: "POST", schema: CvProfileSchema }),
    onSuccess: (profile) => {
      queryClient.setQueryData(queryKeys.cv, profile);
      queryClient.setQueryData(queryKeys.cvProfileFailed, false);
    },
  });
}

/** `POST /leads/rerank`: rank the new leads again against the current CV profile (AC-11.4). */
export function useRerankLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/leads/rerank", { method: "POST", body: { scope: "new" } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.leads }),
  });
}

/** `POST /import/sheet/preview`: read the CSV and say what an import would do. Writes nothing. */
export function usePreviewSheetImport() {
  return useMutation({
    mutationFn: (file: File) =>
      apiFetch("/import/sheet/preview", {
        method: "POST",
        formData: fileForm(file),
        schema: SheetPreviewSchema,
      }),
  });
}

/** `POST /import/sheet/commit`: import the previewed rows, then refresh the navigation counts. */
export function useCommitSheetImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (previewId: string) =>
      apiFetch("/import/sheet/commit", {
        method: "POST",
        body: { previewId },
        schema: ImportSummarySchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
  });
}

/** `POST /gmail/start`: start reading email (the first sync) and show its status at once. */
export function useStartGmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/gmail/start", { method: "POST", schema: SyncStatusSchema }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.syncStatus, status),
    // A 409 means the first sync already started: the status says where it is.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus }),
  });
}

/** `POST /onboarding/complete`: finish setup; the answer replaces the cached account. */
export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/onboarding/complete", { method: "POST", schema: MeSchema }),
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}

/** `GET /today`: everything Today shows. Polls every 30 s (TECHNICAL_SPEC §11). */
export function useToday() {
  return useQuery({
    queryKey: queryKeys.today,
    queryFn: ({ signal }) => apiFetch("/today", { schema: TodaySchema, signal }),
    refetchInterval: TODAY_POLL_MS,
  });
}

/** Refresh what an action on Today changes: the page itself and the navigation badges. */
function useRefreshToday() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.today }),
      queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
    ]);
}

/** `POST /daily-activity`: log outreach or prep minutes; the answer updates today's counts at once. */
export function useLogDailyActivity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DailyActivityBody) =>
      apiFetch("/daily-activity", { method: "POST", body, schema: DailyCountsSchema }),
    onSuccess: (counts) =>
      queryClient.setQueryData<Today>(queryKeys.today, (today) =>
        today
          ? {
              ...today,
              counts: {
                ...today.counts,
                outreach: counts.outreach,
                prepMinutes: counts.prepMinutes,
                followUps: counts.followUps,
              },
            }
          : today,
      ),
  });
}

/** `POST /applications/:id/follow-up-done`: the owner followed up; the application leaves the list. */
export function useMarkFollowedUp() {
  const queryClient = useQueryClient();
  const refresh = useRefreshToday();
  return useMutation({
    mutationFn: (application: ApplicationSummary) =>
      apiFetch(`/applications/${encodeURIComponent(application.id)}/follow-up-done`, {
        method: "POST",
        schema: ApplicationDetailSchema,
      }),
    onSuccess: (_detail, application) => {
      queryClient.setQueryData<Today>(queryKeys.today, (today) =>
        today
          ? {
              ...today,
              followUpsDue: today.followUpsDue.filter((a) => a.id !== application.id),
            }
          : today,
      );
      return refresh();
    },
  });
}

/** `POST /search/run`: start a search now. `409 already_running` when one is under way. */
export function useRunSearch(callbacks: MutationCallbacks<SearchRun, void> = {}) {
  const refresh = useRefreshToday();
  const queryClient = useQueryClient();
  // The Leads page shows the progress card as soon as the run is on record.
  const refreshRuns = () => queryClient.invalidateQueries({ queryKey: queryKeys.searchRuns });
  return useMutation({
    mutationFn: () => apiFetch("/search/run", { method: "POST", schema: SearchRunSchema }),
    onSuccess: async (run, variables) => {
      await Promise.all([refresh(), refreshRuns()]);
      callbacks.onSuccess?.(run, variables);
    },
    onError: async (error, variables) => {
      // Someone else started it: show that run's progress.
      if (isApiError(error, "already_running")) await refreshRuns();
      callbacks.onError?.(error, variables);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Leads

/**
 * Everything a change to a lead can alter: the lists, the tab counts, Today and the badges. The
 * answer waits for the lists and Today, which the next press reads a version from; the tab counts
 * and the badges are refreshed in the background so a snackbar never waits on them.
 */
export function useRefreshLeads() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.leadCounts });
    void queryClient.invalidateQueries({ queryKey: queryKeys.navCounts });
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.leadLists }),
      queryClient.invalidateQueries({ queryKey: queryKeys.today }),
    ]);
  };
}

/** `PATCH /leads/:id`: shortlist, dismiss or put a lead back to new. Sends the lead's `version`. */
export function useSetLeadStatus(
  callbacks: MutationCallbacks<
    Lead,
    { lead: Lead; status: "shortlisted" | "dismissed" | "new" }
  > = {},
) {
  const refresh = useRefreshLeads();
  return useMutation({
    mutationFn: ({ lead, status }: { lead: Lead; status: "shortlisted" | "dismissed" | "new" }) =>
      apiFetch(`/leads/${encodeURIComponent(lead.id)}`, {
        method: "PATCH",
        body: { version: lead.version, status },
        schema: LeadSchema,
      }),
    onSuccess: async (updated, variables) => {
      await refresh();
      callbacks.onSuccess?.(updated, variables);
    },
    // 409 version_conflict: the lead changed elsewhere (a re-rank, say). Fetch the fresh record, so
    // the next try carries its version instead of the stale one.
    onError: async (error, variables) => {
      if (error instanceof ApiClientError && error.code === "version_conflict") await refresh();
      callbacks.onError?.(error, variables);
    },
  });
}

/** `POST /leads/:id/mark-applied`: the lead becomes an application (AC-9.6); the answer is that application. */
export function useMarkLeadApplied(callbacks: MutationCallbacks<ApplicationDetail, Lead> = {}) {
  const queryClient = useQueryClient();
  const refresh = useRefreshLeads();
  return useMutation({
    mutationFn: (lead: Lead) =>
      apiFetch(`/leads/${encodeURIComponent(lead.id)}/mark-applied`, {
        method: "POST",
        schema: ApplicationDetailSchema,
      }),
    onSuccess: async (application, lead) => {
      queryClient.setQueryData(queryKeys.application(application.id), application);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: queryKeys.applicationLists }),
      ]);
      callbacks.onSuccess?.(application, lead);
    },
    onError: async (error, lead) => {
      // Converted elsewhere in the meantime: show the lead as it is now.
      if (isConflict(error)) await refresh();
      callbacks.onError?.(error, lead);
    },
  });
}

/** `POST /leads/:id/reconsider`: a suppressed lead goes back to New (AC-9.7). */
export function useReconsiderLead(callbacks: MutationCallbacks<Lead, Lead> = {}) {
  const refresh = useRefreshLeads();
  return useMutation({
    mutationFn: (lead: Lead) =>
      apiFetch(`/leads/${encodeURIComponent(lead.id)}/reconsider`, {
        method: "POST",
        schema: LeadSchema,
      }),
    onSuccess: async (updated, lead) => {
      await refresh();
      callbacks.onSuccess?.(updated, lead);
    },
    onError: async (error, lead) => {
      if (isConflict(error)) await refresh();
      callbacks.onError?.(error, lead);
    },
  });
}

/** How the lists are ordered: track priority then fit (AC-12.4, the default), or newest first. */
export type LeadSort = "track_fit" | "newest";

/** What the Leads list asks for (AC-9.2, AC-12.4). `track` is a configured track key. */
export interface LeadFilters {
  status: LeadStatus;
  track: string | null;
  sort: LeadSort;
}

export const LEADS_PAGE_SIZE = 25;
/** The largest page; a tab count that reaches it reads "200+". */
export const LEADS_COUNT_LIMIT = 200;

function leadsQuery(filters: LeadFilters, cursor: string | null): string {
  const params = new URLSearchParams({ status: filters.status });
  if (filters.track !== null) params.set("track", filters.track);
  if (filters.sort !== "track_fit") params.set("sort", filters.sort);
  params.set("limit", String(LEADS_PAGE_SIZE));
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

/** `GET /leads`: one page at a time; `fetchNextPage` follows the cursor (*Show more*). */
export function useLeads(filters: LeadFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.leadList(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(`/leads?${leadsQuery(filters, pageParam)}`, {
        schema: PageSchema(LeadSchema),
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export interface LeadCount {
  count: number;
  /** True when there are more than `count` (the page limit was reached). */
  atLeast: boolean;
}

/**
 * The number behind each tab. `GET /leads` has no total, so each status is read at the largest page
 * size and counted; a status with more than that reads "200+". Not filtered by track.
 */
export function useLeadCounts(): Record<LeadStatus, LeadCount | undefined> {
  const statuses: LeadStatus[] = ["new", "shortlisted", "applied", "dismissed", "suppressed"];
  const results = useQueries({
    queries: statuses.map((status) => ({
      queryKey: queryKeys.leadCount(status),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiFetch(`/leads?status=${status}&limit=${LEADS_COUNT_LIMIT}`, {
          schema: PageSchema(LeadSchema),
          signal,
        }),
      select: (page: { items: unknown[]; nextCursor: string | null }): LeadCount => ({
        count: page.items.length,
        atLeast: page.nextCursor !== null,
      }),
    })),
  });
  return Object.fromEntries(statuses.map((status, i) => [status, results[i]?.data])) as Record<
    LeadStatus,
    LeadCount | undefined
  >;
}

const SEARCH_RUNS_POLL_MS = 30_000;
/** While a search runs, its progress is read every 5 seconds. */
export const SEARCH_RUNNING_POLL_MS = 5_000;

/** `GET /search/runs`: the last 14 runs, newest first. Polls faster while one is running. */
export function useSearchRuns() {
  return useQuery({
    queryKey: queryKeys.searchRuns,
    queryFn: ({ signal }) => apiFetch("/search/runs", { schema: SearchRunsSchema, signal }),
    // The spec does not fix the order of the list: newest first is made here.
    select: (runs) => [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === "running")
        ? SEARCH_RUNNING_POLL_MS
        : SEARCH_RUNS_POLL_MS,
  });
}

// ---------------------------------------------------------------------------------------------
// Applications

export type ApplicationSort = "last_activity" | "applied" | "status";

/** What the Applications list asks for (AC-6.1). An empty `status` list means every status. */
export interface ApplicationFilters {
  status: ApplicationStatus[];
  followUpDue: boolean;
  q: string;
  sort: ApplicationSort;
}

export const APPLICATIONS_PAGE_SIZE = 25;

function applicationsQuery(filters: ApplicationFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  for (const status of filters.status) params.append("status", status);
  if (filters.followUpDue) params.set("followUpDue", "true");
  const q = filters.q.trim();
  if (q !== "") params.set("q", q);
  params.set("sort", filters.sort);
  params.set("limit", String(APPLICATIONS_PAGE_SIZE));
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

/** `GET /applications`: one page at a time; `fetchNextPage` follows the cursor (*Show more*). */
export function useApplications(filters: ApplicationFilters, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    enabled: options.enabled ?? true,
    queryKey: queryKeys.applicationList(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(`/applications?${applicationsQuery(filters, pageParam)}`, {
        schema: PageSchema(ApplicationSummarySchema),
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * The count behind each status chip: the pipeline totals of `GET /today`. It shares Today's cache
 * but does not poll, because the Applications page does not refresh by itself.
 */
export function usePipelineCounts() {
  return useQuery({
    queryKey: queryKeys.today,
    queryFn: ({ signal }) => apiFetch("/today", { schema: TodaySchema, signal }),
    select: (today) => today.pipeline.byStatus,
  });
}

/** `GET /applications/:id`: the record, its interviews, emails and timeline. */
export function useApplication(id: string) {
  return useQuery({
    queryKey: queryKeys.application(id),
    queryFn: ({ signal }) =>
      apiFetch(`/applications/${encodeURIComponent(id)}`, {
        schema: ApplicationDetailSchema,
        signal,
      }),
  });
}

/** What a mutation reports back to the screen. Passed to the hook, never to `mutate`. */
export interface MutationCallbacks<TData, TVariables> {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
}

export function isApiError(error: unknown, code: string): boolean {
  return error instanceof ApiClientError && error.code === code;
}

/** Any 409: the record changed elsewhere, whatever code the API puts on it. */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 409;
}

/** Everything a change to an application can alter: the lists, Today and the navigation badges. */
function refreshAfterApplicationChange(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.applicationLists }),
    queryClient.invalidateQueries({ queryKey: queryKeys.today }),
    queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
  ]);
}

/** `POST /applications`: add an application by hand (AC-6.3). */
export function useCreateApplication(
  callbacks: MutationCallbacks<ApplicationDetail, ApplicationCreate> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApplicationCreate) =>
      apiFetch("/applications", { method: "POST", body, schema: ApplicationDetailSchema }),
    onSuccess: async (detail, body) => {
      queryClient.setQueryData(queryKeys.application(detail.id), detail);
      await refreshAfterApplicationChange(queryClient);
      callbacks.onSuccess?.(detail, body);
    },
    onError: callbacks.onError,
  });
}

export interface ApplicationUpdate {
  application: Pick<ApplicationSummary, "id" | "version">;
  patch: Omit<ApplicationPatch, "version">;
}

/**
 * `PATCH /applications/:id` with the record's `version`. A `409 version_conflict` means it changed
 * elsewhere: the record and the lists are fetched again before `onError` hears of it, so the
 * screen shows the fresh record and the next try carries the fresh version (TECHNICAL_SPEC §11).
 */
export function useUpdateApplication(
  callbacks: MutationCallbacks<ApplicationDetail, ApplicationUpdate> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ application, patch }: ApplicationUpdate) =>
      apiFetch(`/applications/${encodeURIComponent(application.id)}`, {
        method: "PATCH",
        body: { ...patch, version: application.version },
        schema: ApplicationDetailSchema,
      }),
    onSuccess: async (detail, update) => {
      queryClient.setQueryData(queryKeys.application(detail.id), detail);
      await refreshAfterApplicationChange(queryClient);
      callbacks.onSuccess?.(detail, update);
    },
    onError: async (error, update) => {
      if (isApiError(error, "version_conflict")) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.application(update.application.id) }),
          refreshAfterApplicationChange(queryClient),
        ]);
      }
      callbacks.onError?.(error, update);
    },
  });
}

/** `POST /events/:id/undo`: undo an automatic change (AC-4.3). Everything it touched is fetched again. */
export function useUndoEvent(callbacks: MutationCallbacks<{ undone: true }, string> = {}) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.leadCounts });
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.applications }),
      // Undoing an email's change can delete or restore the interviews it made.
      queryClient.invalidateQueries({ queryKey: queryKeys.interviews }),
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewItems }),
      // Undoing *Mark applied* puts the lead back where it was; the tab counts follow in the background.
      queryClient.invalidateQueries({ queryKey: queryKeys.leadLists }),
      queryClient.invalidateQueries({ queryKey: queryKeys.today }),
      queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
    ]);
  };
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch(`/events/${encodeURIComponent(eventId)}/undo`, {
        method: "POST",
        schema: UndoResultSchema,
      }),
    onSuccess: async (result, eventId) => {
      await refresh();
      callbacks.onSuccess?.(result, eventId);
    },
    onError: async (error, eventId) => {
      // `changed_since` or a version conflict: show the record as it is now, with its entries' flags.
      if (isApiError(error, "changed_since") || isApiError(error, "version_conflict")) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.applications });
      }
      callbacks.onError?.(error, eventId);
    },
  });
}

/** `POST /applications/:id/merge`: fold one application into another; the answer is the target. */
export function useMergeApplication(
  callbacks: MutationCallbacks<ApplicationDetail, { id: string; intoId: string }> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, intoId }: { id: string; intoId: string }) =>
      apiFetch(`/applications/${encodeURIComponent(id)}/merge`, {
        method: "POST",
        body: { intoId },
        schema: ApplicationDetailSchema,
      }),
    onSuccess: async (target, variables) => {
      queryClient.setQueryData(queryKeys.application(target.id), target);
      // The merged application's interviews now belong to the target.
      await Promise.all([
        refreshAfterApplicationChange(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.interviews }),
      ]);
      callbacks.onSuccess?.(target, variables);
    },
    onError: callbacks.onError,
  });
}

// ---------------------------------------------------------------------------------------------
// Review

export type ReviewListState = "open" | "resolved";

export const REVIEW_PAGE_SIZE = 25;

/** `GET /review-items`: one page at a time; `fetchNextPage` follows the cursor (*Show more*). */
export function useReviewItems(state: ReviewListState) {
  return useInfiniteQuery({
    queryKey: queryKeys.reviewList(state),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ state, limit: String(REVIEW_PAGE_SIZE) });
      if (pageParam !== null) params.set("cursor", pageParam);
      return apiFetch(`/review-items?${params.toString()}`, {
        schema: PageSchema(ReviewItemSchema),
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export interface ReviewResolution {
  item: Pick<ReviewItem, "id" | "kind">;
  resolve: ReviewResolve;
}

/**
 * `POST /review-items/:id/resolve` (AC-5.3): the owner's choice runs through the same code path as
 * an automatic change, so it can touch applications, interviews, companies and leads. All of them,
 * Today and the badges are fetched again. A 409 means the item or what it points at changed
 * elsewhere: the lists are fetched again before `onError` hears of it.
 */
export function useResolveReviewItem(
  callbacks: MutationCallbacks<ReviewItem, ReviewResolution> = {},
) {
  const queryClient = useQueryClient();
  const refreshReview = () => queryClient.invalidateQueries({ queryKey: queryKeys.reviewItems });
  return useMutation({
    mutationFn: ({ item, resolve }: ReviewResolution) =>
      apiFetch(`/review-items/${encodeURIComponent(item.id)}/resolve`, {
        method: "POST",
        body: resolve,
        schema: ReviewItemSchema,
      }),
    onSuccess: async (resolved, variables) => {
      // Tab counts of the Leads page (a merge can suppress leads) follow in the background.
      void queryClient.invalidateQueries({ queryKey: queryKeys.leadCounts });
      await Promise.all([
        refreshReview(),
        queryClient.invalidateQueries({ queryKey: queryKeys.applications }),
        // Attaching or reprocessing an invitation creates or moves an interview.
        queryClient.invalidateQueries({ queryKey: queryKeys.interviews }),
        queryClient.invalidateQueries({ queryKey: queryKeys.leadLists }),
        queryClient.invalidateQueries({ queryKey: queryKeys.today }),
        queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
      ]);
      callbacks.onSuccess?.(resolved, variables);
    },
    onError: async (error, variables) => {
      if (isConflict(error)) {
        await Promise.all([
          refreshReview(),
          queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
        ]);
      }
      callbacks.onError?.(error, variables);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Interviews

export type InterviewRange = "upcoming" | "past";

export const INTERVIEWS_PAGE_SIZE = 25;

/** `GET /interviews`: one page at a time; `fetchNextPage` follows the cursor (*Show more*). */
export function useInterviews(range: InterviewRange) {
  return useInfiniteQuery({
    queryKey: queryKeys.interviewList(range),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ range, limit: String(INTERVIEWS_PAGE_SIZE) });
      if (pageParam !== null) params.set("cursor", pageParam);
      return apiFetch(`/interviews?${params.toString()}`, {
        schema: PageSchema(InterviewWithApplicationSchema),
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Everything a change to an interview can alter: both lists, the application it belongs to (its
 * detail and its next interview), Today and the navigation badge. The answer waits for the lists,
 * which the next press reads a version from; the rest follows in the background.
 */
function refreshAfterInterviewChange(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.applications });
  void queryClient.invalidateQueries({ queryKey: queryKeys.today });
  void queryClient.invalidateQueries({ queryKey: queryKeys.navCounts });
  return queryClient.invalidateQueries({ queryKey: queryKeys.interviews });
}

export interface InterviewCreation {
  applicationId: string;
  body: InterviewCreate;
}

/** `POST /applications/:id/interviews`: add an interview by hand (AC-8.5). */
export function useCreateInterview(
  callbacks: MutationCallbacks<Interview, InterviewCreation> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId, body }: InterviewCreation) =>
      apiFetch(`/applications/${encodeURIComponent(applicationId)}/interviews`, {
        method: "POST",
        body,
        schema: InterviewSchema,
      }),
    onSuccess: async (interview, variables) => {
      await refreshAfterInterviewChange(queryClient);
      callbacks.onSuccess?.(interview, variables);
    },
    onError: callbacks.onError,
  });
}

export interface InterviewUpdate {
  interview: Pick<Interview, "id" | "version">;
  patch: Omit<InterviewPatch, "version">;
}

/**
 * `PATCH /interviews/:id` with the interview's `version` (AC-8.5). A 409 means it changed elsewhere:
 * the lists are fetched again before `onError` hears of it, so the next try carries the fresh version.
 */
export function useUpdateInterview(callbacks: MutationCallbacks<Interview, InterviewUpdate> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ interview, patch }: InterviewUpdate) =>
      apiFetch(`/interviews/${encodeURIComponent(interview.id)}`, {
        method: "PATCH",
        body: { ...patch, version: interview.version },
        schema: InterviewSchema,
      }),
    onSuccess: async (updated, variables) => {
      await refreshAfterInterviewChange(queryClient);
      callbacks.onSuccess?.(updated, variables);
    },
    onError: async (error, variables) => {
      if (isConflict(error)) await refreshAfterInterviewChange(queryClient);
      callbacks.onError?.(error, variables);
    },
  });
}
