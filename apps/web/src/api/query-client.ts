import { QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "./client";

/**
 * Retry once, but only a network failure or a 5xx: a 4xx, or a body that fails its schema,
 * would fail the same way again.
 */
export function retryOnce(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: retryOnce, refetchOnWindowFocus: true },
    },
  });
}
