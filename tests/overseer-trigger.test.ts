import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeRevenueTransport } from "../src/control/revenue-transport.js";
import type { Deployment } from "../src/deploy/deploys-schema.js";
import { ProbeStore } from "../src/deploy/probe-store.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { AgentDef } from "../src/registry.js";
import type { RunStore } from "../src/run-store.js";
import { MetricsStore, type Metrics } from "../src/state/metrics-store.js";
import { startOverseer } from "../src/triggers/overseer.js";
import { StrategyStore } from "../src/world/strategy.js";
import { WorldModel } from "../src/world/world-model.js";

/** Feb 29 on a non-leap year — never fires on its own, so only trigger() runs the job. */
const NEVER = "0 0 29 2 *";
const NOW = new Date("2026-09-08T05:00:00.000Z");

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "overseer",
    enabled: true,
    trigger: { type: "cron", schedule: NEVER, timezone: "UTC" },
    ...overrides,
  } as unknown as AgentDef;
}

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    computedAt: "2026-09-07T04:00:00.000Z",
    windowDays: 7,
    netIncomeUsd: 10,
    notAchievedRate: null,
    notAchievedByAgent: [],
    costPerCompletedTaskUsd: null,
    noveltySharePercent: null,
    suppressedProposalCount: 0,
    queueStarvationHours: null,
    ...overrides,
  };
}

function fixtures() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-overseer-trigger-"));
  const goalsPath = join(dataDir, "goals.yaml");
  writeFileSync(
    goalsPath,
    'primary:\n  id: p1\n  statement: "Earn enough to cover its own hosting costs"\n' +
      'secondary:\n  id: s1\n  instrumental: true\n  statement: "Stay within the law"\n' +
      "means:\n  - \"Sell software\"\n",
  );
  return {
    dataDir,
    goalsPath,
    strategyStore: new StrategyStore(dataDir),
    world: new WorldModel(dataDir),
    metricsStore: new MetricsStore(dataDir),
    revenue: new FakeRevenueTransport(),
    probeStore: new ProbeStore(dataDir),
  };
}

