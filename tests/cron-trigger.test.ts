import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";
import { describe, expect, it, vi } from "vitest";
import type { Orchestrator } from "../src/orchestrator.js";
import type { AgentDef } from "../src/registry.js";
import type { RunResult, RunStore } from "../src/run-store.js";
import { catchUpIfMissed, limitRetryAt, missedFireAt, runCronFiring, startCron } from "../src/triggers/cron.js";
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

  describe("catch-up after downtime", () => {
    // Monday 09:00 UTC -- `now` below is a Tuesday, so previousRuns(1, now)
    // always resolves to the same Monday regardless of when this test itself
    // actually runs.
    const WEEKLY = "0 9 * * 1";
    const now = new Date("2026-09-08T05:00:00.000Z");

    it("missedFireAt is null once the agent already ran at or after the most recent scheduled fire", () => {
      const job = new Cron(WEEKLY, { timezone: "UTC" });
      const due = job.previousRuns(1, now)[0]!;
      try {
        expect(missedFireAt(job, due, now)).toBeNull();
      } finally {
        job.stop();
      }
    });

    it("missedFireAt returns the missed time when the last run predates the most recent scheduled fire", () => {
      const job = new Cron(WEEKLY, { timezone: "UTC" });
      const due = job.previousRuns(1, now)[0]!;
      try {
        expect(missedFireAt(job, new Date(due.getTime() - 1000), now)).toEqual(due);
      } finally {
        job.stop();
      }
    });

    it("missedFireAt treats a never-run agent as having missed its fire (fail open)", () => {
      const job = new Cron(WEEKLY, { timezone: "UTC" });
      try {
        expect(missedFireAt(job, null, now)).not.toBeNull();
      } finally {
        job.stop();
      }
    });

    it("missedFireAt is null for a schedule with no fire in the past", () => {
      const job = new Cron(NEVER, { timezone: "UTC" });
      try {
        expect(missedFireAt(job, null, now)).toBeNull();
      } finally {
        job.stop();
      }
    });

    it("catchUpIfMissed triggers the job when the process was down through its scheduled fire", async () => {
      let ran = false;
      const job = new Cron(WEEKLY, { timezone: "UTC" }, async () => { ran = true; });
      const runStore = { latestFor: vi.fn().mockResolvedValue(null) } as unknown as RunStore;
      try {
        await catchUpIfMissed(agent(), job, runStore, now);
        expect(ran).toBe(true);
      } finally {
        job.stop();
      }
    });

    it("catchUpIfMissed does nothing once the agent already ran after its most recent scheduled fire", async () => {
      let ran = false;
      const job = new Cron(WEEKLY, { timezone: "UTC" }, async () => { ran = true; });
      const due = job.previousRuns(1, now)[0]!;
      const runStore = {
        latestFor: vi.fn().mockResolvedValue({ startedAt: new Date(due.getTime() + 1000).toISOString() }),
      } as unknown as RunStore;
      try {
        await catchUpIfMissed(agent(), job, runStore, now);
        expect(ran).toBe(false);
      } finally {
        job.stop();
      }
    });

    it("startCron catches up a missed fire at boot when given a runStore", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = new StrategyStore(dataDir);
      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;
      const runStore = { latestFor: vi.fn().mockResolvedValue(null) } as unknown as RunStore;

      const jobs = startCron(
        [agent({ trigger: { type: "cron", schedule: WEEKLY, timezone: "UTC" } })],
        orchestrator,
        world,
        strategyStore,
        runStore,
      );
      try {
        // catchUpIfMissed is fire-and-forget from startCron's side (matches
        // production, where index.ts doesn't await it either) and its own
        // chain crosses several real fs reads (strategyStore, world model),
        // so poll rather than assume a fixed number of ticks is enough.
        await vi.waitFor(() => expect(executeRun).toHaveBeenCalledTimes(1));
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("startCron does not catch up when no runStore is given", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
      const world = new WorldModel(dataDir);
      const strategyStore = new StrategyStore(dataDir);
      const executeRun = vi.fn().mockResolvedValue(undefined);
      const orchestrator = { executeRun } as unknown as Orchestrator;

      const jobs = startCron(
        [agent({ trigger: { type: "cron", schedule: WEEKLY, timezone: "UTC" } })],
        orchestrator,
        world,
        strategyStore,
      );
      try {
        // Give any (erroneous) catch-up chain the same runway the positive
        // test above needs, then confirm it never fired.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(executeRun).not.toHaveBeenCalled();
      } finally {
        for (const job of jobs) job.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });
});

// A cron agent that collides with a subscription limit used to lose its slot
// outright: improvement-scout fires once a day at 13:00, hit its session
// limit on 2026-09-08, and nothing ever re-ran it — catchUpIfMissed sees the
// failed run's own startedAt and concludes the fire was not missed. Not being
// disabled for the collision is only half a fix; the run still has to happen.
describe("limit-aware retry", () => {
  const NOW = new Date("2026-09-08T11:00:00.000Z");
  const SESSION_LIMIT =
    "Claude Code returned an error result: You've hit your session limit \u00b7 resets 1:20pm (Europe/Bratislava)";

  function result(overrides: Partial<RunResult> = {}): RunResult {
    return { status: "interrupted", error: SESSION_LIMIT, ...overrides } as RunResult;
  }

  const rejectedGovernor = (resetsAt: number | null) => ({
    status: async () => ({ rateLimitStatus: "rejected" as const, rateLimitResetsAt: resetsAt }),
  });

  it("retries just after the reset instant the run's own error named", async () => {
    const at = await limitRetryAt(result(), undefined, NOW);
    // 1:20pm Europe/Bratislava (UTC+2 in September) is 11:20 UTC, plus grace.
    expect(at?.toISOString()).toBe("2026-09-08T11:21:00.000Z");
  });

  it("does not retry a genuine failure", async () => {
    const failure = result({ status: "failed", error: "Reached maximum number of turns (30)" });
    expect(await limitRetryAt(failure, rejectedGovernor(null), NOW)).toBeNull();
  });

  it("does not retry a successful run", async () => {
    expect(await limitRetryAt(result({ status: "success", error: undefined }), undefined, NOW)).toBeNull();
  });

  it("falls back to the governor's reset instant when the run was refused before it ever started", async () => {
    const resetsAt = Math.floor(new Date("2026-09-08T11:20:00.000Z").getTime() / 1000);
    const at = await limitRetryAt(undefined, rejectedGovernor(resetsAt), NOW);
    expect(at?.toISOString()).toBe("2026-09-08T11:21:00.000Z");
  });

  it("does not retry a refusal that was nothing to do with a limit", async () => {
    const quietHours = { status: async () => ({ rateLimitStatus: null, rateLimitResetsAt: null }) };
    expect(await limitRetryAt(undefined, quietHours, NOW)).toBeNull();
  });

  // Bounded like the governor's own hold: a reset further out than any real
  // window is a parsing slip or a clock skew, and a cron agent that would
  // rather wait for its next scheduled fire than sit on a day-long timer.
  it("declines to schedule a retry further out than any real window", async () => {
    const resetsAt = Math.floor(new Date("2026-09-15T11:00:00.000Z").getTime() / 1000);
    expect(await limitRetryAt(undefined, rejectedGovernor(resetsAt), NOW)).toBeNull();
  });

  it("re-runs the agent when the scheduled retry fires, and stops once it succeeds", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-retry-"));
    const executeRun = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ status: "success", error: undefined }));
    const scheduled: Array<() => void> = [];

    await runCronFiring(agent(), {
      orchestrator: { executeRun } as unknown as Orchestrator,
      world: new WorldModel(dataDir),
      strategyStore: new StrategyStore(dataDir),
      now: () => NOW,
      schedule: (_at, run) => scheduled.push(run),
    });

    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await vi.waitFor(() => expect(executeRun).toHaveBeenCalledTimes(2));
    // The retry succeeded, so nothing further is queued.
    expect(scheduled).toHaveLength(0);
  });

  it("gives up after a bounded number of retries instead of looping on a limit that never clears", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-retry-"));
    const executeRun = vi.fn().mockResolvedValue(result());
    const scheduled: Array<() => void> = [];

    await runCronFiring(agent(), {
      orchestrator: { executeRun } as unknown as Orchestrator,
      world: new WorldModel(dataDir),
      strategyStore: new StrategyStore(dataDir),
      now: () => NOW,
      schedule: (_at, run) => scheduled.push(run),
    });

    for (let i = 0; i < 10 && scheduled.length > 0; i += 1) {
      scheduled.shift()!();
      await vi.waitFor(() => expect(executeRun).toHaveBeenCalledTimes(i + 2));
    }
    // The scheduled fire plus two retries — MAX_LIMIT_ATTEMPTS total, then it
    // waits for tomorrow's fire rather than polling a limit that never clears.
    expect(executeRun).toHaveBeenCalledTimes(3);
    expect(scheduled).toHaveLength(0);
  });
});
