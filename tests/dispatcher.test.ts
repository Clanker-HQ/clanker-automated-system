import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MemoryConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { Dispatcher, runDispatchTick } from "../src/control/dispatcher.js";
import { FakeRouter } from "../src/control/router.js";
import { TaskStore } from "../src/control/task-store.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { loadRegistry } from "../src/registry.js";
import type { AgentDef } from "../src/registry.js";
import type { RunResult } from "../src/run-store.js";
import { WorldModel } from "../src/world/world-model.js";

function memoryConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true, retentionDays: 90, reflectionRetentionDays: 365,
    similarityThreshold: 0.75, stalenessDays: 30, recencyHalfLifeDays: 14,
    maxChainDepth: 3, maxAgentTasksPerDay: 20,
    weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
    reflectionSchedule: "0 3 * * 1", reflectionTimezone: "UTC", reflectionWindowDays: 14,
    ...overrides,
  };
}

function taskStore(): { tasks: TaskStore; dataDir: string; world: WorldModel } {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-dispatcher-"));
  return { tasks: new TaskStore(dataDir), dataDir, world: new WorldModel(dataDir) };
}

function specialist(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "research",
    enabled: true,
    description: "researches things",
    trigger: { type: "dispatched" },
    run: { model: "claude-sonnet-5", effort: "low", maxTurns: 24, timeoutMinutes: 20, maxBudgetUsd: 2 },
    ...overrides,
  } as unknown as AgentDef;
}

function successResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "research-1",
    agent: "research",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60000,
    costUsd: 0.01,
    inputTokens: 10,
    outputTokens: 20,
    turns: 1,
    summary: "Found three ideas.",
    ...overrides,
  };
}

