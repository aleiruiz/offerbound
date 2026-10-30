import type { ZodType } from "zod";
import { ApiErrorBodySchema } from "@offerbound/contracts";

const BASE_PATH = "/api/v1";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  /** The parsed JSON response body (for example the current record of a 409), or null. */
  readonly body: unknown;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    fields?: Record<string, string>;
    body?: unknown;
  }) {
    super(init.message);
    this.name = "ApiClientError";
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields ?? {};
    this.body = init.body ?? null;
  }
}

export interface ApiFetchInit<T> {
  method?: string;
  /** A JSON request body. */
  body?: unknown;
  /** A multipart request body (file uploads); the browser sets the boundary header. */
  formData?: FormData;
  /** Validates the response body. A function picks the schema by HTTP status. */
  schema?: ZodType<T> | ((status: number) => ZodType<T>);
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

type UnauthorizedHandler = () => void;

function redirectToLogin(): void {
  if (window.location.pathname !== "/login") window.location.assign("/login");
}

let unauthorizedHandler: UnauthorizedHandler | null = null;
let demoReadOnlyHandler: (() => void) | null = null;

/** The app registers a router navigation here; without one a 401 does a full page load of /login. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/**
 * The app registers what to tell the visitor when the public demo refuses a request with
 * `403 demo_read_only` (TECHNICAL_SPEC §10 errors, §12). The controls that take free text are disabled in
 * the demo, so this is only for a request that got through.
 */
export function setDemoReadOnlyHandler(handler: (() => void) | null): void {
  demoReadOnlyHandler = handler;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit<T> = {}): Promise<T> {
  return (await apiFetchWithStatus(path, init)).data;
}

/** Sends the request and throws an `ApiClientError` for any non-2xx answer. */
async function send(path: string, init: ApiFetchInit<unknown>, accept: string): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: accept };
  if (method !== "GET") headers["X-Offerbound-Request"] = "1";
  let body: string | FormData | undefined;
  if (init.formData !== undefined) {
    body = init.formData;
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const res = await fetch(`${BASE_PATH}${path}`, {
    method,
    headers,
    body,
    credentials: "same-origin",
    signal: init.signal,
  });

  if (!res.ok) {
    const json = await readJson(res);
    const envelope = ApiErrorBodySchema.safeParse(json);
    const error = envelope.success
      ? new ApiClientError({
          status: res.status,
          code: envelope.data.error.code,
          message: envelope.data.error.message,
          fields: envelope.data.error.fields,
          body: json,
        })
      : new ApiClientError({
          status: res.status,
          code: "unexpected_response",
          message: `The server answered with status ${res.status}.`,
          body: json,
        });
    if (res.status === 401) (unauthorizedHandler ?? redirectToLogin)();
    if (res.status === 403 && error.code === "demo_read_only") {
      // After the caller's own error handling, so its generic "couldn't save" does not cover this.
      setTimeout(() => demoReadOnlyHandler?.(), 0);
    }
    throw error;
  }
  return res;
}

/** For routes that answer `text/plain` (the companies-seen list): the body as a string. */
export async function apiFetchText(
  path: string,
  init: Pick<ApiFetchInit<string>, "signal"> = {},
): Promise<string> {
  const res = await send(path, init, "text/plain");
  return res.text();
}

/** Like `apiFetch`, but also says which 2xx status answered (for routes whose body depends on it). */
export async function apiFetchWithStatus<T = unknown>(
  path: string,
  init: ApiFetchInit<T> = {},
): Promise<ApiResponse<T>> {
  const res = await send(path, init, "application/json");
  if (res.status === 204) return { status: res.status, data: undefined as T };
  const json = await readJson(res);
  const schema = typeof init.schema === "function" ? init.schema(res.status) : init.schema;
  if (!schema) return { status: res.status, data: json as T };
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError({
      status: res.status,
      code: "unexpected_response",
      message: "The server answered with data this version of Offerbound does not understand.",
      body: json,
    });
  }
  return { status: res.status, data: parsed.data };
}
