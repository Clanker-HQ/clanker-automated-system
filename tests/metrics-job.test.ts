// tests/metrics-job.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMetricsJob } from "../src/metrics.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { FakeRevenueTransport } from "../src/control/revenue-transport.js";
import type { RevenueTransport } from "../src/control/revenue-transport.js";
import { TaskStore } from "../src/control/task-store.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { RunStore, newRunId } from "../src/run-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";
import type { VerifiedOutcome } from "../src/control/outcome-verifier.js";

function fixtures() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-metrics-job-"));
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

/**
 * RunWriter.close() stamps startedAt from the real system clock, not from
 * any date embedded in the runId — faking the clock is the only way to land
 * a run's RunResult.startedAt at a chosen time. Mirrors tests/digest.test.ts's
 * own recordRun helper exactly, for the same reason.
 */
async function recordRun(store: RunStore, at: Date, agent: string, costUsd: number, verifiedOutcome?: VerifiedOutcome) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    const writer = await store.open(newRunId(agent, at), agent);
    await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd, durationMs: 1 });
    const result = await writer.close({ status: "success", summary: "" });
    if (verifiedOutcome) await store.recordVerification(result.runId, verifiedOutcome);
  } finally {
    vi.useRealTimers();
  }
}

const NOW = new Date("2026-09-07T04:00:00.000Z");
const WITHIN_WINDOW = new Date("2026-09-05T00:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-08-01T00:00:00.000Z");

describe("runMetricsJob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gathers data from every store and the revenue transport, computes and persists one snapshot", async () => {
    const f = fixtures();
    await recordRun(f.runStore, WITHIN_WINDOW, "builder", 3);
    const created = await f.taskStore.create({ text: "ship it", createdBy: "system" });
    await f.taskStore.update(created.id, {
      status: "done", finishedAt: WITHIN_WINDOW.toISOString(), result: { summary: "done", path: "x" },
    });
    await f.memory.append({ ts: WITHIN_WINDOW.toISOString(), domain: "revenue", kind: "proposal", subject: "sell widgets", body: "a proposal", importance: 5, createdBy: "system" });
    f.revenue.seedSale({ id: "s1", product: "widget", timestampIso: WITHIN_WINDOW.toISOString(), amountUsd: 20 });

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: f.revenue, metricsStore: f.metricsStore, overrides: f.overrides, windowDays: 7, now: NOW,
    });

    expect(metrics.netIncomeUsd).toBe(20);
    expect(metrics.computedAt).toBe(NOW.toISOString());
    expect(metrics.noveltySharePercent).toBe(100);
    const persisted = await f.metricsStore.listAll();
    expect(persisted).toEqual([metrics]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("excludes runs, memory records, and done tasks outside the window, but still counts a stale pending task", async () => {
    const f = fixtures();
    await recordRun(f.runStore, BEFORE_WINDOW, "builder", 100);
    await recordRun(f.runStore, WITHIN_WINDOW, "builder", 1);
    await f.memory.append({ ts: BEFORE_WINDOW.toISOString(), domain: "revenue", kind: "proposal", subject: "old", body: "old proposal", importance: 1, createdBy: "system" });
    // A task still "pending" from well before the window — starvation must
    // see it regardless. TaskStore.create() stamps createdAt from the real
    // clock (it has no createdAt parameter), so faking the clock is the only
    // way to land it at a chosen time, same reasoning as recordRun above.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    try {
      await f.taskStore.create({ text: "still waiting", createdBy: "system" });
    } finally {
      vi.useRealTimers();
    }

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: f.revenue, metricsStore: f.metricsStore, overrides: f.overrides, windowDays: 7, now: NOW,
    });

    // Only the in-window run's $1 counts toward cost — but there's no done
    // task in-window either, so costPerCompletedTaskUsd is still null; the
    // real assertion here is on queue starvation seeing the old pending task.
    expect(metrics.costPerCompletedTaskUsd).toBeNull();
    expect(metrics.queueStarvationHours).not.toBeNull();
    expect(metrics.queueStarvationHours).toBeGreaterThan(24 * 30);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("still computes and persists a snapshot from the other stores when the revenue transport fails", async () => {
    const f = fixtures();
    await recordRun(f.runStore, WITHIN_WINDOW, "builder", 3);
    const created = await f.taskStore.create({ text: "ship it", createdBy: "system" });
    await f.taskStore.update(created.id, {
      status: "done", finishedAt: WITHIN_WINDOW.toISOString(), result: { summary: "done", path: "x" },
    });
    const failingRevenue: RevenueTransport = {
      listSales: async () => {
        throw new Error("stripe unavailable");
      },
    };

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: failingRevenue, metricsStore: f.metricsStore, overrides: f.overrides, windowDays: 7, now: NOW,
    });

    expect(metrics.netIncomeUsd).toBe(0);
    expect(metrics.costPerCompletedTaskUsd).not.toBeNull();
    const persisted = await f.metricsStore.listAll();
    expect(persisted).toEqual([metrics]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  // A $0 snapshot that could equally mean "no sales" or "we could not read
  // sales" is the one reading the operator must never have to guess at: the
  // console.error the catch already writes goes to the container log, while
  // the digest posts the $0 to Discord with nothing distinguishing the two.
  it("flags the snapshot as a revenue data gap when the transport fails", async () => {
    const f = fixtures();
    const failingRevenue: RevenueTransport = {
      listSales: async () => {
        throw new Error("revenue source unavailable");
      },
    };

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: failingRevenue, metricsStore: f.metricsStore, overrides: f.overrides, windowDays: 7, now: NOW,
    });

    expect(metrics.revenueUnavailable).toBe(true);
    expect((await f.metricsStore.listAll())[0]?.revenueUnavailable).toBe(true);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("does not flag a data gap when the revenue transport answers", async () => {
    const f = fixtures();
    f.revenue.seedSale({ id: "s1", product: "widget", timestampIso: WITHIN_WINDOW.toISOString(), amountUsd: 5 });

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: f.revenue, metricsStore: f.metricsStore, overrides: f.overrides, windowDays: 7, now: NOW,
    });

    expect(metrics.revenueUnavailable).toBe(false);
    expect(metrics.netIncomeUsd).toBe(5);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  // The breaker only counts consecutive hard failures, so an agent whose
  // every run closes "success" while the verifier grades it "not-achieved"
  // never trips it — this is the only place that catches that case.
  it("auto-disables an agent whose successful runs mostly achieve nothing", async () => {
    const f = fixtures();
    for (let i = 0; i < 6; i++) {
      await recordRun(f.runStore, new Date(WITHIN_WINDOW.getTime() + i * 60_000), "cleanup-scout", 1, {
        verdict: "not-achieved", reason: "nothing changed",
      });
    }

    await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: f.revenue, metricsStore: f.metricsStore, overrides: f.overrides, windowDays: 7, now: NOW,
    });

    const overrides = await f.overrides.read();
    expect(overrides.disabledAgents).toEqual(["cleanup-scout"]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});
