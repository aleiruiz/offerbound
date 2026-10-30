import { MeSchema, MessageDetailSchema } from "@offerbound/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";

export const queryKeys = {
  me: ["me"] as const,
  message: (id: string) => ["message", id] as const,
};

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
