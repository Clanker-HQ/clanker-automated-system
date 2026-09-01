import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import type { VerifiedOutcome } from "../src/control/outcome-verifier.js";
import { FakeRevenueTransport } from "../src/control/revenue-transport.js";
import { TaskStore } from "../src/control/task-store.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { RunStore, newRunId } from "../src/run-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";
import { startMetrics } from "../src/triggers/metrics.js";

const NOW = new Date("2026-09-07T04:00:00.000Z");
const WITHIN_WINDOW = new Date("2026-09-05T00:00:00.000Z");
/** Feb 29 on a non-leap year — never fires on its own, so only trigger() runs the job. */
const NEVER = "0 0 29 2 *";

const NOT_ACHIEVED: VerifiedOutcome = { verdict: "not-achieved", reason: "produced no usable output" };

function fixtures() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-metrics-trigger-"));
  return {
    dataDir,
    runStore: new RunStore(dataDir),
    taskStore: new TaskStore(dataDir),
    memory: new MemoryStore(dataDir),
    revenue: new FakeRevenueTransport(),
    metricsStore: new MetricsStore(dataDir),
    overrides: new ConfigOverridesStore(dataDir),
  };
}

async function recordNotAchievedRun(store: RunStore, at: Date, agent: string) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    const writer = await store.open(newRunId(agent, at), agent);
    await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0.1, durationMs: 1 });
    const result = await writer.close({ status: "success", summary: "" });
    await store.recordVerification(result.runId, NOT_ACHIEVED);
  } finally {
    vi.useRealTimers();
  }
}

describe("startMetrics", () => {
  /**
   * The probation check landed inside runMetricsJob behind an optional
   * `overrides` dep, and nothing on the scheduled path passed it — so the
   * feature was fully implemented, fully tested, and dead in production.
   * This test exercises the path boot actually uses, which the job's own
   * unit tests cannot: they construct the deps themselves.
   */
  it("forwards overrides so a scheduled run can disable an underperforming agent", async () => {
    const f = fixtures();
    for (let i = 0; i < 6; i++) {
      await recordNotAchievedRun(f.runStore, new Date(WITHIN_WINDOW.getTime() + i * 1000), "cleanup-scout");
    }

    const job = startMetrics({
      schedule: NEVER,
      timezone: "UTC",
      windowDays: 7,
      runStore: f.runStore,
      taskStore: f.taskStore,
      memory: f.memory,
      revenue: f.revenue,
      metricsStore: f.metricsStore,
      overrides: f.overrides,
      now: () => NOW,
    });

    try {
      await job.trigger();
      expect((await f.overrides.read()).disabledAgents).toContain("cleanup-scout");
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });
});
