import { gmail as createGmailApi, type gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client, type Credentials } from "google-auth-library";
import type { PrismaClient } from "@prisma/client";
import type { MessageMetadata } from "@offerbound/contracts";
import { decryptToken, encryptToken } from "../auth/crypto.js";
import type { Env } from "../config/env.js";
import { isCalendarPart, MAX_ICS_BYTES, parseMessageHeaders } from "./mime.js";

/**
 * The Gmail client the sync and pipeline jobs use (TECHNICAL_SPEC §5.2, §13).
 *
 * It uses the owner's stored OAuth tokens (read-only scope), refreshes the access token when it
 * is about to expire and stores the new one encrypted. It never logs, and the errors it throws
 * carry no tokens, headers, addresses or response bodies: only a fixed message and, where
 * useful, an HTTP status.
 */
export interface GmailClient {
  getProfile(): Promise<{ historyId: string; emailAddress: string }>;
  listMessages(
    q: string,
    pageToken: string | null,
  ): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken: string | null }>;
  listHistory(
    startHistoryId: string,
    pageToken: string | null,
  ): Promise<{
    added: { id: string; threadId: string }[];
    historyId: string;
    nextPageToken: string | null;
  }>;
  /** `format=metadata` with the headers From, To, Cc, Subject, Date and List-Id. */
  getMetadata(id: string): Promise<MessageMetadata>;
  /** `format=full`, with `.ics` attachments inlined into `body.data` so parsing can stay synchronous. */
  getFull(id: string): Promise<gmail_v1.Schema$Message>;
}

/** Loads the owner's tokens, refreshes them, stores the new access token. */
export type GmailClientFactory = () => Promise<GmailClient>;

// ---------------------------------------------------------------------------------------------
// Errors (fixed messages: nothing from Google's responses is copied into them)
// ---------------------------------------------------------------------------------------------

/**
 * The authorization is gone: the refresh token was rejected (`invalid_grant`), the stored tokens
 * cannot be used, or the Gmail permission was removed (`missing_scope`). The connection has been
 * marked `needs_reauth` or `missing_scope` before this is thrown, and sync should stop.
 */
export abstract class GmailError extends Error {}

export class GmailAuthError extends GmailError {
  constructor(
    readonly reason: "invalid_grant" | "missing_scope" | "not_connected" = "invalid_grant",
  ) {
    super("Gmail authorization is no longer valid.");
    this.name = "GmailAuthError";
  }
}

/** `history.list` answered 404: the start history id is too old. Re-list instead (AC-2.7). */
export class GmailHistoryExpiredError extends GmailError {
  constructor() {
    super("The Gmail history id has expired.");
    this.name = "GmailHistoryExpiredError";
  }
}

/** The longest `Retry-After` the client reports; a larger value is clamped to this. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** 429, 5xx, a quota error or a network failure: retry with backoff (§5.2 step 5). */
export class GmailRetryableError extends GmailError {
  constructor(
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super("Gmail is temporarily unavailable.");
    this.name = "GmailRetryableError";
  }
}

/** A message or attachment that no longer exists (deleted between listing and fetching). */
export class GmailMessageNotFoundError extends GmailError {
  constructor() {
    super("The Gmail message was not found.");
    this.name = "GmailMessageNotFoundError";
  }
}

/** Any other Gmail failure. Not retried. */
export class GmailRequestError extends GmailError {
  constructor(readonly status: number | null) {
    super("The Gmail request failed.");
    this.name = "GmailRequestError";
  }
}

// ---------------------------------------------------------------------------------------------
// Seams: where the tokens live, and the calls to Google (tests replace both)
// ---------------------------------------------------------------------------------------------

/**
 * Which stored connection a write is meant for: the Google account and the encrypted refresh token
 * the client loaded. A write that finds a different row (Disconnect or a reconnect happened while
 * the job was running) changes nothing.
 */
export type ConnectionIdentity = { googleSub: string; refreshTokenEnc: string };

export type StoredGmailConnection = {
  status: "active" | "needs_reauth" | "missing_scope" | "disconnected";
  googleSub: string;
  refreshTokenEnc: string | null;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
};