describe("startOverseer", () => {
  it("schedules on the agent's own configured cron", () => {
    const f = fixtures();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent({ trigger: { type: "cron", schedule: "0 5 * * 1", timezone: "Europe/Berlin" } }),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
    });
    try {
      expect(job.getPattern()).toBe("0 5 * * 1");
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("catches up a missed weekly cycle at boot when given a runStore (the machine was off at the scheduled time)", async () => {
    const f = fixtures();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const runStore = { latestFor: vi.fn().mockResolvedValue(null) } as unknown as RunStore;
    const job = startOverseer({
      agent: agent({ trigger: { type: "cron", schedule: "0 5 * * 1", timezone: "UTC" } }),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      runStore,
    });
    try {
      // catchUpIfMissed is fire-and-forget from startOverseer's side (matches
      // production, where index.ts doesn't await it either) and its own
      // chain crosses several real fs reads (goals, strategy, world model,
      // metrics), so poll rather than assume a fixed number of ticks is enough.
      await vi.waitFor(() => expect(executeRun).toHaveBeenCalledTimes(1));
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("does not catch up when no runStore is given", async () => {
    const f = fixtures();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent({ trigger: { type: "cron", schedule: "0 5 * * 1", timezone: "UTC" } }),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
    });
    try {
      // Give any (erroneous) catch-up chain the same runway the positive
      // test above needs, then confirm it never fired.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(executeRun).not.toHaveBeenCalled();
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("grades the previous cycle's expectations before the run starts, and passes goals plus the verdicts into the prompt", async () => {
    const f = fixtures();
    await f.strategyStore.write({
      writtenAt: "2026-09-01T05:00:00.000Z",
      intent: "Push the CLI product toward its first paying customer.",
      allocation: { research: 20, build: 60, maintain: 20 },
      expectations: [{ id: "e1", dueAt: "2026-09-07", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      changeReason: "",
    });
    await f.metricsStore.write(metrics({ netIncomeUsd: 10 }));

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const overseerAgent = agent();
    const job = startOverseer({
      agent: overseerAgent,
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      now: () => NOW,
    });

    try {
      await job.trigger();
      expect(executeRun).toHaveBeenCalledTimes(1);
      const [calledAgent, calledNow, promptContext] = executeRun.mock.calls[0]!;
      expect(calledAgent).toBe(overseerAgent);
      expect(calledNow).toBe(NOW);
      expect(promptContext).toContain("e1");
      expect(promptContext).toContain("missed");
      expect(promptContext).toContain("netIncomeUsd 10 < 50");
      expect(promptContext).toContain("Earn enough to cover its own hosting costs");
      expect(promptContext).toContain("Push the CLI product toward its first paying customer.");
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("runs regardless of the allocation in the latest strategy, even an all-zero one", async () => {
    // The overseer is the only thing that writes strategy, so an allocation
    // that paused it would be unrecoverable without operator intervention.
    // startOverseer is a bespoke trigger (src/index.ts filters "overseer"
    // out of startCron entirely) that never reads allocation at all — this
    // proves that structurally, rather than adding allocation-reading here
    // just to then test skipping it. StrategyStore.write() itself refuses an
    // allocation that doesn't sum to 100, so a genuinely all-zero one is
    // written straight to disk here rather than through the store.
    const f = fixtures();
    const strategyDir = join(f.dataDir, "world", "strategy");
    mkdirSync(strategyDir, { recursive: true });
    writeFileSync(
      join(strategyDir, "strategy-2026-09-01T05-00-00-000Z.json"),
      JSON.stringify({
        writtenAt: "2026-09-01T05:00:00.000Z",
        intent: "test",
        allocation: { research: 0, build: 0, maintain: 0 },
        expectations: [],
        changeReason: "",
      }),
    );

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent(),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      now: () => NOW,
    });

    try {
      await job.trigger();
      expect(executeRun).toHaveBeenCalledTimes(1);
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("renders a due review with its bar, how overdue it is, and whether it can still be extended", async () => {
    const f = fixtures();
    await f.world.upsertPortfolioEntry({
      slug: "widget-api",
      purpose: "Paid API for widget conversion",
      status: "live",
      nextReviewAt: "2026-09-01",
      bar: "at least one paying customer",
      monthlyCostUsd: 12,
      notes: [],
      extensionCount: 2,
    });
    // A killed entry must never appear under "Due reviews", however overdue.
    await f.world.upsertPortfolioEntry({
      slug: "dead-product",
      purpose: "test",
      status: "killed",
      nextReviewAt: "2020-01-01",
      bar: "n/a",
      monthlyCostUsd: 0,
      notes: [],
      extensionCount: 1,
    });

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent(),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      now: () => NOW,
    });

    try {
      await job.trigger();
      const [, , promptContext] = executeRun.mock.calls[0]!;
      expect(promptContext).toContain("Due reviews");
      expect(promptContext).toContain("widget-api");
      expect(promptContext).toContain("at least one paying customer");
      expect(promptContext).toContain("extensionCount: 2");
      expect(promptContext).toMatch(/widget-api[\s\S]*canExtend: false/);
      const dueSection = promptContext.slice(promptContext.indexOf("## Due reviews"), promptContext.indexOf("## World model"));
      expect(dueSection).not.toContain("dead-product");
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("says explicitly when no reviews are due", async () => {
    const f = fixtures();
    await f.world.upsertPortfolioEntry({
      slug: "widget-api",
      purpose: "Paid API for widget conversion",
      status: "live",
      nextReviewAt: "2099-01-01",
      bar: "at least one paying customer",
      monthlyCostUsd: 12,
      notes: [],
      extensionCount: 0,
    });

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent(),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      now: () => NOW,
    });

    try {
      await job.trigger();
      const [, , promptContext] = executeRun.mock.calls[0]!;
      expect(promptContext).toContain("Due reviews");
      expect(promptContext).toMatch(/Due reviews\n\n(- )?\(?none/i);
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("still runs on the first ever cycle, with no previous strategy to grade", async () => {
    const f = fixtures();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent(),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      now: () => NOW,
    });

    try {
      await job.trigger();
      expect(executeRun).toHaveBeenCalledTimes(1);
      const [, , promptContext] = executeRun.mock.calls[0]!;
      expect(promptContext).toContain("first cycle");
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("renders product liveness, naming a deployment that is not serving", async () => {
    const f = fixtures();
    const deployment: Deployment = {
      slug: "status-page",
      repo: "Clanker-HQ/clanker-status-page",
      hostname: "status.example.com",
      port: 8080,
      env: [],
    };
    await f.probeStore.write([
      {
        slug: "status-page",
        url: "https://status.example.com/",
        lastProbeAt: NOW.toISOString(),
        ok: false,
        consecutiveFailures: 3,
        detail: "HTTP 502",
      },
    ]);

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const job = startOverseer({
      agent: agent(),
      orchestrator,
      strategyStore: f.strategyStore,
      world: f.world,
      metricsStore: f.metricsStore,
      revenue: f.revenue,
      deployments: [deployment],
      probeStore: f.probeStore,
      goalsPath: f.goalsPath,
      now: () => NOW,
    });

    try {
      await job.trigger();
      const [, , promptContext] = executeRun.mock.calls[0]!;
      expect(promptContext).toContain("## Product liveness");
      expect(promptContext).toContain("status-page");
      expect(promptContext).toContain("NOT SERVING");
    } finally {
      job.stop();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });
});
