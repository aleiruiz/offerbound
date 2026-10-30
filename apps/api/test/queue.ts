import type { JobQueue, QueueName, SendOptions } from "../src/jobs/queues.js";

/** An in-memory JobQueue that records what was sent and scheduled. */
export class RecordingQueue implements JobQueue {
  sent: { name: QueueName; data: Record<string, unknown>; opts: SendOptions }[] = [];
  schedules: { name: QueueName; cron: string; tz: string }[] = [];
  unscheduled: QueueName[] = [];
  /** Set to false to see how the app behaves before the queue has started. */
  ready = true;
  /** When set, every send rejects with it (a queue that is down). */
  failSendWith: Error | null = null;

  send(name: QueueName, data: Record<string, unknown> = {}, opts: SendOptions = {}): Promise<void> {
    if (this.failSendWith) return Promise.reject(this.failSendWith);
    this.sent.push({ name, data, opts });
    return Promise.resolve();
  }

  schedule(name: QueueName, cron: string, opts: { tz: string }): Promise<void> {
    this.schedules = this.schedules.filter((s) => s.name !== name);
    this.schedules.push({ name, cron, tz: opts.tz });
    this.unscheduled = this.unscheduled.filter((n) => n !== name);
    return Promise.resolve();
  }

  unschedule(name: QueueName): Promise<void> {
    this.schedules = this.schedules.filter((s) => s.name !== name);
    this.unscheduled.push(name);
    return Promise.resolve();
  }

  /** Jobs sent with a start delay count as waiting, until a test clears `sent`. */
  hasDelayed(name: QueueName): Promise<boolean> {
    return Promise.resolve(
      this.sent.some((s) => s.name === name && (s.opts.startAfterSeconds ?? 0) > 0),
    );
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Names of the jobs sent so far, in order. */
  get sentNames(): QueueName[] {
    return this.sent.map((s) => s.name);
  }
}
