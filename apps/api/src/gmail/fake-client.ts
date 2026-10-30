import type { gmail_v1 } from "@googleapis/gmail";
import type { EmailFixture, MessageMetadata } from "@offerbound/contracts";
import { FIXTURE_OWNER_EMAIL } from "../fixtures/emails.js";
import {
  GmailHistoryExpiredError,
  GmailMessageNotFoundError,
  type GmailClient,
  type GmailClientFactory,
} from "./client.js";
import { parseMessageHeaders } from "./mime.js";

type Part = gmail_v1.Schema$MessagePart;

const textPart = (mimeType: string, text: string): Part => ({
  mimeType,
  headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }],
  body: {
    size: Buffer.byteLength(text, "utf8"),
    data: Buffer.from(text, "utf8").toString("base64url"),
  },
});

/**
 * Builds the `format=full` message Gmail would return for a fixture: headers, a text/plain and/or
 * text/html body (multipart/alternative when both), and the `.ics` text as a text/calendar part
 * with its data inline (what the real client produces after inlining attachments). A fixture
 * without a body yields an empty text/plain part. Pure.
 */
export function toGmailMessage(f: EmailFixture): gmail_v1.Schema$Message {
  const headers: gmail_v1.Schema$MessagePartHeader[] = [
    { name: "From", value: f.headers.from },
    { name: "To", value: f.headers.to.join(", ") },
  ];
  if (f.headers.cc && f.headers.cc.length > 0) {
    headers.push({ name: "Cc", value: f.headers.cc.join(", ") });
  }
  headers.push(
    { name: "Subject", value: f.headers.subject },
    { name: "Date", value: f.headers.date },
  );
  if (f.headers.listId !== undefined) headers.push({ name: "List-Id", value: f.headers.listId });

  const bodies: Part[] = [];
  if (f.bodyText !== undefined) bodies.push(textPart("text/plain", f.bodyText));
  if (f.bodyHtml !== undefined) bodies.push(textPart("text/html", f.bodyHtml));
  const bodyPart: Part | null =
    bodies.length > 1 ? { mimeType: "multipart/alternative", parts: bodies } : (bodies[0] ?? null);

  const children: Part[] = [];
  if (bodyPart) children.push(bodyPart);
  if (f.ics !== undefined) children.push(textPart("text/calendar", f.ics));

  let payload: Part;
  if (children.length === 0) {
    payload = { ...textPart("text/plain", ""), headers: [] };
  } else if (children.length === 1) {
    payload = children[0] as Part;
  } else {
    payload = { mimeType: "multipart/mixed", parts: children };
  }
  payload = { ...payload, headers: [...headers, ...(payload.headers ?? [])] };

  return {
    id: f.id,
    threadId: f.threadId,
    labelIds: [...f.labels],
    snippet: f.snippet,
    internalDate: String(new Date(f.internalDate).getTime()),
    sizeEstimate: JSON.stringify(payload).length,
    payload,
  };
}

/** Labels Gmail leaves out of `messages.list` unless asked (the backfill query also says so). */
const HIDDEN_LABELS = new Set(["SPAM", "TRASH", "DRAFT"]);

type Stored = { fixture: EmailFixture; historyId: number; internalMs: number };

/** Newest first, ties by id, like `messages.list`. */
function compareNewestFirst(a: Stored, b: Stored): number {
  return (
    b.internalMs - a.internalMs ||
    (a.fixture.id < b.fixture.id ? 1 : a.fixture.id > b.fixture.id ? -1 : 0)
  );
}