describe("runDispatchTick", () => {
  it("does nothing and reports ran:false when the queue is empty", async () => {
    const { tasks, dataDir, world } = taskStore();
    const result = await runDispatchTick({
      tasks, router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun: vi.fn() }, notify: vi.fn(), dataDir, world,
    });
    expect(result).toEqual({ ran: false });
  });

  it("routes a pending task, runs it, and marks it done on success", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const result = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(result).toEqual({ ran: true, taskId: task.id });
    expect(executeRun).toHaveBeenCalledWith(specialist(), expect.any(Date), expect.stringContaining("find a profitable niche"), expect.any(Function));
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.specialistAgent).toBe("research");
    expect(updated?.result).toEqual({ summary: "Found three ideas.", path: join(dataDir, "runs", "research-1") });
  });

  it("appends a detail instruction to the prompt when the task wants a detailed summary", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner", wantsDetail: true });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    const [, , promptContext] = executeRun.mock.calls[0]!;
    expect(promptContext).toContain("find a profitable niche");
    expect(promptContext).toContain("more detail");
    expect(promptContext).toContain("Discord doesn't render markdown tables");
  });

  it("appends the world model summary to the prompt, under its own heading", async () => {
    const { tasks, dataDir, world } = taskStore();
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
    await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    const [, , promptContext] = executeRun.mock.calls[0]!;
    expect(promptContext).toContain("widget-api");
  });

  it("retries once, silently, before failing a task whose run doesn't succeed", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const notify = vi.fn().mockResolvedValue(undefined);
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir, world,
    });
    // deferred: true, same as a governor refusal, so Dispatcher.wake()'s drain
    // doesn't hammer the same transient failure back-to-back.
    expect(outcome).toEqual({ ran: true, taskId: task.id, deferred: true });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("pending");
    expect(updated?.retryCount).toBe(1);
    expect(updated?.finishedAt).toBeUndefined();
    // Silent: the owner isn't bothered for a failure that might not recur.
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks the task failed, with the run's own error, once all 3 retries are exhausted", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 3 });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(outcome).toEqual({ ran: true, taskId: task.id });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("boom");
  });

  for (const status of ["denied", "timeout"] as const) {
    it(`fails the task immediately, on the very first attempt, when the run ends "${status}" (a deterministic outcome backoff can't fix)`, async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(successResult({ status, error: `${status} reason` }));
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir, world,
      });
      // Not deferred: this is a terminal failure on attempt 1, not a backoff retry.
      expect(outcome).toEqual({ ran: true, taskId: task.id });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.retryCount ?? 0).toBe(0);
      expect(updated?.nextRetryAt).toBeUndefined();
      expect(updated?.failureReason).toBe(`${status} reason`);
      expect(updated?.finishedAt).toBeDefined();
      // Unlike a transient failure's silent retry, the owner is told right away.
      expect(notify).toHaveBeenCalledTimes(1);
      const text = notify.mock.calls[0]![0] as string;
      expect(text).toContain(task.id);
      expect(text).toContain(`${status} reason`);
    });
  }

  it("backs off for 1 minute, keeping the task pending, after the first failure", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const notify = vi.fn().mockResolvedValue(undefined);
    const now = () => new Date("2026-08-28T00:00:00.000Z");
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir, world, now,
    });
    expect(outcome).toEqual({ ran: true, taskId: task.id, deferred: true });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("pending");
    expect(updated?.retryCount).toBe(1);
    expect(updated?.nextRetryAt).toBe("2026-08-28T00:01:00.000Z");
    expect(updated?.finishedAt).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("backs off for 5 minutes on the second failure, and 15 minutes on the third", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 1 });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const now = () => new Date("2026-08-28T00:00:00.000Z");

    const second = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, now,
    });
    expect(second).toEqual({ ran: true, taskId: task.id, deferred: true });
    expect((await tasks.get(task.id))?.retryCount).toBe(2);
    expect((await tasks.get(task.id))?.nextRetryAt).toBe("2026-08-28T00:05:00.000Z");

    // Simulate the backoff window having passed so this task is claimable again.
    await tasks.update(task.id, { nextRetryAt: undefined });
    const third = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, now,
    });
    expect(third).toEqual({ ran: true, taskId: task.id, deferred: true });
    expect((await tasks.get(task.id))?.retryCount).toBe(3);
    expect((await tasks.get(task.id))?.nextRetryAt).toBe("2026-08-28T00:15:00.000Z");
  });

  describe("retrying a run graded not-achieved", () => {
    it("retries once, silently, before accepting a task whose run was graded not-achieved", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ verifiedOutcome: { verdict: "not-achieved", reason: "only checked one option" } }),
      );
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir, world,
      });
      // Same posture as a real failure's retry: deferred, not yet notified.
      expect(outcome).toEqual({ ran: true, taskId: task.id, deferred: true });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("pending");
      expect(updated?.retryCount).toBe(1);
      expect(updated?.finishedAt).toBeUndefined();
      expect(updated?.lastVerificationReason).toBe("only checked one option");
      expect(notify).not.toHaveBeenCalled();
    });

    it("marks the task done, with a warning (not a plain ✅), once all 3 retries are still graded not-achieved", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      await tasks.update(task.id, { retryCount: 3 });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ summary: "Picked an option.", verifiedOutcome: { verdict: "not-achieved", reason: "still wrong" } }),
      );
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir, world,
      });
      expect(outcome).toEqual({ ran: true, taskId: task.id });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("done");
      expect(updated?.result?.summary).toBe("Picked an option.");
      expect(notify).toHaveBeenCalledTimes(1);
      const text = notify.mock.calls[0]![0] as string;
      expect(text).toContain("⚠️");
      expect(text).toContain(task.id);
      expect(text).toContain("still wrong");
    });

    it("threads the verifier's reason from the previous attempt into the retry's prompt", async () => {
      const { tasks, dataDir, world } = taskStore();
      await tasks.create({ text: "find providers", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValueOnce(
        successResult({ verifiedOutcome: { verdict: "not-achieved", reason: "only looked at named examples" } }),
      );
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
      });

      // Simulate the backoff window having passed so this task is claimable again.
      const [task] = await tasks.list();
      await tasks.update(task!.id, { nextRetryAt: undefined });
      const secondExecuteRun = vi.fn().mockResolvedValue(successResult({ verifiedOutcome: { verdict: "achieved", reason: "fine" } }));
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun: secondExecuteRun }, notify: vi.fn(), dataDir, world,
      });

      const [, , promptContext] = secondExecuteRun.mock.calls[0]!;
      expect(promptContext).toContain("find providers");
      expect(promptContext).toContain("only looked at named examples");
    });

    it("marks the task done normally, with no retry, when the run is graded achieved", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ verifiedOutcome: { verdict: "achieved", reason: "did it" } }),
      );
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir, world,
      });
      expect(outcome).toEqual({ ran: true, taskId: task.id });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("done");
      expect(updated?.retryCount ?? 0).toBe(0);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0] as string).toContain("✅");
    });

    it("marks the task done normally when no verification was ever attached to the result", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(successResult());
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
      });
      expect(outcome).toEqual({ ran: true, taskId: task.id });
      expect((await tasks.get(task.id))?.status).toBe("done");
    });

    it("accumulates cost across not-achieved retries on the task record", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ costUsd: 1.2, verifiedOutcome: { verdict: "not-achieved", reason: "only one option" } }),
      );
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
      });
      expect((await tasks.get(task.id))?.spentUsd).toBe(1.2);
    });

    it("stops retrying once cumulative spend across attempts reaches 2x the run's own budget, even with retries remaining", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      // Attempt 1 already spent $3.5 of this agent's $2 budget (a long research
      // run) and was graded not-achieved -- simulate having just retried once.
      await tasks.update(task.id, { retryCount: 1, spentUsd: 3.5 });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ costUsd: 1, summary: "Partial.", verifiedOutcome: { verdict: "not-achieved", reason: "still incomplete" } }),
      );
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir, world,
      });
      // Not deferred: this task's spend is accepted as done, not queued for
      // another attempt, even though retryCount (1) is well under MAX_RETRIES (3).
      expect(outcome).toEqual({ ran: true, taskId: task.id });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("done");
      expect(updated?.result?.summary).toBe("Partial.");
      expect(notify).toHaveBeenCalledTimes(1);
      const text = notify.mock.calls[0]![0] as string;
      expect(text).toContain("⚠️");
      expect(text).toContain("retry cap");
      expect(text).toContain("still incomplete");
    });

    it("keeps retrying below the cost cap even after a prior expensive not-achieved attempt", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      await tasks.update(task.id, { retryCount: 1, spentUsd: 1 });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ costUsd: 1, verifiedOutcome: { verdict: "not-achieved", reason: "still incomplete" } }),
      );
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
      });
      // $1 (prior) + $1 (this run) = $2, under the $4 cap (2x the $2 budget) --
      // still retries normally.
      expect(outcome).toEqual({ ran: true, taskId: task.id, deferred: true });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("pending");
      expect(updated?.retryCount).toBe(2);
      expect(updated?.spentUsd).toBe(2);
    });
  });

  it("puts the task back to pending, reports deferred, and keeps its routing, when the governor refuses admission", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir, world,
    });
    expect(outcome).toEqual({ ran: true, taskId: task.id, deferred: true });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("pending");
    // The routing decision survives the refusal, so the retry costs no second
    // router call — see the "does not re-route" test below.
    expect(updated?.specialistAgent).toBe("research");
    expect(updated?.finishedAt).toBeUndefined();
    // Deliberately no per-retry Discord notification: over a 12-hour quiet-hours
    // window that would be pure spam. `!tasks` is how a deferred task stays visible.
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not call the router again for a task already routed by an earlier deferred attempt", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { specialistAgent: "research" });
    const router = new FakeRouter("research");
    const executeRun = vi.fn().mockResolvedValue(successResult());
    await runDispatchTick({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(router.calls).toHaveLength(0);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect((await tasks.get(task.id))?.status).toBe("done");
  });

  it("persists the routing decision before attempting admission, so a refusal on the first attempt still caches it", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const router = new FakeRouter("research");
    // First attempt: routed, then refused.
    await runDispatchTick({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(undefined) }, notify: vi.fn(), dataDir, world,
    });
    expect(router.calls).toHaveLength(1);
    // Second attempt: admitted. The router must not be consulted a second time.
    const outcome = await runDispatchTick({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify: vi.fn(), dataDir, world,
    });
    expect(router.calls).toHaveLength(1);
    expect(outcome.deferred).toBeUndefined();
    expect((await tasks.get(task.id))?.status).toBe("done");
  });

  for (const status of ["parked", "question"] as const) {
    it(`marks the task "waiting", not failed, when the run ends ${status} awaiting a human`, async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(successResult({ status }));
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir, world,
      });
      expect(outcome).toEqual({ ran: true, taskId: task.id });
      const updated = await tasks.get(task.id);
      expect(updated?.status).toBe("waiting");
      // The run is alive and paused, not finished and not failed.
      expect(updated?.failureReason).toBeUndefined();
      expect(updated?.finishedAt).toBeUndefined();
      // Recorded so a later approve/deny/answer can find its way back to this task.
      expect(updated?.runId).toBe("research-1");
      expect(notify).not.toHaveBeenCalled();
    });
  }

  it("notifies with the task id and the run summary on success", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify, dataDir, world,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain(task.id);
    expect(text).toContain("Found three ideas.");
  });

  it("notifies with the task id and the error on a failed run", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries, so this failure actually notifies
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" })) },
      notify, dataDir, world,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain(task.id);
    expect(text).toContain("boom");
  });

  it("fails the task, rather than leaving it stuck running, when the run throws", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockRejectedValue(new Error("prompt.md is missing"));
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    // Not deferred: a thrown error isn't "wait for the governor", so the drain continues.
    expect(outcome).toEqual({ ran: true, taskId: task.id });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("prompt.md is missing");
  });

  // A notify() rejection is not an exotic case: DiscordOutbox.webhookFor throws
  // on EVERY call when a channel key is missing from config.yaml or its env var
  // is unset. The task file is the durable record of what happened; a failure to
  // announce it in Discord must never rewrite it.
  describe("a notify() rejection never overwrites the task's real outcome", () => {
    it("keeps a successful task done, with its result, when the success notify rejects", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const outcome = await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [specialist()],
          orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify, dataDir, world,
        });
        expect(outcome).toEqual({ ran: true, taskId: task.id });
        const updated = await tasks.get(task.id);
        expect(updated?.status).toBe("done");
        expect(updated?.failureReason).toBeUndefined();
        expect(updated?.result).toEqual({ summary: "Found three ideas.", path: join(dataDir, "runs", "research-1") });
        // Swallowed for the task's sake, but never silently: it is logged.
        expect(errors).toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it("keeps the run's own failureReason when the failure notify rejects", async () => {
      const { tasks, dataDir, world } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [specialist()],
          orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" })) },
          notify, dataDir, world,
        });
        const updated = await tasks.get(task.id);
        expect(updated?.status).toBe("failed");
        // The whole point: "boom" is the only record of what actually went
        // wrong. A Discord misconfiguration must not replace it.
        expect(updated?.failureReason).toBe("boom");
      } finally {
        errors.mockRestore();
      }
    });

    it("keeps the routing-failure reason when that notify rejects", async () => {
      const { tasks, dataDir, world } = taskStore();
      await tasks.create({ text: "x", createdBy: "discord:owner" });
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runDispatchTick({
          tasks, router: new FakeRouter(null), agents: [specialist()],
          orchestrator: { executeRun: vi.fn() }, notify, dataDir, world,
        });
        const [updated] = await tasks.list();
        expect(updated?.status).toBe("failed");
        expect(updated?.failureReason).toContain("no specialist matched");
      } finally {
        errors.mockRestore();
      }
    });

    it("keeps the no-specialists-registered reason when that notify rejects", async () => {
      const { tasks, dataDir, world } = taskStore();
      await tasks.create({ text: "x", createdBy: "discord:owner" });
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [],
          orchestrator: { executeRun: vi.fn() }, notify, dataDir, world,
        });
        const [updated] = await tasks.list();
        expect(updated?.status).toBe("failed");
        expect(updated?.failureReason).toContain("no dispatched specialist");
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("fails the task and notifies, without ever calling executeRun, when no specialist matches", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir, world,
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no specialist matched");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task and notifies when no dispatched specialists are registered at all", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [],
      orchestrator: { executeRun: vi.fn() }, notify, dataDir, world,
    });
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no dispatched specialist");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task when the router names an agent that isn't a registered dispatched specialist", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    await runDispatchTick({
      tasks, router: new FakeRouter("some-other-agent"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("some-other-agent");
  });

  describe("records outcomes to memory", () => {
    it("records an outcome record when a task completes successfully", async () => {
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      const task = await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ verifiedOutcome: { verdict: "achieved", reason: "did it" } }),
      );
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, memory,
      });
      const records = await memory.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.kind).toBe("outcome");
      expect(records[0]?.verdict).toBe("achieved");
      expect(records[0]?.sourceTaskId).toBe(task.id);
    });

    it("records the outcome under the domain its own proposal was queued with, not the specialist's name", async () => {
      // The whole point of `domain`: the novelty gate and retrieval both match
      // it as an exact string, so an outcome filed under the executing
      // specialist's name ("research") could never be found by a later
      // proposal in the topic it actually came from ("dependencies") — the
      // duplicate would sail through the gate and the context would never be
      // retrieved.
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      const task = await tasks.create({ text: "bump the vulnerable lodash", createdBy: "agent:dependency-scout" });
      await memory.append({
        domain: "dependencies", kind: "proposal", subject: "bump the vulnerable lodash",
        body: "bump the vulnerable lodash", importance: 5, createdBy: "agent:dependency-scout",
        sourceTaskId: task.id,
      });
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) },
        notify: vi.fn(), dataDir, world, memory, memoryConfig: memoryConfig(),
      });
      const outcome = (await memory.list()).find((r) => r.kind === "outcome");
      expect(outcome?.domain).toBe("dependencies");
    });

    it("falls back to the specialist's name for a human task, which has no proposal record", async () => {
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) },
        notify: vi.fn(), dataDir, world, memory, memoryConfig: memoryConfig(),
      });
      const outcome = (await memory.list()).find((r) => r.kind === "outcome");
      expect(outcome?.domain).toBe("research");
    });

    it("writes nothing at all when memory is explicitly disabled in config", async () => {
      // Retention only prunes memory while `enabled` is true, so an appending
      // dispatcher with the flag off would grow an unread log forever.
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      await tasks.create({ text: "x", createdBy: "discord:owner" });
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) },
        notify: vi.fn(), dataDir, world, memory, memoryConfig: memoryConfig({ enabled: false }),
      });
      expect(await memory.list()).toEqual([]);
    });

    it("records a not-achieved verdict on a task that exhausts its retries", async () => {
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      await tasks.update(task.id, { retryCount: 3 });
      const executeRun = vi.fn().mockResolvedValue(
        successResult({ verifiedOutcome: { verdict: "not-achieved", reason: "still wrong" } }),
      );
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, memory,
      });
      const records = await memory.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.verdict).toBe("not-achieved");
      expect(records[0]?.body).toBe("still wrong");
      expect(records[0]?.sourceTaskId).toBe(task.id);
    });

    it("records a failed task's reason", async () => {
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries, so this failure is terminal
      const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, memory,
      });
      const records = await memory.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.verdict).toBe("not-achieved");
      expect(records[0]?.body).toContain("boom");
      expect(records[0]?.sourceTaskId).toBe(task.id);
    });

    it("writes no outcome record for a task that merely deferred", async () => {
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(undefined); // governor refusal
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, memory,
      });
      expect(await memory.list()).toEqual([]);
    });

    it("reads the completed task's OWN chain depth (not its parent's) before attempting successors", async () => {
      // Regression test for the bug fixed before this task's brief was
      // dispatched: looking up depth via task.parentId instead of task.id
      // fetches the PARENT's depth (one level too shallow), silently
      // widening the intended depth cap every generation past the first. A
      // proposal record at chainDepth: 2, keyed to THIS task's own id, is
      // well under the default maxChainDepth of 3 (2 < 3), so the suggester
      // must be called — if the depth were misread back as 0 (or any other
      // wrong value that still happens to be < 3), this test would not
      // distinguish that from a correct read of 2. What actually proves the
      // depth was read correctly is the chainDepth written to the NEXT
      // proposal record below: it must be 3 (parentDepth 2 + 1), a value
      // only reachable if 2 was really the number that came back.
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      const task = await tasks.create({ text: "second-generation work", createdBy: "agent:research" });
      await memory.append({
        domain: "research", kind: "proposal", subject: "second-generation work",
        body: "second-generation work", importance: 5, createdBy: "agent:research",
        sourceTaskId: task.id, chainDepth: 2,
      });
      const suggest = vi.fn(async () => [
        { text: "next step", domain: "research", subject: "next step", importance: 5, goalAlignment: 0.5 },
      ]);
      const executeRun = vi.fn().mockResolvedValue(successResult());
      await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify: vi.fn(), dataDir, world, memory,
        memoryConfig: {
          enabled: true, retentionDays: 90, reflectionRetentionDays: 365,
          similarityThreshold: 0.75, stalenessDays: 30, recencyHalfLifeDays: 14,
          maxChainDepth: 3, maxAgentTasksPerDay: 20,
          weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
          reflectionSchedule: "0 3 * * 1", reflectionTimezone: "UTC", reflectionWindowDays: 14,
        },
        suggestSuccessors: suggest,
      });
      expect(suggest).toHaveBeenCalledTimes(1);
      const records = await memory.list();
      const successorProposal = records.find((r) => r.kind === "proposal" && r.subject === "next step");
      expect(successorProposal?.chainDepth).toBe(3);
    });

    it("does not fail the task when the memory append throws", async () => {
      const { tasks, dataDir, world } = taskStore();
      const memory = new MemoryStore(dataDir);
      const appendSpy = vi.spyOn(memory, "append").mockRejectedValue(new Error("disk full"));
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const outcome = await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [specialist()],
          orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify: vi.fn(), dataDir, world, memory,
        });
        expect(outcome).toEqual({ ran: true, taskId: task.id });
        const updated = await tasks.get(task.id);
        expect(updated?.status).toBe("done");
        expect(updated?.failureReason).toBeUndefined();
        expect(updated?.result).toEqual({ summary: "Found three ideas.", path: join(dataDir, "runs", "research-1") });
        // Swallowed for the task's sake, but never silently: it is logged.
        expect(errors).toHaveBeenCalled();
      } finally {
        errors.mockRestore();
        appendSpy.mockRestore();
      }
    });
  });
});