export interface GmailConnectionStore {
  load(): Promise<StoredGmailConnection | null>;
  /**
   * Stores a refreshed access token; `refreshTokenEnc` only when Google rotated the refresh token.
   * Applies only while the row is still the `expected` active one; returns whether it did.
   */
  saveAccessToken(
    expected: ConnectionIdentity,
    update: { accessTokenEnc: string; accessTokenExpiresAt: Date; refreshTokenEnc?: string },
  ): Promise<boolean>;
  /**
   * Marks the singleton connection unusable until the owner reconnects. Applies only while the row
   * is still the `expected` active one, so a stale job cannot flip a reconnected row.
   */
  markUnusable(
    expected: ConnectionIdentity,
    status: "needs_reauth" | "missing_scope",
    error: string,
  ): Promise<boolean>;
}

/** The singleton `gmail_connection` row (DATA_MODEL §3.14). */
export function createPrismaConnectionStore(prisma: PrismaClient): GmailConnectionStore {
  return {
    async load() {
      return prisma.gmailConnection.findUnique({
        where: { id: 1 },
        select: {
          status: true,
          googleSub: true,
          refreshTokenEnc: true,
          accessTokenEnc: true,
          accessTokenExpiresAt: true,
        },
      });
    },
    async saveAccessToken(expected, update) {
      const { count } = await prisma.gmailConnection.updateMany({
        where: { id: 1, status: "active", ...expected },
        data: update,
      });
      return count > 0;
    },
    async markUnusable(expected, status, error) {
      const { count } = await prisma.gmailConnection.updateMany({
        where: { id: 1, status: "active", ...expected },
        data: { status, lastSyncError: error },
      });
      return count > 0;
    },
  };
}

/** The part of `OAuth2Client` the factory uses. */
export interface GmailOAuth {
  setCredentials(credentials: Credentials): void;
  refreshAccessToken(): Promise<{ credentials: Credentials }>;
}

/** The Gmail API calls the client makes, flattened to what it needs. */
export interface GmailTransport {
  getProfile(): Promise<gmail_v1.Schema$Profile>;
  listMessages(p: {
    q: string;
    pageToken?: string;
    maxResults: number;
  }): Promise<gmail_v1.Schema$ListMessagesResponse>;
  listHistory(p: {
    startHistoryId: string;
    pageToken?: string;
    maxResults: number;
  }): Promise<gmail_v1.Schema$ListHistoryResponse>;
  getMessage(p: {
    id: string;
    format: "metadata" | "full";
    metadataHeaders?: string[];
  }): Promise<gmail_v1.Schema$Message>;
  getAttachment(p: {
    messageId: string;
    attachmentId: string;
  }): Promise<gmail_v1.Schema$MessagePartBody>;
}

const REQUEST_TIMEOUT_MS = 30_000;

function createGoogleSession(config: { clientId: string; clientSecret: string }): {
  oauth: GmailOAuth;
  transport: GmailTransport;
} {
  const oauth = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret });
  const api = createGmailApi({ version: "v1", auth: oauth, timeout: REQUEST_TIMEOUT_MS });
  const messages = api.users.messages;
  const transport: GmailTransport = {
    getProfile: async () => (await api.users.getProfile({ userId: "me" })).data,
    listMessages: async ({ q, pageToken, maxResults }) =>
      (
        await messages.list({
          userId: "me",
          q,
          maxResults,
          includeSpamTrash: false,
          ...(pageToken ? { pageToken } : {}),
        })
      ).data,
    listHistory: async ({ startHistoryId, pageToken, maxResults }) =>
      (
        await api.users.history.list({
          userId: "me",
          startHistoryId,
          maxResults,
          historyTypes: ["messageAdded"],
          ...(pageToken ? { pageToken } : {}),
        })
      ).data,
    getMessage: async ({ id, format, metadataHeaders }) =>
      (
        await messages.get({
          userId: "me",
          id,
          format,
          ...(metadataHeaders ? { metadataHeaders } : {}),
        })
      ).data,
    getAttachment: async ({ messageId, attachmentId }) =>
      (await messages.attachments.get({ userId: "me", messageId, id: attachmentId })).data,
  };
  return { oauth, transport };
}

// ---------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------

