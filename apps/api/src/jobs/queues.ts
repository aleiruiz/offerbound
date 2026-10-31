import type { PgBoss, Queue } from "pg-boss";

/** Every queue (TECHNICAL_SPEC §9). */
export const QUEUES = {
  gmailSync: "gmail.sync",
  gmailBackfill: "gmail.backfill",
  emailTriage: "email.triage",
  emailExtract: "email.extract",
  emailApply: "email.apply",
  leadsCheck: "leads.check",
  leadsRank: "leads.rank",
  leadsFinalize: "leads.finalize",
  leadsRecheck: "leads.recheck",
  searchRun: "search.run",
  timersTick: "timers.tick",
  backupNightly: "backup.nightly",
  demoReset: "demo.reset",
  maintenanceDaily: "maintenance.daily",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type SendOptions = {
  /** With a `singleton` or `stately` queue, at most one job per key is active. */
  singletonKey?: string;
  /** Do not start before this many seconds from now (retries that honour `Retry-After`). */
  startAfterSeconds?: number;
};

/** What the API and the jobs need from the job queue. Tests use `RecordingQueue`. */
export interface JobQueue {
  send(name: QueueName, data?: Record<string, unknown>, opts?: SendOptions): Promise<void>;
  /** Registers (or replaces) the recurring job for `name`. */
  schedule(name: QueueName, cron: string, opts: { tz: string }): Promise<void>;
  unschedule(name: QueueName): Promise<void>;
  /**
   * True while a job of this queue is waiting for a start time in the future (a deferred retry
   * or a pg-boss backoff). Cron ticks check it so they do not run ahead of a requested wait.
   */
  hasDelayed(name: QueueName): Promise<boolean>;
  /** True once the queue has started and can accept jobs (`/ready`, TECHNICAL_SPEC §16). */
  isReady(): boolean;
}

/**
 * How each queue behaves (TECHNICAL_SPEC §9). `retryLimit` is the number of retries after the
 * first run; failed jobs wait `retryDelay` seconds, doubling each time. `concurrency` is how many
 * jobs one worker process runs at once. `expireInSeconds` is how long a job may stay active
 * before pg-boss treats it as lost and retries it.
 *
 * Policies: `singleton` allows one active job per queue (per key when sent with one), so a
 * duplicate delivery waits instead of running twice. `stately` does the same per key and also
 * keeps one waiting job per key, for `email.extract` (key = message id). `standard` queues run
 * jobs in parallel up to `concurrency`.
 */
export type QueueConfig = {
  policy: "singleton" | "stately" | "standard";
  retryLimit: number;
  retryDelay: number;
  concurrency: number;
  expireInSeconds: number;
};

export const QUEUE_CONFIG: Record<QueueName, QueueConfig> = {
  [QUEUES.gmailSync]: {
    policy: "singleton",
    retryLimit: 3,
    retryDelay: 60,
    concurrency: 1,
    expireInSeconds: 600,
  },
  [QUEUES.gmailBackfill]: {
    policy: "singleton",
    retryLimit: 5,
    retryDelay: 60,
    concurrency: 1,
    expireInSeconds: 3600,
  },
  [QUEUES.emailTriage]: {
    policy: "singleton",
    retryLimit: 4,
    retryDelay: 30,
    concurrency: 1,
    expireInSeconds: 600,
  },
  [QUEUES.emailExtract]: {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    concurrency: 4,
    expireInSeconds: 300,
  },
  [QUEUES.emailApply]: {
    policy: "singleton",
    retryLimit: 3,
    retryDelay: 60,
    concurrency: 1,
    expireInSeconds: 600,
  },
  [QUEUES.leadsCheck]: {
    policy: "standard",
    retryLimit: 2,
    retryDelay: 30,
    concurrency: 5,
    expireInSeconds: 120,
  },
  [QUEUES.leadsRank]: {
    policy: "standard",
    retryLimit: 3,
    retryDelay: 60,
    concurrency: 2,
    expireInSeconds: 600,
  },
  [QUEUES.leadsFinalize]: {
    policy: "singleton",
    retryLimit: 3,
    retryDelay: 60,
    concurrency: 1,
    expireInSeconds: 300,
  },
  [QUEUES.leadsRecheck]: {
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 300,
    concurrency: 1,
    expireInSeconds: 1800,
  },
  [QUEUES.searchRun]: {
    policy: "singleton",
    retryLimit: 0,
    retryDelay: 0,
    concurrency: 1,
    expireInSeconds: 3600,
  },
  [QUEUES.timersTick]: {
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 60,
    concurrency: 1,
    expireInSeconds: 300,
  },
  [QUEUES.backupNightly]: {
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 300,
    concurrency: 1,
    expireInSeconds: 1800,
  },
  [QUEUES.demoReset]: {
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 60,
    concurrency: 1,
    expireInSeconds: 300,
  },
  [QUEUES.maintenanceDaily]: {
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 300,
    concurrency: 1,
    expireInSeconds: 600,
  },
};

/** No retry waits longer than this, whatever the doubling gives. */
const RETRY_DELAY_MAX_SECONDS = 900;

function queueOptions(name: QueueName): Omit<Queue, "name"> {
  const config = QUEUE_CONFIG[name];
  return {
    policy: config.policy,
    retryLimit: config.retryLimit,
    retryDelay: config.retryDelay,
    retryBackoff: config.retryDelay > 0,
    ...(config.retryDelay > 0 ? { retryDelayMax: RETRY_DELAY_MAX_SECONDS } : {}),
    expireInSeconds: config.expireInSeconds,
  };
}

function logQueueError(info: { errorName: string; errorCode?: string }): void {
  console.error(JSON.stringify({ level: "error", msg: "pg-boss error", ...info }));
}

/**
 * The pg-boss queue. `start()` starts pg-boss and creates every queue (or brings an existing
 * queue's retry and expiry settings in line). The API process uses it only to send and schedule;
 * the worker also registers handlers on `boss`.
 */
export class PgBossQueue implements JobQueue {
  private state: "new" | "started" | "stopped" = "new";

  /**
   * Every pg-boss instance needs an `error` listener: a dropped idle database connection is
   * reported as an `error` event, and with no listener Node throws and the process dies.
   * `onError` gets the error's name and code only, never its message (which can carry data).
   */
  constructor(
    readonly boss: PgBoss,
    onError: (info: { errorName: string; errorCode?: string }) => void = logQueueError,
  ) {
    boss.on("error", (error: unknown) => {
      const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
      onError({
        errorName: typeof name === "string" ? name : "unknown",
        ...(typeof code === "string" ? { errorCode: code } : {}),
      });
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const name of Object.values(QUEUES)) {
      const { policy, ...settings } = queueOptions(name);
      if (await this.boss.getQueue(name)) {
        // The policy is fixed at creation; everything else can change between deploys.
        await this.boss.updateQueue(name, settings);
      } else {
        await this.boss.createQueue(name, { policy, ...settings });
      }
    }
    this.state = "started";
  }

  async stop(options?: { graceful?: boolean; timeout?: number }): Promise<void> {
    this.state = "stopped";
    await this.boss.stop(options);
  }

  isReady(): boolean {
    return this.state === "started";
  }

  async hasDelayed(name: QueueName): Promise<boolean> {
    const now = Date.now();
    const jobs = await this.boss.findJobs(name, { queued: true });
    return jobs.some((job) => job.startAfter.getTime() > now);
  }

  async send(
    name: QueueName,
    data: Record<string, unknown> = {},
    opts: SendOptions = {},
  ): Promise<void> {
    await this.boss.send(name, data, {
      ...(opts.singletonKey !== undefined ? { singletonKey: opts.singletonKey } : {}),
      ...(opts.startAfterSeconds !== undefined ? { startAfter: opts.startAfterSeconds } : {}),
    });
  }

  async schedule(name: QueueName, cron: string, opts: { tz: string }): Promise<void> {
    await this.boss.schedule(name, cron, null, { tz: opts.tz });
  }

  async unschedule(name: QueueName): Promise<void> {
    await this.boss.unschedule(name);
  }
}
