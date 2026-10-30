import type { gmail_v1 } from "@googleapis/gmail";
import type { Credentials } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import type { EmailFixture } from "@offerbound/contracts";
import { decryptToken, encryptToken } from "../auth/crypto.js";
import { loadEmailFixtures } from "../fixtures/emails.js";
import {
  createGmailClientFactory,
  GmailAuthError,
  GmailHistoryExpiredError,
  GmailMessageNotFoundError,
  GmailRetryableError,
  MAX_RETRY_AFTER_MS,
  type ConnectionIdentity,
  type GmailConnectionStore,
  type GmailOAuth,
  type GmailTransport,
  type StoredGmailConnection,
} from "./client.js";
import { FakeGmailClient, toGmailMessage } from "./fake-client.js";
import { parseFullMessage } from "./mime.js";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function fx(id: string, internalDate: string, over: Partial<EmailFixture> = {}): EmailFixture {
  return {
    id,
    threadId: `thr-${id}`,
    internalDate,
    labels: ["INBOX"],
    headers: {
      from: "Recruiter <jobs@quarry.example>",
      to: ["mateo.salgado@owner.example"],
      subject: `Subject ${id}`,
      date: "Mon, 05 Oct 2026 10:00:00 +0000",
    },
    snippet: `Snippet ${id}`,
    bodyText: `Body of ${id}`,
    demo: true,
    expected: {
      triage: "job_related",
      category: null,
      company: null,
      role: null,
      outcome: "needs_review",
    },
    llm: { triage: null, extraction: null },
    ...over,
  };
}

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:evt-1@quarry.example",
  "DTSTART:20261103T200000Z",
  "DTEND:20261103T210000Z",
  "SUMMARY:Interview with Quarry Labs",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const ids = (r: { ids: { id: string }[] }): string[] => r.ids.map((m) => m.id);

// ---------------------------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------------------------

