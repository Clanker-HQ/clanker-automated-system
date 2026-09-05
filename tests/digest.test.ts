import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/control/task-store.js";
import { ProbeStore } from "../src/deploy/probe-store.js";
import { buildDigestText } from "../src/digest.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore, newRunId } from "../src/run-store.js";
import type { Metrics } from "../src/state/metrics-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";
import { startDigest } from "../src/triggers/digest.js";
import type { Strategy } from "../src/world/strategy.js";
import { metricsSnapshot as baseMetricsSnapshot } from "./helpers/metrics.js";

function cronAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "dependency-scout",
    enabled: true,
    trigger: { type: "cron", schedule: "0 14 * * *", timezone: "UTC" },
    category: "maintain",
    ...overrides,
  } as AgentDef;
}

function stores() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-"));
  return { store: new RunStore(dataDir), tasks: new TaskStore(dataDir), memory: new MemoryStore(dataDir) };
}

const SINCE = new Date("2026-08-27T00:00:00.000Z");
const WITHIN_WINDOW = new Date("2026-08-27T12:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-08-26T12:00:00.000Z");

/** RunWriter.close() stamps startedAt from the real system clock, not from any date embedded in the runId — so faking the clock is the only way to land a run at a chosen time. */
async function recordRun(store: RunStore, at: Date, status: "success" | "failed", costUsd: number) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    const writer = await store.open(newRunId("smoke", at), "smoke");
    await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, durationMs: 1 });
    await writer.close({ status, summary: "" });
  } finally {
    vi.useRealTimers();
  }
}

