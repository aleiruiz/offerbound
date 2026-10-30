import { vi } from "vitest";

export type MockHandler = (req: Request) => unknown;

export interface MockApi {
  /** Every request seen so far, in order. */
  calls: Request[];
  fetch: ReturnType<typeof vi.fn>;
  /**
   * The multipart body a request was sent with. jsdom's `File` cannot be read back through the
   * `Request` of the test runtime, so the form is kept aside instead of being serialised.
   */
  upload(req: Request): FormData | undefined;
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
 * A handler (sync or async) returns a `Response` (used as is) or any value (sent as JSON with status 200,
 * or 204 for `undefined`). A request with no route throws, so a missing mock fails the test.
 */
export function mockApi(routes: Record<string, MockHandler>): MockApi {
  const calls: Request[] = [];
  const uploads = new WeakMap<Request, FormData>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const form = init?.body instanceof FormData ? init.body : undefined;
    const req = new Request(url, form ? { ...init, body: null } : init);
    if (form) uploads.set(req, form);
    calls.push(req);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      return Promise.reject(new Error(`mockApi: no route for ${req.method} ${url.pathname}`));
    }
    return Promise.resolve(handler(req)).then((result) => {
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      return jsonResponse(result);
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetch: fetchMock, upload: (req) => uploads.get(req) };
}
