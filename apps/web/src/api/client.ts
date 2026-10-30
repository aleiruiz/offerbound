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
  schema?: ZodType<T>;
  signal?: AbortSignal;
}

type UnauthorizedHandler = () => void;

function redirectToLogin(): void {
  if (window.location.pathname !== "/login") window.location.assign("/login");
}

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** The app registers a router navigation here; without one a 401 does a full page load of /login. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
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
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
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
    throw error;
  }

  if (res.status === 204) return undefined as T;
  const json = await readJson(res);
  if (!init.schema) return json as T;
  const parsed = init.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError({
      status: res.status,
      code: "unexpected_response",
      message: "The server answered with data this version of Offerbound does not understand.",
      body: json,
    });
  }
  return parsed.data;
}