describe("buildDigestText", () => {
  afterEach(() => {
    vi.useRealTimers();
  });


  it("says nothing happened when the window is empty", async () => {
    const { store, tasks } = stores();
    expect(await buildDigestText({ store, tasks, since: SINCE })).toBe("📅 Daily digest: nothing happened in the last 24h.");
  });

  it("still says nothing happened when only memory activity is in the window", async () => {
    const { store, tasks, memory } = stores();
    await memory.append({ domain: "research", kind: "finding", subject: "x", body: "y", importance: 5, createdBy: "agent:research" });
    expect(await buildDigestText({ store, tasks, since: SINCE, memory })).toBe("📅 Daily digest: nothing happened in the last 24h.");
  });

  it("counts runs and spend within the window, ignoring runs before it", async () => {
    const { store, tasks } = stores();
    // Distinct timestamps: newRunId derives its id from agent name + time, so
    // two runs at the identical instant would collide into one run directory.
    await recordRun(store, WITHIN_WINDOW, "success", 1.5);
    await recordRun(store, new Date(WITHIN_WINDOW.getTime() + 1000), "failed", 0.5);
    await recordRun(store, BEFORE_WINDOW, "success", 100);
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("Runs: 2");
    expect(text).toContain("1 success");
    expect(text).toContain("1 failed");
    expect(text).toContain("$2.00 spent");
    expect(text).not.toContain("100");
  });

  it("counts tasks finished within the window, ignoring ones finished before it", async () => {
    const { store, tasks } = stores();
    const done = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(done.id, { status: "done", finishedAt: WITHIN_WINDOW.toISOString() });
    const failed = await tasks.create({ text: "y", createdBy: "discord:owner" });
    await tasks.update(failed.id, { status: "failed", finishedAt: WITHIN_WINDOW.toISOString(), failureReason: "boom" });
    const oldDone = await tasks.create({ text: "z", createdBy: "discord:owner" });
    await tasks.update(oldDone.id, { status: "done", finishedAt: BEFORE_WINDOW.toISOString() });

    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("Tasks: 1 done, 1 failed");
    expect(text).toContain(`\`${failed.id.slice(0, 8)}\``);
    expect(text).toContain("boom");
  });

  it("lists tasks waiting on the owner regardless of how long they've been waiting", async () => {
    const { store, tasks } = stores();
    const waiting = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(waiting.id, { status: "waiting" });
    const text = await buildDigestText({ store, tasks, since: WITHIN_WINDOW });
    expect(text).toContain("Waiting on you");
    expect(text).toContain(waiting.id.slice(0, 8));
  });

  it("flags runs that succeeded but were graded not-achieved, within the window only", async () => {
    const { store, tasks } = stores();
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW);
    const flagged = await store.open(newRunId("smoke", WITHIN_WINDOW), "smoke");
    await flagged.close({ status: "success", summary: "" });
    vi.useRealTimers();
    await store.recordVerification(flagged.runId, { verdict: "not-achieved", reason: "missed it" });
    // Distinct timestamp: same reasoning as the "counts runs and spend" test
    // above — two runs at the identical instant for the same agent collide
    // into one run directory.
    await recordRun(store, new Date(WITHIN_WINDOW.getTime() + 1000), "success", 1); // an ordinary success, not flagged

    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("1 run(s) succeeded but did not achieve their objective");
  });

  it("says nothing about verification when no run was graded not-achieved", async () => {
    const { store, tasks } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).not.toContain("did not achieve their objective");
  });

  it("caps the listed failed tasks at 5 and notes the rest", async () => {
    const { store, tasks } = stores();
    for (let i = 0; i < 7; i++) {
      const t = await tasks.create({ text: `t${i}`, createdBy: "discord:owner" });
      await tasks.update(t.id, { status: "failed", finishedAt: WITHIN_WINDOW.toISOString(), failureReason: `reason ${i}` });
    }
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("Tasks: 0 done, 7 failed");
    expect(text).toContain("…and 2 more failed task(s)");
  });

  it("includes memory counts, including suppressed duplicates, within the window", async () => {
    const { store, tasks, memory } = stores();
    // Needs at least one run/task in the window to get past the "nothing
    // happened" early return — this test is about the memory section's
    // content, not about whether the digest fires on a memory-only day.
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW);
    try {
      await memory.append({ domain: "research", kind: "finding", subject: "x", body: "found something", importance: 5, createdBy: "agent:research" });
      await memory.append({ domain: "research", kind: "outcome", subject: "x", body: "did something", importance: 5, createdBy: "agent:research" });
      await memory.append({ domain: "research", kind: "proposal", subject: "x", body: "suppressed as a duplicate of mem_prior", importance: 5, createdBy: "agent:research" });
    } finally {
      vi.useRealTimers();
    }
    const text = await buildDigestText({ store, tasks, since: SINCE, memory });
    expect(text).toContain("🧠 Memory:");
    expect(text).toContain("1 finding");
    expect(text).toContain("1 outcome");
    expect(text).toContain("1 proposal");
    expect(text).toContain("1 duplicate proposal(s) suppressed");
  });

  it("omits the memory section when memory is explicitly disabled in config", async () => {
    const { store, tasks, memory } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW);
    try {
      await memory.append({ domain: "research", kind: "finding", subject: "x", body: "found something", importance: 5, createdBy: "agent:research" });
    } finally {
      vi.useRealTimers();
    }
    const memoryConfig = {
      enabled: false, retentionDays: 90, reflectionRetentionDays: 365,
      similarityThreshold: 0.75, stalenessDays: 30, recencyHalfLifeDays: 14,
      maxChainDepth: 3, maxAgentTasksPerDay: 20,
      weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
      reflectionSchedule: "0 3 * * 1", reflectionTimezone: "UTC", reflectionWindowDays: 14,
    };
    const text = await buildDigestText({ store, tasks, since: SINCE, memory, memoryConfig });
    expect(text).not.toContain("🧠 Memory");
  });

  it("omits the memory section when there is no memory activity in the window", async () => {
    const { store, tasks, memory } = stores();
    // A run in the window (so the digest actually fires) but zero memory
    // records at all — the section must not appear.
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    const text = await buildDigestText({ store, tasks, since: SINCE, memory });
    expect(text).not.toContain("🧠 Memory");
  });

  it("omits the memory section when memory activity is outside the window", async () => {
    const { store, tasks, memory } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_WINDOW);
    try {
      await memory.append({ domain: "research", kind: "finding", subject: "x", body: "old finding", importance: 5, createdBy: "agent:research" });
    } finally {
      vi.useRealTimers();
    }
    const text = await buildDigestText({ store, tasks, since: SINCE, memory });
    expect(text).not.toContain("🧠 Memory");
  });
});

/** This suite's snapshots default to landing inside the digest window unless a test deliberately backdates one — the shared fixture has no opinion on that, so it's applied here. */
function metricsSnapshot(overrides: Partial<Metrics> = {}): Metrics {
  return baseMetricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), ...overrides });
}

