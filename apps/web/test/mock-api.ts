import { vi } from "vitest";

export type MockHandler = (req: Request) => unknown;

export interface MockApi {
  /** Every request seen so far, in order. */
  calls: Request[];
  fetch: ReturnType<typeof vi.fn>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): Response {
  return jsonResponse({ error: { code, message, ...(fields ? { fields } : {}) } }, status);
}

/**
 * Stubs `fetch`. Routes are keyed by method and path without query, e.g. `"GET /api/v1/me"`.
 * A handler returns a `Response` (used as is) or any value (sent as JSON with status 200,
 * or 204 for `undefined`). A request with no route throws, so a missing mock fails the test.
 */
export function mockApi(routes: Record<string, MockHandler>): MockApi {
  const calls: Request[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const req = new Request(url, init);
    calls.push(req);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      return Promise.reject(new Error(`mockApi: no route for ${req.method} ${url.pathname}`));
    }
    const result = handler(req);
    if (result instanceof Response) return Promise.resolve(result);
    if (result === undefined) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(jsonResponse(result));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetch: fetchMock };
}