type ErrorFacts = {
  status: number | null;
  /** Machine-readable reason strings from the response (never shown or logged). */
  reasons: string[];
  retryAfterMs: number | null;
  invalidGrant: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Reads status and reason codes from a gaxios-style error, ignoring everything else in it. */
function factsOf(error: unknown): ErrorFacts {
  const err = asRecord(error);
  const response = asRecord(err?.response);
  const data = asRecord(response?.data);
  const nested = asRecord(data?.error);

  const statusCandidates = [response?.status, err?.status, err?.code];
  const status = statusCandidates.find((s): s is number => typeof s === "number") ?? null;

  const reasons: string[] = [];
  if (typeof data?.error === "string") reasons.push(data.error);
  if (typeof nested?.status === "string") reasons.push(nested.status);
  const listed = Array.isArray(nested?.errors) ? nested.errors : [];
  for (const item of listed) {
    const reason = asRecord(item)?.reason;
    if (typeof reason === "string") reasons.push(reason);
  }

  let retryAfterMs: number | null = null;
  const headers = asRecord(response?.headers);
  // gaxios returns a fetch Headers object; a plain object is accepted too.
  const retryAfter =
    typeof headers?.get === "function"
      ? (headers.get as (name: string) => unknown).call(headers, "retry-after")
      : (headers?.["retry-after"] ?? headers?.["Retry-After"]);
  if (typeof retryAfter === "string" && /^\d{1,6}$/.test(retryAfter.trim())) {
    retryAfterMs = Math.min(Number(retryAfter.trim()) * 1000, MAX_RETRY_AFTER_MS);
  }

  const message = typeof err?.message === "string" ? err.message : "";
  return {
    status,
    reasons,
    retryAfterMs,
    invalidGrant: reasons.includes("invalid_grant") || /\binvalid_grant\b/.test(message),
  };
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "RESOURCE_EXHAUSTED",
  "backendError",
]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

function isRetryable(facts: ErrorFacts): boolean {
  // No HTTP status means the request never completed (reset, timeout, DNS).
  if (facts.status === null) return true;
  if (facts.status === 429 || facts.status >= 500) return true;
  return facts.status === 403 && facts.reasons.some((r) => RATE_LIMIT_REASONS.has(r));
}

// ---------------------------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------------------------

const MAX_RESULTS = 500;
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "List-Id"];
/** An access token with less than this left is refreshed before use. */
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 25;
const MAX_ATTACHMENT_FETCHES = 5;
const MAX_PARTS_WALKED = 500;

export type GmailClientOptions = {
  store: GmailConnectionStore;
  env: Pick<Env, "google" | "tokenEncryptionKey">;
  clock: () => Date;
  /**
   * Minimum gap between two requests made through clients from this factory (default 25 ms, about
   * 40 a second, well inside Gmail's per-user quota). 429 and 5xx are left to the job queue's backoff.
   */
  minRequestIntervalMs?: number;
  /** Replaces the Google OAuth client and API calls (tests). */
  createSession?: (google: { clientId: string; clientSecret: string }) => {
    oauth: GmailOAuth;
    transport: GmailTransport;
  };
};