describe("Dispatcher.wake", () => {
  it("drains every pending task in one wake() call, not just one", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    const remaining = (await tasks.list()).filter((t) => t.status === "pending" || t.status === "running");
    expect(remaining).toEqual([]);
  });

  it("attempts every task once even when the governor refuses every one of them, deferring each rather than hot-looping", async () => {
    // Regression test: with the old `while (outcome.ran)` sequential drain,
    // this looped forever on ONE task — nextPending() returns the same
    // refused task, it is re-routed (a real, unbudgeted LLM call in
    // production) and refused again, for as long as the refusal lasts. A
    // 12-hour quiet-hours window made that a 12-hour hot loop. Now that
    // claiming excludes a just-deferred task for the rest of this wake()
    // call, a refusal on one task no longer prevents a genuinely different
    // task from getting its own attempt too — both get tried exactly once.
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const router = new FakeRouter("research");
    const dispatcher = new Dispatcher({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    expect(router.calls).toHaveLength(2);
    // Both tasks are still queued for a later tick — neither is lost.
    expect((await tasks.list()).filter((t) => t.status === "pending")).toHaveLength(2);
  });

  it("does not re-attempt a single task again within the same wake() call once it's deferred", async () => {
    // The actual hot-loop guard: a lone task that gets refused/auto-retried
    // must not be reclaimed again and again in the same drain — nextPending()
    // would just hand it right back forever.
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "a", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect((await tasks.get(task.id))?.status).toBe("pending");
  });

  it("attempts two tasks that both silently auto-retry once each, rather than hammering either one", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    // Both tasks are still queued for a later tick — the retried ones aren't
    // hammered again immediately.
    expect((await tasks.list()).filter((t) => t.status === "pending")).toHaveLength(2);
  });

  it("processes multiple pending tasks concurrently rather than one at a time", async () => {
    // The whole point of this change: previously Dispatcher.wake() awaited
    // one task's ENTIRE run (up to hours long) before even looking at the
    // next pending task. If that were still true, executeRun would only have
    // been called once at the checkpoint below, since the first call's
    // promise deliberately never resolves until this test resolves it.
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const resolvers: Array<(r: RunResult) => void> = [];
    const executeRun = vi.fn().mockImplementation(
      // Mirrors the real Orchestrator.executeRun contract: onAdmitted fires
      // once admission succeeds, awaited, BEFORE the run itself starts — see
      // TaskStore's "queued" (claimed, no slot yet) vs "running" (admitted,
      // actually executing). A fake that ignored the callback would leave
      // every task "queued" forever and prove nothing about the transition.
      async (
        _agent: AgentDef,
        _now?: Date,
        _promptContext?: string,
        onAdmitted?: () => void | Promise<void>,
      ) => {
        await onAdmitted?.();
        return new Promise<RunResult>((resolve) => resolvers.push(resolve));
      },
    );
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    const wakePromise = dispatcher.wake();
    // Poll rather than trust a fixed delay: claiming goes through real
    // (temp-dir) disk I/O, which can take longer than a single event-loop
    // tick, especially under the load of the full suite running in parallel —
    // and now so does the queued -> running write onAdmitted triggers.
    await vi.waitFor(async () => {
      expect(executeRun).toHaveBeenCalledTimes(2);
      expect((await tasks.list()).map((t) => t.status).sort()).toEqual(["running", "running"]);
    });

    resolvers.forEach((resolve) => resolve(successResult()));
    await wakePromise;
    expect((await tasks.list()).map((t) => t.status)).toEqual(["done", "done"]);
  });

  // Reproduces exactly what was reported: three tasks claimed at once while
  // the Governor only had room to admit one. `!tasks`/`!status` showed all
  // three as "running" — this is the fix, at the layer the bug actually
  // lived in (Dispatcher passing onAdmitted through to a fake standing in
  // for the real Governor-gated Orchestrator), not just in TaskStore/
  // Orchestrator unit tests in isolation.
  it("shows only the admitted task as running while the rest stay queued behind it", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    await tasks.create({ text: "c", createdBy: "discord:owner" });

    let admittedCount = 0;
    const resolvers: Array<(r: RunResult) => void> = [];
    const executeRun = vi.fn().mockImplementation(
      async (
        _agent: AgentDef,
        _now?: Date,
        _promptContext?: string,
        onAdmitted?: () => void | Promise<void>,
      ) => {
        // Simulates Governor maxConcurrent: 1 — only the first claim ever
        // gets admitted; the other two never call onAdmitted at all, exactly
        // as a real admit() blocked in acquireSlot never does until a slot
        // frees.
        admittedCount += 1;
        if (admittedCount === 1) await onAdmitted?.();
        return new Promise<RunResult>((resolve) => resolvers.push(resolve));
      },
    );
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });

    const wakePromise = dispatcher.wake();
    await vi.waitFor(async () => {
      expect(executeRun).toHaveBeenCalledTimes(3);
      expect((await tasks.list()).map((t) => t.status).sort()).toEqual(["queued", "queued", "running"]);
    });

    resolvers.forEach((resolve) => resolve(successResult()));
    await wakePromise;
  });

  it("keeps draining past a task that threw — a thrown error is not a deferral", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner", priority: 90 });
    await tasks.create({ text: "b", createdBy: "discord:owner", priority: 10 });
    const executeRun = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(successResult());
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    const statuses = (await tasks.list()).map((t) => t.status).sort();
    expect(statuses).toEqual(["done", "failed"]);
  });

  it("a re-entrant wake() call while draining is a no-op, not a second concurrent drain", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    let resolveRun!: (r: RunResult) => void;
    const executeRun = vi.fn().mockReturnValue(new Promise<RunResult>((resolve) => { resolveRun = resolve; }));
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    const firstWake = dispatcher.wake();
    const secondWake = dispatcher.wake();
    resolveRun(successResult());
    await Promise.all([firstWake, secondWake]);
    expect(executeRun).toHaveBeenCalledTimes(1);
  });
});

