import { Cron } from "croner";
import type { MemoryConfig } from "../config.js";
import type { TaskStore } from "../control/task-store.js";
import { buildDigestText } from "../digest.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { RunStore } from "../run-store.js";
import type { MetricsStore } from "../state/metrics-store.js";

interface DigestOutbox {
  postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered">;
}

export function startDigest(opts: {
  schedule: string;
  timezone: string;
  channel: string;
  store: RunStore;
  tasks: TaskStore;
  outbox: DigestOutbox;
  now?: () => Date;
  memory?: MemoryStore;
  /** Passed straight through: buildDigestText drops its memory section when this says memory is off. */
  memoryConfig?: MemoryConfig;
  /** Passed straight through: buildDigestText drops its metrics section when this is absent. */
  metricsStore?: MetricsStore;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, () => {
    void (async () => {
      const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
      const text = await buildDigestText({
        store: opts.store, tasks: opts.tasks, since, memory: opts.memory, memoryConfig: opts.memoryConfig,
        metricsStore: opts.metricsStore,
      });
      await opts.outbox.postAlert(opts.channel, text);
    })().catch((error: unknown) => {
      console.error("[digest] failed to build/post the daily digest", error);
    });
  });
  console.log(
    `[digest] scheduled "${opts.schedule}" (${opts.timezone}) -> #${opts.channel}; next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
