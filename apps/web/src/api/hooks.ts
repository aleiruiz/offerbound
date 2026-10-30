import {
  MeSchema,
  MessageDetailSchema,
  NavCountsSchema,
  SyncStatusSchema,
} from "@offerbound/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export const queryKeys = {
  me: ["me"] as const,
  message: (id: string) => ["message", id] as const,
  syncStatus: ["sync-status"] as const,
  navCounts: ["nav-counts"] as const,
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