describe("repair agent routing (Task C6)", () => {
  // End-to-end against the REAL registry (see builder-agent-registration.test.ts
  // for the same pattern): this is the test that actually proves routing
  // reaches agents/repair, not just that dispatcher.ts's existing generic
  // routing *would* work for some in-memory fixture. Before agents/repair
  // exists this fails the same way "fails the task when the router names an
  // agent that isn't a registered dispatched specialist" (above) does — the
  // router choosing a name nothing has registered.
  it("dispatches a repair-shaped task to the real repair agent, end to end", async () => {
    const { tasks, dataDir, world } = taskStore();
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });
    const task = await tasks.create({
      text: "builder's last three runs all failed the same way; diagnose and fix it",
      createdBy: "discord:owner",
    });
    const executeRun = vi.fn().mockResolvedValue(successResult({ agent: "repair", runId: "repair-1", summary: "Fixed it." }));
    const result = await runDispatchTick({
      tasks, router: new FakeRouter("repair"), agents,
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(result).toEqual({ ran: true, taskId: task.id });
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({ name: "repair" }),
      expect.any(Date),
      expect.stringContaining("diagnose and fix it"),
      expect.any(Function),
    );
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.specialistAgent).toBe("repair");
  });

  // specialistsOf (router.ts) filters candidates on AgentDef.enabled — the
  // static agent.yaml flag, the only lever it has. A disabled agent is
  // therefore never even offered to the router, so it structurally cannot be
  // chosen, regardless of what the router itself might have picked.
  it("never offers a disabled agent to the router, so a repair task cannot land back on a disabled builder", async () => {
    const { tasks, dataDir, world } = taskStore();
    await tasks.create({ text: "builder is broken, fix it", createdBy: "discord:owner" });
    const router = new FakeRouter("repair");
    const executeRun = vi.fn().mockResolvedValue(successResult({ agent: "repair", runId: "repair-1" }));
    const builder = specialist({ name: "builder", enabled: false, description: "implements features" });
    const repair = specialist({ name: "repair", description: "repairs the system's own broken agents and infrastructure" });
    await runDispatchTick({
      tasks, router, agents: [builder, repair],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(router.calls[0]?.specialists).toEqual([{ name: "repair", description: repair.description }]);
    expect(executeRun).toHaveBeenCalledWith(repair, expect.any(Date), expect.any(String), expect.any(Function));
  });

  // Symmetric check: repair's mere presence in the registry must not hijack
  // ordinary feature work toward it — dispatcher.ts has no special-casing by
  // agent name, so whichever name the router returns is what runs.
  it("still routes an ordinary feature request to builder when repair is also registered", async () => {
    const { tasks, dataDir, world } = taskStore();
    const task = await tasks.create({ text: "add a rate-limit header to the widget API", createdBy: "discord:owner" });
    const router = new FakeRouter("builder");
    const executeRun = vi.fn().mockResolvedValue(successResult({ agent: "builder", runId: "builder-1" }));
    const builder = specialist({ name: "builder", description: "implements features" });
    const repair = specialist({ name: "repair", description: "repairs the system's own broken agents and infrastructure" });
    await runDispatchTick({
      tasks, router, agents: [builder, repair],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, world,
    });
    expect(executeRun).toHaveBeenCalledWith(builder, expect.any(Date), expect.any(String), expect.any(Function));
    const updated = await tasks.get(task.id);
    expect(updated?.specialistAgent).toBe("builder");
  });
});