describe("FakeGmailClient", () => {
  const fixtures = [
    fx("a", "2026-08-30T10:00:00.000Z"),
    fx("b", "2026-09-02T10:00:00.000Z"),
    fx("spam", "2026-09-03T10:00:00.000Z", { labels: ["SPAM", "UNREAD"] }),
    fx("trash", "2026-09-04T10:00:00.000Z", { labels: ["TRASH"] }),
    fx("draft", "2026-09-05T10:00:00.000Z", { labels: ["DRAFT"] }),
    fx("c", "2026-09-06T10:00:00.000Z"),
  ];

  it("fake listMessages honours 'after:YYYY/MM/DD' and excludes SPAM, TRASH and DRAFT labels", async () => {
    const fake = new FakeGmailClient(fixtures);
    const all = await fake.listMessages("", null);
    expect(ids(all).sort()).toEqual(["a", "b", "c"]);

    const q = "after:2026/09/01 -in:spam -in:trash -in:drafts";
    const recent = await fake.listMessages(q, null);
    expect(ids(recent).sort()).toEqual(["b", "c"]);
    expect(recent.ids[0]).toEqual({ id: "c", threadId: "thr-c" });
    expect(recent.nextPageToken).toBeNull();

    // after: is exclusive of the day before and inclusive of the day itself
    const sameDay = await fake.listMessages("after:2026/09/06", null);
    expect(ids(sameDay)).toEqual(["c"]);
  });

  it("fake pages results with nextPageToken when pageSize is 2", async () => {
    const many = ["m1", "m2", "m3", "m4", "m5"].map((id, i) =>
      fx(id, `2026-09-0${i + 1}T10:00:00.000Z`),
    );
    const fake = new FakeGmailClient(many, { pageSize: 2 });
    const seen: string[] = [];
    const pages: number[] = [];
    let token: string | null = null;
    do {
      const page: Awaited<ReturnType<FakeGmailClient["listMessages"]>> = await fake.listMessages(
        "",
        token,
      );
      pages.push(page.ids.length);
      seen.push(...ids(page));
      token = page.nextPageToken;
    } while (token !== null);
    expect(pages).toEqual([2, 2, 1]);
    expect(seen.sort()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("fake paging survives a message arriving between pages", async () => {
    const fake = new FakeGmailClient(
      ["m1", "m2", "m3"].map((id, i) => fx(id, `2026-09-0${i + 1}T10:00:00.000Z`)),
      { pageSize: 2 },
    );
    const first = await fake.listMessages("", null);
    fake.add(fx("late", "2026-09-10T10:00:00.000Z"));
    const second = await fake.listMessages("", first.nextPageToken);
    expect([...ids(first), ...ids(second)]).toEqual(["m3", "m2", "m1"]);
  });

  it("fake listHistory returns only messages added after the start id", async () => {
    const fake = new FakeGmailClient([fx("a", "2026-09-02T10:00:00.000Z")]);
    const profile = await fake.getProfile();
    expect(profile.emailAddress).toMatch(/\.example$/);

    const none = await fake.listHistory(profile.historyId, null);
    expect(none.added).toEqual([]);
    expect(none.historyId).toBe(profile.historyId);

    fake.add(fx("b", "2026-09-03T10:00:00.000Z"));
    const mid = (await fake.getProfile()).historyId;
    fake.add(fx("c", "2026-09-04T10:00:00.000Z"));

    const since = await fake.listHistory(profile.historyId, null);
    expect(since.added).toEqual([
      { id: "b", threadId: "thr-b" },
      { id: "c", threadId: "thr-c" },
    ]);
    expect(since.historyId).toBe((await fake.getProfile()).historyId);
    expect(since.nextPageToken).toBeNull();

    const later = await fake.listHistory(mid, null);
    expect(later.added.map((m) => m.id)).toEqual(["c"]);

    // a message added through add() is also listable
    expect(ids(await fake.listMessages("", null))).toContain("c");
  });

  it("fake listHistory pages by pageSize", async () => {
    const fake = new FakeGmailClient([], { pageSize: 2 });
    const start = (await fake.getProfile()).historyId;
    for (const id of ["a", "b", "c"]) fake.add(fx(id, "2026-09-03T10:00:00.000Z"));
    const first = await fake.listHistory(start, null);
    expect(first.added.map((m) => m.id)).toEqual(["a", "b"]);
    expect(first.nextPageToken).not.toBeNull();
    const second = await fake.listHistory(start, first.nextPageToken);
    expect(second.added.map((m) => m.id)).toEqual(["c"]);
    expect(second.nextPageToken).toBeNull();
  });

  it("fake listHistory throws GmailHistoryExpiredError when historyExpired is set", async () => {
    const fake = new FakeGmailClient([], { historyExpired: true, profileHistoryId: "900" });
    expect((await fake.getProfile()).historyId).toBe("900");
    await expect(fake.listHistory("5", null)).rejects.toBeInstanceOf(GmailHistoryExpiredError);
  });

  it("fake getMetadata and getFull describe the fixture, and an unknown id is not found", async () => {
    const f = fx("a", "2026-09-02T10:00:00.000Z", { labels: ["INBOX", "UNREAD"] });
    const fake = new FakeGmailClient([f]);
    const meta = await fake.getMetadata("a");
    expect(meta).toMatchObject({
      id: "a",
      threadId: "thr-a",
      internalDate: new Date("2026-09-02T10:00:00.000Z"),
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Snippet a",
    });
    expect(meta.headers).toMatchObject({
      fromEmail: "jobs@quarry.example",
      fromName: "Recruiter",
      subject: "Subject a",
      to: ["mateo.salgado@owner.example"],
    });
    expect((await fake.getFull("a")).id).toBe("a");
    await expect(fake.getMetadata("nope")).rejects.toBeInstanceOf(GmailMessageNotFoundError);
    await expect(fake.getFull("nope")).rejects.toBeInstanceOf(GmailMessageNotFoundError);
  });
});

describe("toGmailMessage", () => {
  it("parseFullMessage(toGmailMessage(f)) round-trips the headers, body and ics of a fixture", () => {
    const f = fx("rt", "2026-09-02T10:00:00.000Z", {
      headers: {
        from: "Ana Pérez <ana@quarry.example>",
        to: ["mateo.salgado@owner.example", "Lee Chen <lee@quarry.example>"],
        cc: ["hiring@quarry.example"],
        subject: "Entrevista con Ñandú Systems",
        date: "Mon, 05 Oct 2026 10:00:00 -0600",
        listId: "<jobs.quarry.example>",
      },
      bodyText: "Hola, ¿hablamos mañana?\n\nSaludos",
      bodyHtml: "<p>Hola, <b>¿hablamos mañana?</b></p>",
      ics: ICS,
    });
    const parsed = parseFullMessage(toGmailMessage(f));
    expect(parsed.headers).toEqual({
      from: "Ana Pérez <ana@quarry.example>",
      fromName: "Ana Pérez",
      fromEmail: "ana@quarry.example",
      to: ["mateo.salgado@owner.example", "lee@quarry.example"],
      cc: ["hiring@quarry.example"],
      subject: "Entrevista con Ñandú Systems",
      date: "Mon, 05 Oct 2026 10:00:00 -0600",
      listId: "<jobs.quarry.example>",
    });
    expect(parsed.textBody).toBe("Hola, ¿hablamos mañana?\n\nSaludos");
    expect(parsed.icsEvents).toHaveLength(1);
    expect(parsed.icsEvents[0]).toMatchObject({
      uid: "evt-1@quarry.example",
      method: "REQUEST",
      start: "2026-11-03T20:00:00.000Z",
    });
  });

  it("builds an html-only body and an invite with no text part", () => {
    const html = parseFullMessage(
      toGmailMessage(
        fx("h", "2026-09-02T10:00:00.000Z", {
          bodyText: undefined,
          bodyHtml: '<p>Apply <a href="https://quarry.example/jobs/42">now</a></p>',
        }),
      ),
    );
    expect(html.textBody).toContain("Apply now [https://quarry.example/jobs/42]");

    const invite = parseFullMessage(
      toGmailMessage(fx("i", "2026-09-02T10:00:00.000Z", { bodyText: undefined, ics: ICS })),
    );
    expect(invite.textBody).toBe("");
    expect(invite.icsEvents).toHaveLength(1);
  });

  it("round-trips every shipped email fixture", () => {
    const all = loadEmailFixtures();
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) {
      const message = toGmailMessage(f);
      expect(message.id).toBe(f.id);
      expect(message.threadId).toBe(f.threadId);
      expect(message.labelIds).toEqual(f.labels);
      expect(message.internalDate).toBe(String(new Date(f.internalDate).getTime()));
      const parsed = parseFullMessage(message);
      expect(parsed.headers.subject).toBe(f.headers.subject);
      expect(parsed.headers.to.length).toBe(f.headers.to.length);
      if (f.bodyText !== undefined) expect(parsed.textBody).toBe(f.bodyText);
      else if (f.bodyHtml !== undefined) expect(parsed.textBody.trim()).not.toBe("");
      else expect(parsed.textBody).toBe("");
      expect(parsed.icsEvents.length > 0).toBe(f.ics !== undefined);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The real client, with Google replaced by stubs
// ---------------------------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 9);
const NOW = new Date("2026-10-01T12:00:00.000Z");
const REFRESH = "refresh-token-secret-value";
const ACCESS = "access-token-secret-value";

class MemoryStore implements GmailConnectionStore {
  saves: { accessTokenEnc: string; accessTokenExpiresAt: Date; refreshTokenEnc?: string }[] = [];
  marks: { status: string; error: string }[] = [];
  /** The row each write said it expected (the one the client loaded). */
  expected: ConnectionIdentity[] = [];
  constructor(public row: StoredGmailConnection | null) {}
  load(): Promise<StoredGmailConnection | null> {
    return Promise.resolve(this.row);
  }
  saveAccessToken(
    expected: ConnectionIdentity,
    t: { accessTokenEnc: string; accessTokenExpiresAt: Date; refreshTokenEnc?: string },
  ): Promise<boolean> {
    this.expected.push(expected);
    this.saves.push(t);
    return Promise.resolve(true);
  }
  markUnusable(
    expected: ConnectionIdentity,
    status: "needs_reauth" | "missing_scope",
    error: string,
  ): Promise<boolean> {
    this.expected.push(expected);
    this.marks.push({ status, error });
    return Promise.resolve(true);
  }
}

function connection(over: Partial<StoredGmailConnection> = {}): StoredGmailConnection {
  return {
    status: "active",
    googleSub: "google-sub-owner",
    refreshTokenEnc: encryptToken(REFRESH, KEY),
    accessTokenEnc: null,
    accessTokenExpiresAt: null,
    ...over,
  };
}

function stubOAuth(
  refresh: () => Promise<{ credentials: Credentials }> = () =>
    Promise.resolve({
      credentials: {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expiry_date: NOW.getTime() + 3_600_000,
      },
    }),
): GmailOAuth & { refresh: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  const refreshFn = vi.fn(refresh);
  const setFn = vi.fn();
  return { refreshAccessToken: refreshFn, setCredentials: setFn, refresh: refreshFn, set: setFn };
}

function stubTransport(over: Partial<GmailTransport> = {}): GmailTransport {
  const unexpected = (): never => {
    throw new Error("unexpected call");
  };
  return {
    getProfile: unexpected,
    listMessages: unexpected,
    listHistory: unexpected,
    getMessage: unexpected,
    getAttachment: unexpected,
    ...over,
  };
}

function httpError(
  status: number,
  data: unknown = {},
  headers: Record<string, string> = {},
): Error {
  return Object.assign(new Error("Request failed"), {
    response: { status, data, headers },
    code: status,
  });
}

function factoryFor(
  store: MemoryStore,
  oauth: GmailOAuth,
  transport: GmailTransport,
  extra: { google?: boolean } = {},
) {
  return createGmailClientFactory({
    store,
    env: {
      google: extra.google === false ? null : { clientId: "client.example", clientSecret: "s" },
      tokenEncryptionKey: KEY,
    },
    clock: () => NOW,
    minRequestIntervalMs: 0,
    createSession: () => ({ oauth, transport }),
  });
}

describe("the real Gmail client", () => {
  it("the real client maps invalid_grant to GmailAuthError", async () => {
    const store = new MemoryStore(connection());
    const oauth = stubOAuth(() =>
      Promise.reject(httpError(400, { error: "invalid_grant", error_description: "Bad Request" })),
    );
    const factory = factoryFor(store, oauth, stubTransport());
    const error = await factory().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailAuthError);
    // the connection is marked per TECHNICAL_SPEC §5.2 step 4 and §13
    expect(store.marks).toHaveLength(1);
    expect(store.marks[0]?.status).toBe("needs_reauth");
    expect(store.marks[0]?.error).toMatch(/^invalid_grant/);
    expect(store.saves).toEqual([]);
  });

  it("does not call Google when the connection is not active or has no refresh token", async () => {
    for (const row of [
      null,
      connection({ status: "needs_reauth" }),
      connection({ status: "disconnected" }),
      connection({ status: "missing_scope" }),
      connection({ refreshTokenEnc: null }),
    ]) {
      const oauth = stubOAuth();
      const factory = factoryFor(new MemoryStore(row), oauth, stubTransport());
      await expect(factory()).rejects.toBeInstanceOf(GmailAuthError);
      expect(oauth.refresh).not.toHaveBeenCalled();
    }
  });

  it("treats an unreadable stored token as a lost authorization", async () => {
    const store = new MemoryStore(connection({ refreshTokenEnc: "v1:garbage" }));
    const factory = factoryFor(store, stubOAuth(), stubTransport());
    await expect(factory()).rejects.toBeInstanceOf(GmailAuthError);
    expect(store.marks[0]?.status).toBe("needs_reauth");
  });

  it("throws a plain error when Google or the encryption key is not configured", async () => {
    const factory = factoryFor(new MemoryStore(connection()), stubOAuth(), stubTransport(), {
      google: false,
    });
    const error = await factory().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GmailAuthError);
  });

  it("a refreshed access token is stored encrypted with its expiry", async () => {
    const store = new MemoryStore(connection());
    const oauth = stubOAuth();
    const factory = factoryFor(
      store,
      oauth,
      stubTransport({
        getProfile: () => Promise.resolve({ emailAddress: "me@owner.example", historyId: "77" }),
      }),
    );
    const client = await factory();
    expect(oauth.set).toHaveBeenCalledWith({ refresh_token: REFRESH });
    expect(store.saves).toHaveLength(1);
    const saved = store.saves[0];
    expect(saved?.accessTokenEnc).not.toContain(ACCESS);
    expect(saved?.accessTokenEnc.startsWith("v1:")).toBe(true);
    expect(decryptToken(saved?.accessTokenEnc ?? "", KEY)).toBe(ACCESS);
    expect(saved?.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 3_600_000));
    // an unrotated refresh token is not rewritten
    expect(saved?.refreshTokenEnc).toBeUndefined();
    expect(await client.getProfile()).toEqual({
      emailAddress: "me@owner.example",
      historyId: "77",
    });
  });

  it("persists a rotated refresh token, encrypted", async () => {
    const store = new MemoryStore(connection());
    const oauth = stubOAuth(() =>
      Promise.resolve({
        credentials: {
          access_token: ACCESS,
          refresh_token: "rotated-refresh-value",
          expiry_date: NOW.getTime() + 3_600_000,
        },
      }),
    );
    await factoryFor(store, oauth, stubTransport())();
    const enc = store.saves[0]?.refreshTokenEnc ?? "";
    expect(enc).not.toContain("rotated-refresh-value");
    expect(decryptToken(enc, KEY)).toBe("rotated-refresh-value");
  });

  it("reuses a stored access token that is not about to expire", async () => {
    const expires = new Date(NOW.getTime() + 10 * 60_000);
    const store = new MemoryStore(
      connection({
        accessTokenEnc: encryptToken("stored-access", KEY),
        accessTokenExpiresAt: expires,
      }),
    );
    const oauth = stubOAuth();
    await factoryFor(store, oauth, stubTransport())();
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(oauth.set).toHaveBeenCalledWith({
      access_token: "stored-access",
      expiry_date: expires.getTime(),
    });
  });

  it("refreshes a stored access token that expires within a minute", async () => {
    const store = new MemoryStore(
      connection({
        accessTokenEnc: encryptToken("stale-access", KEY),
        accessTokenExpiresAt: new Date(NOW.getTime() + 30_000),
      }),
    );
    const oauth = stubOAuth();
    await factoryFor(store, oauth, stubTransport())();
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
  });

  it("the real client maps a 404 on history.list to GmailHistoryExpiredError and 429 or 503 to GmailRetryableError", async () => {
    const failing = (error: Error): GmailTransport =>
      stubTransport({
        listHistory: () => Promise.reject(error),
        listMessages: () => Promise.reject(error),
        getMessage: () => Promise.reject(error),
      });
    const client = async (error: Error) =>
      factoryFor(new MemoryStore(connection()), stubOAuth(), failing(error))();

    await expect((await client(httpError(404))).listHistory("1", null)).rejects.toBeInstanceOf(
      GmailHistoryExpiredError,
    );
    // a 404 anywhere else is not "history expired"
    const missing = await (await client(httpError(404))).getMetadata("x").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(GmailMessageNotFoundError);
    expect(missing).not.toBeInstanceOf(GmailHistoryExpiredError);

    for (const status of [429, 500, 502, 503]) {
      const c = await client(httpError(status));
      await expect(c.listHistory("1", null)).rejects.toBeInstanceOf(GmailRetryableError);
      await expect(c.listMessages("q", null)).rejects.toBeInstanceOf(GmailRetryableError);
    }
    // quota errors reported as 403 and network failures are retryable too
    const quota = await client(
      httpError(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }),
    );
    await expect(quota.listMessages("q", null)).rejects.toBeInstanceOf(GmailRetryableError);
    const network = await client(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    await expect(network.listMessages("q", null)).rejects.toBeInstanceOf(GmailRetryableError);
  });

  it("clamps an absurd Retry-After to one hour", async () => {
    const c = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({
        listMessages: () => Promise.reject(httpError(429, {}, { "retry-after": "999999" })),
      }),
    )();
    const error = await c.listMessages("q", null).catch((e: unknown) => e);
    expect((error as GmailRetryableError).retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
    expect(MAX_RETRY_AFTER_MS).toBe(3_600_000);
  });

  it("writes only to the row it loaded, and follows a rotated refresh token", async () => {
    const row = connection();
    const store = new MemoryStore(row);
    const oauth = stubOAuth(() =>
      Promise.resolve({
        credentials: {
          access_token: ACCESS,
          refresh_token: "rotated-refresh-value",
          expiry_date: NOW.getTime() + 3_600_000,
        },
      }),
    );
    const c = await factoryFor(
      store,
      oauth,
      stubTransport({
        getProfile: () =>
          Promise.reject(
            httpError(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
          ),
      }),
    )();
    await c.getProfile().catch(() => undefined);
    // first write: the refresh, against the loaded row
    expect(store.expected[0]).toEqual({
      googleSub: "google-sub-owner",
      refreshTokenEnc: row.refreshTokenEnc,
    });
    // second write: after the rotation it expects the rotated token, not the loaded one
    const rotatedEnc = store.saves[0]?.refreshTokenEnc ?? "";
    expect(rotatedEnc).not.toBe("");
    expect(store.marks).toHaveLength(1);
    expect(store.expected[1]).toEqual({
      googleSub: "google-sub-owner",
      refreshTokenEnc: rotatedEnc,
    });
  });

  it("decodes HTML entities in the snippet", async () => {
    const getMessage = vi.fn<GmailTransport["getMessage"]>(() =>
      Promise.resolve({
        id: "m1",
        threadId: "t1",
        internalDate: String(new Date("2026-09-02T10:00:00.000Z").getTime()),
        snippet:
          "We&#39;d like to chat &amp; share the &quot;role&quot; &lt;soon&gt; &#x1F600; &amp;amp; a&nbsp;b",
        payload: { headers: [{ name: "From", value: "Ana <ana@quarry.example>" }] },
      } satisfies gmail_v1.Schema$Message),
    );
    const c = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({ getMessage }),
    )();
    expect((await c.getMetadata("m1")).snippet).toBe(
      'We\'d like to chat & share the "role" <soon> \u{1F600} &amp; a b',
    );
  });

  it("passes Retry-After on a retryable error", async () => {
    const c = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({
        listMessages: () => Promise.reject(httpError(429, {}, { "retry-after": "30" })),
      }),
    )();
    const error = await c.listMessages("q", null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailRetryableError);
    expect((error as GmailRetryableError).retryAfterMs).toBe(30_000);
  });

  it("marks missing_scope on a 403 for insufficient permissions", async () => {
    const store = new MemoryStore(connection());
    const c = await factoryFor(
      store,
      stubOAuth(),
      stubTransport({
        getProfile: () =>
          Promise.reject(
            httpError(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
          ),
      }),
    )();
    await expect(c.getProfile()).rejects.toBeInstanceOf(GmailAuthError);
    expect(store.marks).toEqual([
      { status: "missing_scope", error: expect.stringMatching(/^missing_scope/) as string },
    ]);
  });

  it("refreshes once and retries when Gmail answers 401", async () => {
    let calls = 0;
    const store = new MemoryStore(connection());
    const oauth = stubOAuth();
    const c = await factoryFor(
      store,
      oauth,
      stubTransport({
        getProfile: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(httpError(401))
            : Promise.resolve({ emailAddress: "me@owner.example", historyId: "5" });
        },
      }),
    )();
    expect((await c.getProfile()).historyId).toBe("5");
    expect(oauth.refresh).toHaveBeenCalledTimes(2); // once at creation, once after the 401
    expect(store.saves).toHaveLength(2);
  });

  it("errors carry no tokens, headers or request data", async () => {
    const leaky = Object.assign(new Error(`Bearer ${ACCESS} for ana@quarry.example`), {
      response: { status: 503, data: { detail: "ana@quarry.example" }, headers: {} },
      config: { headers: { Authorization: `Bearer ${ACCESS}` } },
    });
    const c = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({ getMessage: () => Promise.reject(leaky) }),
    )();
    const error = (await c.getMetadata("x").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(GmailRetryableError);
    const dump = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(dump).not.toContain(ACCESS);
    expect(dump).not.toContain("ana@quarry.example");
    expect(error.cause).toBeUndefined();

    const refreshFailure = Object.assign(new Error(`refresh ${REFRESH}`), {
      response: { status: 400, data: { error: "invalid_grant" } },
    });
    const store = new MemoryStore(connection());
    const failure = (await factoryFor(
      store,
      stubOAuth(() => Promise.reject(refreshFailure)),
      stubTransport(),
    )().catch((e: unknown) => e)) as Error;
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(REFRESH);
    expect(JSON.stringify(store.marks)).not.toContain(REFRESH);
  });

  it("getMetadata requests the six headers and maps the response", async () => {
    const getMessage = vi.fn<GmailTransport["getMessage"]>(() =>
      Promise.resolve({
        id: "m1",
        threadId: "t1",
        internalDate: String(new Date("2026-09-02T10:00:00.000Z").getTime()),
        labelIds: ["INBOX", "UNREAD"],
        snippet: "Hello",
        payload: {
          headers: [
            { name: "From", value: "Ana <ana@quarry.example>" },
            { name: "To", value: "me@owner.example" },
            { name: "Subject", value: "Hi" },
          ],
        },
      } satisfies gmail_v1.Schema$Message),
    );
    const c = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({ getMessage }),
    )();
    const meta = await c.getMetadata("m1");
    expect(getMessage).toHaveBeenCalledWith({
      id: "m1",
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "List-Id"],
    });
    expect(meta).toMatchObject({
      id: "m1",
      threadId: "t1",
      internalDate: new Date("2026-09-02T10:00:00.000Z"),
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hello",
    });
    expect(meta.headers.fromEmail).toBe("ana@quarry.example");
  });

  it("lists messages and history with 500 per page and maps the responses", async () => {
    const listMessages = vi.fn<GmailTransport["listMessages"]>(() =>
      Promise.resolve({ messages: [{ id: "a", threadId: "ta" }], nextPageToken: "tok" }),
    );
    const listHistory = vi.fn<GmailTransport["listHistory"]>(() =>
      Promise.resolve({
        historyId: "99",
        history: [
          { messagesAdded: [{ message: { id: "x", threadId: "tx" } }] },
          { messagesDeleted: [{ message: { id: "gone", threadId: "tg" } }] },
          {
            messagesAdded: [
              { message: { id: "y", threadId: "ty" } },
              { message: { id: "x", threadId: "tx" } },
            ],
          },
        ],
      }),
    );
    const c = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({ listMessages, listHistory }),
    )();
    expect(await c.listMessages("after:2026/08/31", "p1")).toEqual({
      ids: [{ id: "a", threadId: "ta" }],
      nextPageToken: "tok",
    });
    expect(listMessages).toHaveBeenCalledWith({
      q: "after:2026/08/31",
      pageToken: "p1",
      maxResults: 500,
    });
    expect(await c.listHistory("50", null)).toEqual({
      added: [
        { id: "x", threadId: "tx" },
        { id: "y", threadId: "ty" },
      ],
      historyId: "99",
      nextPageToken: null,
    });
    expect(listHistory).toHaveBeenCalledWith({ startHistoryId: "50", maxResults: 500 });
    // an empty listing has no messages key
    const empty = await factoryFor(
      new MemoryStore(connection()),
      stubOAuth(),
      stubTransport({
        listMessages: () => Promise.resolve({}),
        listHistory: () => Promise.resolve({ historyId: "51" }),
      }),
    )();
    expect(await empty.listMessages("q", null)).toEqual({ ids: [], nextPageToken: null });
    expect(await empty.listHistory("50", null)).toEqual({
      added: [],
      historyId: "51",
      nextPageToken: null,
    });
  });

  describe("getFull and .ics attachments", () => {
    const withAttachment = (
      over: Partial<gmail_v1.Schema$MessagePart> = {},
    ): gmail_v1.Schema$Message => ({
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "Invite" }],
        parts: [
          { mimeType: "text/plain", body: { size: 2, data: b64("hi") } },
          {
            mimeType: "application/ics",
            filename: "invite.ics",
            body: { size: ICS.length, attachmentId: "att-1" },
            ...over,
          },
        ],
      },
    });

    it("inlines a calendar attachment that only has an attachmentId before parsing", async () => {
      const getAttachment = vi.fn<GmailTransport["getAttachment"]>(() =>
        Promise.resolve({ size: ICS.length, data: b64(ICS) }),
      );
      const c = await factoryFor(
        new MemoryStore(connection()),
        stubOAuth(),
        stubTransport({ getMessage: () => Promise.resolve(withAttachment()), getAttachment }),
      )();
      const full = await c.getFull("m1");
      expect(getAttachment).toHaveBeenCalledWith({ messageId: "m1", attachmentId: "att-1" });
      const parsed = parseFullMessage(full);
      expect(parsed.icsEvents).toHaveLength(1);
      expect(parsed.icsEvents[0]?.uid).toBe("evt-1@quarry.example");
      expect(parsed.textBody).toBe("hi");
    });

    it("recognises a text/calendar attachment by mime type without a filename", async () => {
      const getAttachment = vi.fn<GmailTransport["getAttachment"]>(() =>
        Promise.resolve({ data: b64(ICS) }),
      );
      const c = await factoryFor(
        new MemoryStore(connection()),
        stubOAuth(),
        stubTransport({
          getMessage: () =>
            Promise.resolve(withAttachment({ mimeType: "text/calendar", filename: "" })),
          getAttachment,
        }),
      )();
      expect(parseFullMessage(await c.getFull("m1")).icsEvents).toHaveLength(1);
    });

    it("does not fetch other attachments or calendar attachments over 256 KiB", async () => {
      const getAttachment = vi.fn<GmailTransport["getAttachment"]>(() =>
        Promise.resolve({ data: b64(ICS) }),
      );
      const make = (part: Partial<gmail_v1.Schema$MessagePart>) =>
        factoryFor(
          new MemoryStore(connection()),
          stubOAuth(),
          stubTransport({ getMessage: () => Promise.resolve(withAttachment(part)), getAttachment }),
        )().then((c) => c.getFull("m1"));
      await make({ mimeType: "application/pdf", filename: "cv.pdf" });
      await make({ body: { size: 256 * 1024 + 1, attachmentId: "big" } });
      expect(getAttachment).not.toHaveBeenCalled();

      // size unknown up front: the fetched data is checked instead and dropped when too large
      const huge = "x".repeat(256 * 1024 + 10);
      const oversized = await factoryFor(
        new MemoryStore(connection()),
        stubOAuth(),
        stubTransport({
          getMessage: () => Promise.resolve(withAttachment({ body: { attachmentId: "att-1" } })),
          getAttachment: () => Promise.resolve({ data: b64(huge) }),
        }),
      )().then((c) => c.getFull("m1"));
      expect(parseFullMessage(oversized).icsEvents).toEqual([]);
    });

    it("leaves a part that already has data alone and skips an attachment that has gone", async () => {
      const getAttachment = vi.fn<GmailTransport["getAttachment"]>(() =>
        Promise.reject(httpError(404)),
      );
      const inline = await factoryFor(
        new MemoryStore(connection()),
        stubOAuth(),
        stubTransport({
          getMessage: () =>
            Promise.resolve(
              withAttachment({ body: { size: ICS.length, data: b64(ICS), attachmentId: "x" } }),
            ),
          getAttachment,
        }),
      )().then((c) => c.getFull("m1"));
      expect(getAttachment).not.toHaveBeenCalled();
      expect(parseFullMessage(inline).icsEvents).toHaveLength(1);

      const gone = await factoryFor(
        new MemoryStore(connection()),
        stubOAuth(),
        stubTransport({ getMessage: () => Promise.resolve(withAttachment()), getAttachment }),
      )().then((c) => c.getFull("m1"));
      expect(parseFullMessage(gone).icsEvents).toEqual([]);
    });

    it("propagates a retryable failure while fetching the attachment", async () => {
      const c = await factoryFor(
        new MemoryStore(connection()),
        stubOAuth(),
        stubTransport({
          getMessage: () => Promise.resolve(withAttachment()),
          getAttachment: () => Promise.reject(httpError(503)),
        }),
      )();
      await expect(c.getFull("m1")).rejects.toBeInstanceOf(GmailRetryableError);
    });
  });

  it("spaces requests by the minimum interval", async () => {
    const stamps: number[] = [];
    const factory = createGmailClientFactory({
      store: new MemoryStore(connection()),
      env: { google: { clientId: "c", clientSecret: "s" }, tokenEncryptionKey: KEY },
      clock: () => NOW,
      minRequestIntervalMs: 40,
      createSession: () => ({
        oauth: stubOAuth(),
        transport: stubTransport({
          listMessages: () => {
            stamps.push(Date.now());
            return Promise.resolve({});
          },
        }),
      }),
    });
    const c = await factory();
    await Promise.all([
      c.listMessages("a", null),
      c.listMessages("b", null),
      c.listMessages("c", null),
    ]);
    expect(stamps).toHaveLength(3);
    expect((stamps[2] ?? 0) - (stamps[0] ?? 0)).toBeGreaterThanOrEqual(70);
  });
});
