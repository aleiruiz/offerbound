import {
  CvUploadResultSchema,
  ImportSummarySchema,
  MeSchema,
  MessageDetailSchema,
  NavCountsSchema,
  SettingsSchema,
  SheetPreviewSchema,
  SyncStatusSchema,
  type Settings,
} from "@offerbound/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export const queryKeys = {
  me: ["me"] as const,
  message: (id: string) => ["message", id] as const,
  syncStatus: ["sync-status"] as const,
  navCounts: ["nav-counts"] as const,
  settings: ["settings"] as const,
};

/** TECHNICAL_SPEC §11: sync status polls every 30 s, the navigation counts every 60 s. */
export const SYNC_STATUS_POLL_MS = 30_000;
export const NAV_COUNTS_POLL_MS = 60_000;

/** `GET /me`: who is signed in, the instance mode and whether onboarding is done. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => apiFetch("/me", { schema: MeSchema, signal }),
  });
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

/** `POST /cv`: upload a PDF or DOCX. The answer carries the profile, or `profileStatus: "failed"`. */
export function useUploadCv() {
  return useMutation({
    mutationFn: (file: File) =>
      apiFetch("/cv", { method: "POST", formData: fileForm(file), schema: CvUploadResultSchema }),
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