describe("buildDigestText — metrics section", () => {
  it("includes a fresh snapshot's net income when one landed within the digest window", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ netIncomeUsd: 42 }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("$42.00 net income");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("shows the delta against the previous snapshot when one exists", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString(), netIncomeUsd: 30 }));
    await metricsStore.write(metricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), netIncomeUsd: 42 }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("+$12.00");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("renders a revenue drop with the sign before the currency symbol", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString(), netIncomeUsd: 30 }));
    await metricsStore.write(metricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), netIncomeUsd: 0 }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("-$30.00");
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The digest is the only place this number is read by a human. A snapshot
  // whose revenue read failed must not present its $0 as a measurement.
  it("reports a revenue read failure instead of presenting its $0 as income", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ netIncomeUsd: 0, revenueUnavailable: true }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("revenue unavailable");
    expect(text).not.toContain("$0.00 net income");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("suppresses the revenue delta when the latest snapshot could not read revenue", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString(), netIncomeUsd: 30 }));
    await metricsStore.write(metricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), netIncomeUsd: 0, revenueUnavailable: true }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    // A delta against an unmeasured $0 would read as revenue collapsing.
    expect(text).not.toContain("vs prior snapshot");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("suppresses the revenue delta when the PREVIOUS snapshot could not read revenue", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString(), netIncomeUsd: 0, revenueUnavailable: true }));
    await metricsStore.write(metricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), netIncomeUsd: 42 }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    // A +$42 jump measured against a week nothing was read from is invented.
    expect(text).toContain("$42.00 net income");
    expect(text).not.toContain("vs prior snapshot");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("omits the metrics section when the latest snapshot predates the digest window", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString() }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toContain("net income");
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The digest window (`since`) only reaches back 24h, but the metrics pass
  // is weekly — a snapshot this old means at least two cycles were missed,
  // not just "nothing happened in the last day".
  it("warns instead of showing the metrics section when the newest snapshot is long stale", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    const staleAt = new Date(SINCE.getTime() - 30 * 24 * 60 * 60 * 1000);
    await metricsStore.write(metricsSnapshot({ computedAt: staleAt.toISOString() }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("stopped running");
    expect(text).not.toContain("net income");
    rmSync(dataDir, { recursive: true, force: true });
  });

  // A metrics store that has never been written to is the state a broken
  // deploy leaves behind — it must not silently read as "nothing happened".
  it("warns when metrics is configured but has never produced a snapshot, and treats it as activity", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toBe("📅 Daily digest: nothing happened in the last 24h.");
    expect(text).toMatch(/never completed|never been written/i);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("omits the metrics section entirely when no metricsStore is passed", async () => {
    const { store, tasks } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);

    const text = await buildDigestText({ store, tasks, since: SINCE });

    expect(text).not.toContain("net income");
  });

  it("treats a fresh metrics snapshot as activity, not returning the empty-digest message, even with no runs or tasks", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot());

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toBe("📅 Daily digest: nothing happened in the last 24h.");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("handles null-valued metric fields without printing 'null' or 'NaN'", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(
      metricsSnapshot({ notAchievedRate: null, costPerCompletedTaskUsd: null, noveltySharePercent: null, queueStarvationHours: null }),
    );

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toContain("null");
    expect(text).not.toContain("NaN");
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("buildDigestText — deploy liveness section", () => {
  it("includes a warning line when a declared deployment is not serving", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-probe-"));
    const probeStore = new ProbeStore(dataDir);
    await probeStore.write([
      {
        slug: "status-page",
        url: "https://status.example.com/",
        lastProbeAt: "2026-08-27T23:50:00.000Z",
        ok: false,
        consecutiveFailures: 3,
        detail: "HTTP 502",
      },
    ]);

    const text = await buildDigestText({ store, tasks, since: SINCE, probeStore, declaredSlugs: ["status-page"] });

    expect(text).toContain("status-page");
    expect(text).toContain("HTTP 502");
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The point of this test: probeStore/declaredSlugs are optional on
  // buildDigestText, mirroring metricsStore, so an omission at the call site
  // that wires startDigest into production would compile fine and just never
  // run. Going through startDigest itself — the same function src/index.ts
  // calls — proves the wiring actually forwards them, not a hand-written
  // reimplementation that could quietly drift from what ships.
  it("reaches the posted digest through startDigest, the production call site", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-probe-trigger-"));
    const probeStore = new ProbeStore(dataDir);
    const triggerNow = new Date("2026-09-01T10:00:00.000Z");
    await probeStore.write([
      {
        slug: "status-page",
        url: "https://status.example.com/",
        lastProbeAt: new Date(triggerNow.getTime() - 5 * 60 * 1000).toISOString(),
        ok: false,
        consecutiveFailures: 1,
        detail: "HTTP 500",
      },
    ]);
    const posted: string[] = [];
    const outbox = {
      postAlert: async (_channel: string, text: string) => {
        posted.push(text);
        return "delivered" as const;
      },
    };
    // Feb 29 on a non-leap year — never fires on its own, so only trigger() runs the job.
    const NEVER = "0 0 29 2 *";
    const job = startDigest({
      schedule: NEVER,
      timezone: "UTC",
      channel: "ops",
      store,
      tasks,
      outbox,
      probeStore,
      declaredSlugs: ["status-page"],
      now: () => triggerNow,
    });
    try {
      await job.trigger();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("status-page");
    } finally {
      job.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("buildDigestText — cron liveness section", () => {
  it("warns when an enabled cron agent has never run", async () => {
    const { store, tasks } = stores();
    const text = await buildDigestText({ store, tasks, since: SINCE, agents: [cronAgent()] });
    expect(text).toContain("dependency-scout");
    expect(text).toMatch(/never run/i);
  });

  it("warns when an enabled cron agent's last run is far older than its own cadence", async () => {
    const { store, tasks } = stores();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SINCE.getTime() - 5 * 24 * 60 * 60 * 1000));
    try {
      const writer = await store.open(newRunId("dependency-scout"), "dependency-scout");
      await writer.close({ status: "success", summary: "" });
    } finally {
      vi.useRealTimers();
    }
    const text = await buildDigestText({ store, tasks, since: SINCE, agents: [cronAgent()] });
    expect(text).toContain("dependency-scout");
    expect(text).toMatch(/hasn't run/i);
  });

  it("is silent when the agent ran recently relative to its own daily cadence", async () => {
    const { store, tasks } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 0.1);
    // recordRun always uses agent name "smoke" -- match the fixture to it.
    const text = await buildDigestText({ store, tasks, since: SINCE, agents: [cronAgent({ name: "smoke" })] });
    expect(text).not.toMatch(/never run|hasn't run/i);
  });

  it("is silent when the agent's category is zero-allocated by the current strategy", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-strategy-"));
    const { StrategyStore } = await import("../src/world/strategy.js");
    const strategyStore = new StrategyStore(dataDir);
    const zeroed: Strategy = {
      writtenAt: SINCE.toISOString(),
      intent: "",
      allocation: { research: 50, build: 50, maintain: 0 },
      expectations: [],
      changeReason: "",
    };
    await strategyStore.write(zeroed);

    const text = await buildDigestText({ store, tasks, since: SINCE, agents: [cronAgent()], strategyStore });
    expect(text).not.toMatch(/never run|hasn't run/i);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("treats a stale cron agent as activity, not the empty-digest message", async () => {
    const { store, tasks } = stores();
    const text = await buildDigestText({ store, tasks, since: SINCE, agents: [cronAgent()] });
    expect(text).not.toBe("📅 Daily digest: nothing happened in the last 24h.");
  });

  it("omits the cron liveness section entirely when no agents list is passed", async () => {
    const { store, tasks } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).not.toMatch(/never run|hasn't run/i);
  });

  it("reaches the posted digest through startDigest, the production call site", async () => {
    const { store, tasks } = stores();
    const posted: string[] = [];
    const outbox = {
      postAlert: async (_channel: string, text: string) => {
        posted.push(text);
        return "delivered" as const;
      },
    };
    const NEVER = "0 0 29 2 *";
    const triggerNow = new Date("2026-09-01T10:00:00.000Z");
    const job = startDigest({
      schedule: NEVER,
      timezone: "UTC",
      channel: "ops",
      store,
      tasks,
      outbox,
      agents: [cronAgent()],
      now: () => triggerNow,
    });
    try {
      await job.trigger();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("dependency-scout");
    } finally {
      job.stop();
    }
  });
});