export function createGmailClientFactory(options: GmailClientOptions): GmailClientFactory {
  const { store, env, clock } = options;
  const interval = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
  const makeSession = options.createSession ?? createGoogleSession;

  // Shared by every client this factory makes, so concurrent jobs share one request budget.
  let nextSlot = 0;
  const pace = async (): Promise<void> => {
    if (interval <= 0) return;
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + interval;
    if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
  };

  return async () => {
    const key = env.tokenEncryptionKey;
    if (!env.google || !key) throw new Error("Gmail is not configured.");
    const { oauth, transport } = makeSession(env.google);

    const row = await store.load();
    if (!row || row.status === "disconnected" || row.refreshTokenEnc === null) {
      throw new GmailAuthError("not_connected");
    }
    if (row.status !== "active") {
      throw new GmailAuthError(row.status === "missing_scope" ? "missing_scope" : "invalid_grant");
    }

    // The row this client loaded. Writes are conditional on it, and follow a rotated refresh token.
    let identity: ConnectionIdentity = {
      googleSub: row.googleSub,
      refreshTokenEnc: row.refreshTokenEnc,
    };

    let refreshToken: string;
    try {
      refreshToken = decryptToken(row.refreshTokenEnc, key);
    } catch {
      // Changing TOKEN_ENCRYPTION_KEY makes stored tokens unreadable by design: reconnect.
      await store.markUnusable(identity, "needs_reauth", "token_unreadable: reconnect Google.");
      throw new GmailAuthError("invalid_grant");
    }

    const refresh = async (): Promise<void> => {
      oauth.setCredentials({ refresh_token: refreshToken });
      let credentials: Credentials;
      try {
        credentials = (await oauth.refreshAccessToken()).credentials;
      } catch (error) {
        const facts = factsOf(error);
        if (facts.invalidGrant) {
          await store.markUnusable(
            identity,
            "needs_reauth",
            "invalid_grant: Google rejected the stored authorization.",
          );
          throw new GmailAuthError("invalid_grant");
        }
        if (isRetryable(facts)) throw new GmailRetryableError(facts.status, facts.retryAfterMs);
        throw new GmailRequestError(facts.status);
      }
      const accessToken = credentials.access_token;
      if (!accessToken) throw new GmailRequestError(null);
      const expiresAt = new Date(credentials.expiry_date ?? clock().getTime() + 3_600_000);
      const rotated =
        credentials.refresh_token && credentials.refresh_token !== refreshToken
          ? credentials.refresh_token
          : null;
      const rotatedEnc = rotated ? encryptToken(rotated, key) : null;
      const applied = await store.saveAccessToken(identity, {
        accessTokenEnc: encryptToken(accessToken, key),
        accessTokenExpiresAt: expiresAt,
        ...(rotatedEnc ? { refreshTokenEnc: rotatedEnc } : {}),
      });
      if (rotated) refreshToken = rotated;
      if (rotatedEnc && applied) identity = { ...identity, refreshTokenEnc: rotatedEnc };
      oauth.setCredentials({ access_token: accessToken, expiry_date: expiresAt.getTime() });
    };

    const stored = readStoredAccessToken(row, key, clock);
    if (stored) {
      oauth.setCredentials({
        access_token: stored.token,
        expiry_date: stored.expiresAt.getTime(),
      });
    } else {
      await refresh();
    }

    /** One request: paced, with errors mapped; a 401 refreshes the token once and retries. */
    const call = async <T>(
      operation: () => Promise<T>,
      map: (facts: ErrorFacts) => Error | null = () => null,
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        await pace();
        try {
          return await operation();
        } catch (error) {
          if (error instanceof GmailError) throw error;
          const facts = factsOf(error);
          if (facts.status === 401 && attempt === 0) {
            await refresh();
            continue;
          }
          if (facts.status === 403 && facts.reasons.some((r) => SCOPE_REASONS.has(r))) {
            await store.markUnusable(
              identity,
              "missing_scope",
              "missing_scope: Gmail access was not granted.",
            );
            throw new GmailAuthError("missing_scope");
          }
          const mapped = map(facts);
          if (mapped) throw mapped;
          if (isRetryable(facts) || facts.status === 401) {
            throw new GmailRetryableError(facts.status, facts.retryAfterMs);
          }
          if (facts.status === 404) throw new GmailMessageNotFoundError();
          throw new GmailRequestError(facts.status);
        }
      }
    };

    const client: GmailClient = {
      async getProfile() {
        const profile = await call(() => transport.getProfile());
        if (!profile.historyId || !profile.emailAddress) throw new GmailRequestError(null);
        return { historyId: profile.historyId, emailAddress: profile.emailAddress };
      },

      async listMessages(q, pageToken) {
        const res = await call(() =>
          transport.listMessages({
            q,
            maxResults: MAX_RESULTS,
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        return { ids: toRefs(res.messages), nextPageToken: res.nextPageToken || null };
      },

      async listHistory(startHistoryId, pageToken) {
        const res = await call(
          () =>
            transport.listHistory({
              startHistoryId,
              maxResults: MAX_RESULTS,
              ...(pageToken ? { pageToken } : {}),
            }),
          (facts) => (facts.status === 404 ? new GmailHistoryExpiredError() : null),
        );
        const seen = new Set<string>();
        const added: { id: string; threadId: string }[] = [];
        for (const record of res.history ?? []) {
          for (const ref of toRefs(record.messagesAdded?.map((m) => m.message ?? {}))) {
            if (seen.has(ref.id)) continue;
            seen.add(ref.id);
            added.push(ref);
          }
        }
        return {
          added,
          historyId: res.historyId || startHistoryId,
          nextPageToken: res.nextPageToken || null,
        };
      },

      async getMetadata(id) {
        const msg = await call(() =>
          transport.getMessage({ id, format: "metadata", metadataHeaders: METADATA_HEADERS }),
        );
        return toMetadata(msg);
      },

      async getFull(id) {
        const msg = await call(() => transport.getMessage({ id, format: "full" }));
        await inlineCalendarAttachments(msg, (attachmentId) =>
          call(() => transport.getAttachment({ messageId: id, attachmentId })),
        );
        return msg;
      },
    };
    return client;
  };
}

function readStoredAccessToken(
  row: StoredGmailConnection,
  key: Buffer,
  clock: () => Date,
): { token: string; expiresAt: Date } | null {
  if (row.accessTokenEnc === null || row.accessTokenExpiresAt === null) return null;
  if (row.accessTokenExpiresAt.getTime() - clock().getTime() < REFRESH_MARGIN_MS) return null;
  try {
    return { token: decryptToken(row.accessTokenEnc, key), expiresAt: row.accessTokenExpiresAt };
  } catch {
    return null; // unreadable: a refresh replaces it
  }
}

function toRefs(
  messages: gmail_v1.Schema$Message[] | undefined,
): { id: string; threadId: string }[] {
  const refs: { id: string; threadId: string }[] = [];
  for (const m of messages ?? []) {
    if (m.id && m.threadId) refs.push({ id: m.id, threadId: m.threadId });
  }
  return refs;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Gmail's `snippet` is HTML-escaped (`&#39;`, `&amp;`). It feeds the triage preview, so it is
 * decoded here, once, at the boundary. A single pass: `&amp;amp;` becomes `&amp;`, not `&`.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,5}));/g,
    (all, dec, hex, name) => {
      if (typeof name === "string") return NAMED_ENTITIES[name.toLowerCase()] ?? all;
      const code = typeof dec === "string" ? Number(dec) : parseInt(hex as string, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : all;
    },
  );
}

