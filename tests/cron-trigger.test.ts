import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Orchestrator } from "../src/orchestrator.js";
import type { AgentDef } from "../src/registry.js";
import { startCron } from "../src/triggers/cron.js";
import { StrategyStore, type Strategy } from "../src/world/strategy.js";
import { WorldModel } from "../src/world/world-model.js";

/** Feb 29 on a non-leap year — never fires on its own, so only trigger() runs the job. */
const NEVER = "0 0 29 2 *";

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "improvement-scout",
    enabled: true,
    trigger: { type: "cron", schedule: NEVER, timezone: "UTC" },
    ...overrides,
  } as unknown as AgentDef;
}

function strategyWith(allocation: Strategy["allocation"]): Strategy {
  return {
    writtenAt: "2026-09-01T05:00:00.000Z",
    intent: "test",
    allocation,
    expectations: [],
    changeReason: "",
  };
}

describe("startCron", () => {
  it("passes the world model summary as promptContext to a cron-triggered agent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
    const world = new WorldModel(dataDir);
    const strategyStore = new StrategyStore(dataDir);
    await world.upsertPortfolioEntry({
      slug: "widget-api",
      purpose: "Paid API for widget conversion",
      status: "live",
      nextReviewAt: "2026-10-01",
      bar: "at least one paying customer",
      monthlyCostUsd: 12,
      notes: ["2026-09-01: launched"],
      extensionCount: 0,
    });

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;

    const jobs = startCron([agent()], orchestrator, world, strategyStore);
    try {
      await jobs[0]!.trigger();
      const [, , promptContext] = executeRun.mock.calls[0]!;
      expect(promptContext).toContain("widget-api");
    } finally {
      for (const job of jobs) job.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  describe("allocation gating", () => {
    it("skips a firing whose category has zero allocation in the latest strategy", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = new StrategyStore(dataDir);
      await strategyStore.write(strategyWith({ research: 0, build: 100, maintain: 0 }));

      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;

      const jobs = startCron([agent({ category: "research" })], orchestrator, world, strategyStore);
      try {
        await jobs[0]!.trigger();
        expect(executeRun).not.toHaveBeenCalled();
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("runs when its category has non-zero allocation in the latest strategy", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = new StrategyStore(dataDir);
      await strategyStore.write(strategyWith({ research: 0, build: 100, maintain: 0 }));

      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;

      const jobs = startCron([agent({ category: "build" })], orchestrator, world, strategyStore);
      try {
        await jobs[0]!.trigger();
        expect(executeRun).toHaveBeenCalledTimes(1);
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("always runs an agent with no category, whatever the allocation says", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = new StrategyStore(dataDir);
      await strategyStore.write(strategyWith({ research: 0, build: 0, maintain: 100 }));

      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;

      const jobs = startCron([agent()], orchestrator, world, strategyStore);
      try {
        await jobs[0]!.trigger();
        expect(executeRun).toHaveBeenCalledTimes(1);
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("runs when no strategy has been written yet (fail open)", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = new StrategyStore(dataDir);

      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;

      const jobs = startCron([agent({ category: "research" })], orchestrator, world, strategyStore);
      try {
        await jobs[0]!.trigger();
        expect(executeRun).toHaveBeenCalledTimes(1);
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("runs when the strategy store is unreadable (fail open)", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = {
        latest: vi.fn().mockRejectedValue(new Error("disk read failed")),
      } as unknown as StrategyStore;

      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;

      const jobs = startCron([agent({ category: "research" })], orchestrator, world, strategyStore);
      try {
        await jobs[0]!.trigger();
        expect(executeRun).toHaveBeenCalledTimes(1);
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });
});
