import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeRevenueTransport } from "../src/control/revenue-transport.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { AgentDef } from "../src/registry.js";
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
      goalsPath: f.goalsPath,
    });
    try {
      expect(job.getPattern()).toBe("0 5 * * 1");
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
});
