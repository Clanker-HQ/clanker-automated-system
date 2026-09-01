import { Cron } from "croner";
import type { RevenueTransport } from "../control/revenue-transport.js";
import type { TaskStore } from "../control/task-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { runMetricsJob } from "../metrics.js";
import type { RunStore } from "../run-store.js";
import type { MetricsStore } from "../state/metrics-store.js";

export function startMetrics(opts: {
  schedule: string;
  timezone: string;
  windowDays: number;
  runStore: RunStore;
  taskStore: TaskStore;
  memory: MemoryStore;
  revenue: RevenueTransport;
  metricsStore: MetricsStore;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, () => {
    void runMetricsJob({
      runStore: opts.runStore,
      taskStore: opts.taskStore,
      memory: opts.memory,
      revenue: opts.revenue,
      metricsStore: opts.metricsStore,
      windowDays: opts.windowDays,
      now: now(),
    })
      .then((metrics) => {
        console.log(`[metrics] computed a ${opts.windowDays}d snapshot for ${metrics.computedAt}: $${metrics.netIncomeUsd.toFixed(2)} net income`);
      })
      .catch((error: unknown) => {
        console.error("[metrics] job failed", error);
      });
  });
  console.log(
    `[metrics] scheduled "${opts.schedule}" (${opts.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
