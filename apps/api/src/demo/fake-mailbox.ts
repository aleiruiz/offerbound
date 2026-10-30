import type { gmail_v1 } from "@googleapis/gmail";
import type { EmailFixture, MessageMetadata } from "@offerbound/contracts";
import type { GmailClient, GmailClientFactory } from "../gmail/client.js";
import { FakeGmailClient } from "../gmail/fake-client.js";
import { deliverFixture, weekAlignedDelta } from "./shift.js";

/**
 * The demo's mailbox (TECHNICAL_SPEC §12): a `FakeGmailClient` over the fixtures marked
 * `demo: true`, plus a cursor that hands out the next email for *Simulate an incoming email*.
 * It never touches the network.
 *
 * The cursor is not kept here. "Used" is whatever message ids the database already holds, so the
 * API process (which simulates) and the worker (which resets) agree without sharing memory, and
 * the hourly reset rewinds it by emptying the table. `order` is the walk: the first id in it that
 * the database does not hold is next. When every id is used the walk starts again with ids
 * suffixed `~2`, `~3`, ... so a visitor never runs dry (the message is the same email again,
 * dated now).
 *
 * A delivered email is dated at its arrival and carries its times moved by whole weeks, so an
 * interview it proposes lies ahead of the visitor (see `deliverFixture`). It replaces the
 * original fixture in this mailbox, in this process only; a process that never simulated serves
 * the originals, which is all its triage and extraction sweeps need.
 */
export class FakeMailbox implements GmailClient {
  private readonly originals: readonly EmailFixture[];
  private readonly byId: ReadonlyMap<string, EmailFixture>;
  private delivered = new Map<string, EmailFixture>();
  private inner: FakeGmailClient;

  constructor(
    fixtures: readonly EmailFixture[],
    readonly order: readonly string[],
  ) {
    this.originals = fixtures.filter((fixture) => fixture.demo);
    this.byId = new Map(this.originals.map((fixture) => [fixture.id, fixture]));
    for (const id of order) {
      if (!this.byId.has(id))
        throw new Error(`The demo order names a fixture that is not there: ${id}`);
    }
    this.inner = new FakeGmailClient([...this.originals]);
  }

  /** For `AppDeps.gmail`. */
  factory(): GmailClientFactory {
    return () => Promise.resolve(this);
  }

  /** The fixtures this mailbox serves before any delivery, in the order given. */
  fixtures(): readonly EmailFixture[] {
    return this.originals;
  }

  /** The id the next simulated email gets, given the message ids already stored. */
  nextId(used: ReadonlySet<string>): string {
    if (this.order.length === 0) throw new Error("The demo has no emails to simulate.");
    for (let lap = 1; ; lap += 1) {
      for (const id of this.order) {
        const candidate = lap === 1 ? id : `${id}~${lap}`;
        if (!used.has(candidate)) return candidate;
      }
    }
  }

  /**
   * Makes the next unused email arrive at `now` and returns it as it is served from now on. The
   * caller stores its id as `discovered` and registers its verdict and extraction with the model.
   */
  deliverNext(used: ReadonlySet<string>, now: Date): EmailFixture {
    const id = this.nextId(used);
    const baseId = id.replace(/~\d+$/, "");
    const base = this.byId.get(baseId);
    if (!base) throw new Error("The demo order names a fixture that is not there.");
    const delivered = deliverFixture(base, {
      arrivesAt: now,
      deltaMs: weekAlignedDelta(new Date(base.internalDate), now),
      id,
    });
    this.delivered.set(id, delivered);
    this.rebuild();
    return delivered;
  }

  /** Forgets every delivery: the reset's "reset the fake mailbox cursor" for this process. */
  reset(): void {
    this.delivered = new Map();
    this.rebuild();
  }

  private rebuild(): void {
    const kept = this.originals.filter((fixture) => !this.delivered.has(fixture.id));
    this.inner = new FakeGmailClient([...kept, ...this.delivered.values()]);
  }

  getProfile(): Promise<{ historyId: string; emailAddress: string }> {
    return this.inner.getProfile();
  }

  listMessages(
    q: string,
    pageToken: string | null,
  ): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken: string | null }> {
    return this.inner.listMessages(q, pageToken);
  }

  listHistory(
    startHistoryId: string,
    pageToken: string | null,
  ): Promise<{
    added: { id: string; threadId: string }[];
    historyId: string;
    nextPageToken: string | null;
  }> {
    return this.inner.listHistory(startHistoryId, pageToken);
  }

  getMetadata(id: string): Promise<MessageMetadata> {
    return this.inner.getMetadata(id);
  }

  getFull(id: string): Promise<gmail_v1.Schema$Message> {
    return this.inner.getFull(id);
  }
}