/** `after:YYYY/MM/DD` (or with dashes) as the start of that day in UTC; the only operator read. */
function parseAfter(q: string): number | null {
  const match = /(?:^|\s)after:(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?=\s|$)/.exec(q);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

/**
 * An in-memory mailbox driven by fixtures, for tests and demo mode. It never touches the network.
 * `listMessages` understands `after:YYYY/MM/DD` (UTC midnight; real Gmail uses the account's day,
 * so the fake returns a superset) and always leaves out SPAM, TRASH and DRAFT, newest first;
 * every other search term is ignored.
 */
export class FakeGmailClient implements GmailClient {
  private readonly messages: Stored[] = [];
  private currentHistoryId: number;
  private readonly pageSize: number;
  private readonly historyExpired: boolean;

  constructor(
    fixtures: EmailFixture[],
    opts: { pageSize?: number; historyExpired?: boolean; profileHistoryId?: string } = {},
  ) {
    this.pageSize = opts.pageSize ?? 100;
    this.historyExpired = opts.historyExpired ?? false;
    fixtures.forEach((fixture, index) => {
      this.messages.push({
        fixture,
        historyId: index + 1,
        internalMs: new Date(fixture.internalDate).getTime(),
      });
    });
    this.currentHistoryId =
      opts.profileHistoryId !== undefined ? Number(opts.profileHistoryId) : fixtures.length;
  }

  /** Simulates a new message arriving: the history id grows and `listHistory` reports it. */
  add(fixture: EmailFixture): void {
    this.currentHistoryId += 1;
    this.messages.push({
      fixture,
      historyId: this.currentHistoryId,
      internalMs: new Date(fixture.internalDate).getTime(),
    });
  }

  getProfile(): Promise<{ historyId: string; emailAddress: string }> {
    return Promise.resolve({
      historyId: String(this.currentHistoryId),
      emailAddress: FIXTURE_OWNER_EMAIL,
    });
  }

  listMessages(
    q: string,
    pageToken: string | null,
  ): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken: string | null }> {
    const after = parseAfter(q);
    const visible = this.messages
      .filter(
        (m) =>
          !m.fixture.labels.some((label) => HIDDEN_LABELS.has(label)) &&
          (after === null || m.internalMs >= after),
      )
      .sort(compareNewestFirst);

    let start = 0;
    if (pageToken !== null) {
      const match = /^(\d+):(.*)$/.exec(pageToken);
      if (!match) return Promise.reject(new Error("Invalid page token."));
      const cursorMs = Number(match[1]);
      const cursorId = match[2] as string;
      // Keyset paging: stable when messages arrive between pages.
      start = visible.findIndex(
        (m) => m.internalMs < cursorMs || (m.internalMs === cursorMs && m.fixture.id < cursorId),
      );
      if (start === -1) start = visible.length;
    }
    const page = visible.slice(start, start + this.pageSize);
    const last = page[page.length - 1];
    const more = start + page.length < visible.length;
    return Promise.resolve({
      ids: page.map((m) => ({ id: m.fixture.id, threadId: m.fixture.threadId })),
      nextPageToken: more && last ? `${last.internalMs}:${last.fixture.id}` : null,
    });
  }

  listHistory(
    startHistoryId: string,
    pageToken: string | null,
  ): Promise<{
    added: { id: string; threadId: string }[];
    historyId: string;
    nextPageToken: string | null;
  }> {
    if (this.historyExpired) return Promise.reject(new GmailHistoryExpiredError());
    const added = this.messages
      .filter((m) => m.historyId > Number(startHistoryId))
      .sort((a, b) => a.historyId - b.historyId);
    let offset = 0;
    if (pageToken !== null) {
      if (!/^\d+$/.test(pageToken)) return Promise.reject(new Error("Invalid page token."));
      offset = Number(pageToken);
    }
    const page = added.slice(offset, offset + this.pageSize);
    const next = offset + page.length;
    return Promise.resolve({
      added: page.map((m) => ({ id: m.fixture.id, threadId: m.fixture.threadId })),
      historyId: String(this.currentHistoryId),
      nextPageToken: next < added.length ? String(next) : null,
    });
  }

  getMetadata(id: string): Promise<MessageMetadata> {
    const found = this.find(id);
    if (!found) return Promise.reject(new GmailMessageNotFoundError());
    const message = toGmailMessage(found.fixture);
    return Promise.resolve({
      id: found.fixture.id,
      threadId: found.fixture.threadId,
      internalDate: new Date(found.internalMs),
      labelIds: [...found.fixture.labels],
      snippet: found.fixture.snippet,
      headers: parseMessageHeaders(message.payload?.headers),
    });
  }

  getFull(id: string): Promise<gmail_v1.Schema$Message> {
    const found = this.find(id);
    if (!found) return Promise.reject(new GmailMessageNotFoundError());
    return Promise.resolve(toGmailMessage(found.fixture));
  }

  private find(id: string): Stored | undefined {
    return this.messages.find((m) => m.fixture.id === id);
  }
}

/** A factory that always hands out the same fake, for `AppDeps.gmail` in tests and demo mode. */
export function fakeGmailFactory(client: GmailClient): GmailClientFactory {
  return () => Promise.resolve(client);
}
