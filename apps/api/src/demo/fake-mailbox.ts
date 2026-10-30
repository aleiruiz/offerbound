import type { gmail_v1 } from "@googleapis/gmail";
import type { EmailFixture, MessageMetadata } from "@offerbound/contracts";
import type { GmailClient, GmailClientFactory } from "../gmail/client.js";
import { FakeGmailClient } from "../gmail/fake-client.js";
import { deliverFixture, weekAlignedDelta } from "./shift.js";

/** What ties a mailbox to the rest of the demo. Both are optional (unit tests use neither). */
export type MailboxHooks = {
  /**
   * When the message with this id arrived, if the database knows it (null: not stored, or still
   * the placeholder date sync leaves before triage). Lets another process rebuild a delivery.
   */
  arrivalOf?: (id: string) => Promise<Date | null>;
  /** Called with each delivered fixture the first time this process serves it. */
  onDeliver?: (fixture: EmailFixture) => void;
};

/**
 * The demo's mailbox (TECHNICAL_SPEC §12): a `FakeGmailClient` over the fixtures marked
 * `demo: true`, plus a cursor that hands out the next email for *Simulate an incoming email*.
 * It never touches the network.
 *
 * The cursor is not kept here. "Used" is whatever message ids the database already holds, so the
 * API process (which simulates) and the worker (which resets) agree without sharing memory, and
 * the hourly reset rewinds it by emptying the table. `order` is the walk: the first id in it that
 * the database does not hold is next. When every id is used the walk is over and the caller
 * (`simulateEmail`) resets the demo, which starts a fresh one; an email is never delivered twice.
 *
 * A delivered email is dated at its arrival and carries its times moved by whole weeks, so an
 * interview it proposes lies ahead of the visitor (see `deliverFixture`). It replaces the
 * original fixture in this mailbox.
 *
 * Another process can serve the same delivery. When it is asked for a message it has not
 * delivered itself (the worker re-reading a message for *Reprocess*), it looks up the arrival
 * time the database holds (`arrivalOf`) and rebuilds the delivery: the shift is a function of
 * the fixture and that time, so both processes serve the same dates. `onDeliver` lets the model
 * learn the shifted verdict and extraction of every delivery, wherever it was made.
 */
export class FakeMailbox implements GmailClient {
  private readonly originals: readonly EmailFixture[];
  private readonly byId: ReadonlyMap<string, EmailFixture>;
  private delivered = new Map<string, EmailFixture>();
  private inner: FakeGmailClient;

  constructor(
    fixtures: readonly EmailFixture[],
    readonly order: readonly string[],
    private readonly hooks: MailboxHooks = {},
  ) {
    this.originals = fixtures.filter((fixture) => fixture.demo);
    this.byId = new Map(this.originals.map((fixture) => [fixture.id, fixture]));
    for (const id of order) {
      if (!this.byId.has(id)) {
        throw new Error(`The demo order names a fixture that is not there: ${id}`);
      }
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

  /** True when every email of the walk is already stored. */
  isExhausted(used: ReadonlySet<string>): boolean {
    return this.order.every((id) => used.has(id));
  }

  /** The id the next simulated email gets, given the message ids already stored. */
  nextId(used: ReadonlySet<string>): string {
    const next = this.order.find((id) => !used.has(id));
    if (next === undefined) throw new Error("Every demo email is used; reset the demo first.");
    return next;
  }

  /**
   * Makes the next unused email arrive at `now` and returns it as it is served from now on. The
   * caller stores its id as `discovered`.
   */
  deliverNext(used: ReadonlySet<string>, now: Date): EmailFixture {
    const delivered = this.place(this.nextId(used), now);
    if (!delivered) throw new Error("The demo order names a fixture that is not there.");
    return delivered;
  }

  /** Forgets every delivery: the reset's "reset the fake mailbox cursor" for this process. */
  reset(): void {
    this.delivered = new Map();
    this.rebuild();
  }

  private place(id: string, arrivesAt: Date): EmailFixture | null {
    const base = this.byId.get(id);
    if (!base) return null;
    const delivered = deliverFixture(base, {
      arrivesAt,
      deltaMs: weekAlignedDelta(new Date(base.internalDate), arrivesAt),
      id,
    });
    this.delivered.set(id, delivered);
    this.rebuild();
    this.hooks.onDeliver?.(delivered);
    return delivered;
  }

  /** Rebuilds a delivery another process made, from the arrival time the database holds. */
  private async ensureDelivered(id: string): Promise<void> {
    if (this.delivered.has(id) || !this.hooks.arrivalOf) return;
    const arrival = await this.hooks.arrivalOf(id);
    if (arrival !== null && !this.delivered.has(id)) this.place(id, arrival);
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

  async getMetadata(id: string): Promise<MessageMetadata> {
    await this.ensureDelivered(id);
    return this.inner.getMetadata(id);
  }

  async getFull(id: string): Promise<gmail_v1.Schema$Message> {
    await this.ensureDelivered(id);
    return this.inner.getFull(id);
  }
}
