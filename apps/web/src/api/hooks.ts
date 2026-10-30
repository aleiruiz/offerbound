import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { MeSchema } from "./contracts-stub";

export const queryKeys = {
  me: ["me"] as const,
};

/** `GET /me`: who is signed in, the instance mode and whether onboarding is done. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => apiFetch("/me", { schema: MeSchema, signal }),
  });
}
