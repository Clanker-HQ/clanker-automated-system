import { Cron } from "croner";
import type { ConfigOverridesStore } from "../config-overrides.js";
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
  /**
   * Required, not optional, and deliberately so: the agent-probation check
   * inside runMetricsJob is the only thing that catches an agent whose runs
   * all finish "success" while achieving nothing (the breaker counts hard
   * failures only). It first shipped behind an optional dep that this
   * scheduled path never passed, so it was fully implemented, fully tested,
   * and dead. Requiring it here makes the compiler refuse the same omission.
   */
  overrides: ConfigOverridesStore;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  // Async rather than `void run().then().catch()`: croner awaits an async
  // callback, so `protect: true` genuinely prevents an overlapping run, and
  // `job.trigger()` becomes awaitable — which is what lets this path be
  // tested at all.
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, async () => {
    try {
      const metrics = await runMetricsJob({
        runStore: opts.runStore,
        taskStore: opts.taskStore,
        memory: opts.memory,
        revenue: opts.revenue,
        metricsStore: opts.metricsStore,
        overrides: opts.overrides,
        windowDays: opts.windowDays,
        now: now(),
      });
      console.log(`[metrics] computed a ${opts.windowDays}d snapshot for ${metrics.computedAt}: $${metrics.netIncomeUsd.toFixed(2)} net income`);
    } catch (error: unknown) {
      console.error("[metrics] job failed", error);
    }
  });
  console.log(
    `[metrics] scheduled "${opts.schedule}" (${opts.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