function toMetadata(msg: gmail_v1.Schema$Message): MessageMetadata {
  const internalMs = Number(msg.internalDate);
  if (!msg.id || !msg.threadId || !Number.isFinite(internalMs)) throw new GmailRequestError(null);
  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: new Date(internalMs),
    labelIds: msg.labelIds ?? [],
    snippet: decodeHtmlEntities(msg.snippet ?? ""),
    headers: parseMessageHeaders(msg.payload?.headers),
  };
}

/**
 * Real Gmail messages usually deliver an `.ics` attachment as an attachmentId only. Fetch those
 * (calendar mime type or *.ics name, at most 256 KiB) and put the data into `body.data`, so the
 * synchronous parser sees them. A vanished attachment is skipped; any other failure is thrown.
 */
async function inlineCalendarAttachments(
  msg: gmail_v1.Schema$Message,
  fetchAttachment: (attachmentId: string) => Promise<gmail_v1.Schema$MessagePartBody>,
): Promise<void> {
  const pending: gmail_v1.Schema$MessagePart[] = [];
  const stack: gmail_v1.Schema$MessagePart[] = msg.payload ? [msg.payload] : [];
  let walked = 0;
  while (stack.length > 0 && walked < MAX_PARTS_WALKED) {
    const part = stack.pop() as gmail_v1.Schema$MessagePart;
    walked += 1;
    const body = part.body;
    if (isCalendarPart(part)) {
      const declared = body?.size;
      const tooBig = typeof declared === "number" && declared > MAX_ICS_BYTES;
      if (body?.attachmentId && !body.data && !tooBig) pending.push(part);
      continue;
    }
    for (const child of part.parts ?? []) stack.push(child);
  }

  for (const part of pending.slice(0, MAX_ATTACHMENT_FETCHES)) {
    const attachmentId = part.body?.attachmentId;
    if (!attachmentId || !part.body) continue;
    let fetched: gmail_v1.Schema$MessagePartBody;
    try {
      fetched = await fetchAttachment(attachmentId);
    } catch (error) {
      if (error instanceof GmailMessageNotFoundError) continue;
      throw error;
    }
    const data = fetched.data;
    // base64url: 4 characters per 3 bytes
    if (
      typeof data !== "string" ||
      data === "" ||
      data.length > Math.ceil((MAX_ICS_BYTES * 4) / 3) + 8
    ) {
      continue;
    }
    part.body.data = data;
    part.body.size = Math.floor((data.length * 3) / 4);
  }
}
