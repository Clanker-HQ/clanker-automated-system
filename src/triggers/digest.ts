import { Cron } from "croner";
import type { MemoryConfig } from "../config.js";
import type { TaskStore } from "../control/task-store.js";
import type { ProbeStore } from "../deploy/probe-store.js";
import { buildDigestText } from "../digest.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { AgentDef } from "../registry.js";
import type { RunStore } from "../run-store.js";
import type { MetricsStore } from "../state/metrics-store.js";
import type { StrategyStore } from "../world/strategy.js";

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
  /** Passed straight through: buildDigestText drops its deploy-liveness section when this is absent. */
  probeStore?: ProbeStore;
  /** Passed straight through: buildDigestText drops its deploy-liveness section when this is absent. */
  declaredSlugs?: string[];
  /** Passed straight through: buildDigestText drops its cron-liveness section when this is absent. */
  agents?: AgentDef[];
  /** Passed straight through: buildDigestText treats every enabled cron agent as un-exempt when this is absent. */
  strategyStore?: StrategyStore;
}): Cron {
  const now = opts.now ?? (() => new Date());
  // Async rather than `void run().catch()`: croner awaits an async callback,
  // so `protect: true` genuinely prevents an overlapping run, and
  // `job.trigger()` becomes awaitable — same reasoning as startMetrics.
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, async () => {
    try {
      const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
      const text = await buildDigestText({
        store: opts.store, tasks: opts.tasks, since, memory: opts.memory, memoryConfig: opts.memoryConfig,
        metricsStore: opts.metricsStore, probeStore: opts.probeStore, declaredSlugs: opts.declaredSlugs,
        agents: opts.agents, strategyStore: opts.strategyStore,
      });
      await opts.outbox.postAlert(opts.channel, text);
    } catch (error) {
      console.error("[digest] failed to build/post the daily digest", error);
    }
  });
  console.log(
    `[digest] scheduled "${opts.schedule}" (${opts.timezone}) -> #${opts.channel}; next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
