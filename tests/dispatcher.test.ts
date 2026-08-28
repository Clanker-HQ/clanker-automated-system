import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Dispatcher, runDispatchTick } from "../src/control/dispatcher.js";
import { FakeRouter } from "../src/control/router.js";
import { TaskStore } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";
import type { RunResult } from "../src/run-store.js";

function taskStore(): { tasks: TaskStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-dispatcher-"));
  return { tasks: new TaskStore(dataDir), dataDir };
}

function specialist(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "research",
    enabled: true,
    description: "researches things",
    trigger: { type: "dispatched" },
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
    const { tasks, dataDir } = taskStore();
    const result = await runDispatchTick({
      tasks, router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun: vi.fn() }, notify: vi.fn(), dataDir,
    });
    expect(result).toEqual({ ran: false });
  });

  it("routes a pending task, runs it, and marks it done on success", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const result = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    expect(result).toEqual({ ran: true, taskId: task.id });
    expect(executeRun).toHaveBeenCalledWith(specialist(), expect.any(Date), "find a profitable niche");
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.specialistAgent).toBe("research");
    expect(updated?.result).toEqual({ summary: "Found three ideas.", path: join(dataDir, "runs", "research-1") });
  });

  it("appends a detail instruction to the prompt when the task wants a detailed summary", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner", wantsDetail: true });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    const [, , promptContext] = executeRun.mock.calls[0]!;
    expect(promptContext).toContain("find a profitable niche");
    expect(promptContext).toContain("more detail");
    expect(promptContext).toContain("Discord doesn't render markdown tables");
  });

  it("retries once, silently, before failing a task whose run doesn't succeed", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const notify = vi.fn().mockResolvedValue(undefined);
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir,
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
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 3 });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    expect(outcome).toEqual({ ran: true, taskId: task.id });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("boom");
  });

  for (const status of ["denied", "timeout"] as const) {
    it(`fails the task immediately, on the very first attempt, when the run ends "${status}" (a deterministic outcome backoff can't fix)`, async () => {
      const { tasks, dataDir } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(successResult({ status, error: `${status} reason` }));
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir,
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
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const notify = vi.fn().mockResolvedValue(undefined);
    const now = () => new Date("2026-08-28T00:00:00.000Z");
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir, now,
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
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 1 });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const now = () => new Date("2026-08-28T00:00:00.000Z");

    const second = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, now,
    });
    expect(second).toEqual({ ran: true, taskId: task.id, deferred: true });
    expect((await tasks.get(task.id))?.retryCount).toBe(2);
    expect((await tasks.get(task.id))?.nextRetryAt).toBe("2026-08-28T00:05:00.000Z");

    // Simulate the backoff window having passed so this task is claimable again.
    await tasks.update(task.id, { nextRetryAt: undefined });
    const third = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, now,
    });
    expect(third).toEqual({ ran: true, taskId: task.id, deferred: true });
    expect((await tasks.get(task.id))?.retryCount).toBe(3);
    expect((await tasks.get(task.id))?.nextRetryAt).toBe("2026-08-28T00:15:00.000Z");
  });

  it("puts the task back to pending, reports deferred, and keeps its routing, when the governor refuses admission", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir,
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
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { specialistAgent: "research" });
    const router = new FakeRouter("research");
    const executeRun = vi.fn().mockResolvedValue(successResult());
    await runDispatchTick({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    expect(router.calls).toHaveLength(0);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect((await tasks.get(task.id))?.status).toBe("done");
  });

  it("persists the routing decision before attempting admission, so a refusal on the first attempt still caches it", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const router = new FakeRouter("research");
    // First attempt: routed, then refused.
    await runDispatchTick({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(undefined) }, notify: vi.fn(), dataDir,
    });
    expect(router.calls).toHaveLength(1);
    // Second attempt: admitted. The router must not be consulted a second time.
    const outcome = await runDispatchTick({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify: vi.fn(), dataDir,
    });
    expect(router.calls).toHaveLength(1);
    expect(outcome.deferred).toBeUndefined();
    expect((await tasks.get(task.id))?.status).toBe("done");
  });

  for (const status of ["parked", "question"] as const) {
    it(`marks the task "waiting", not failed, when the run ends ${status} awaiting a human`, async () => {
      const { tasks, dataDir } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const executeRun = vi.fn().mockResolvedValue(successResult({ status }));
      const notify = vi.fn().mockResolvedValue(undefined);
      const outcome = await runDispatchTick({
        tasks, router: new FakeRouter("research"), agents: [specialist()],
        orchestrator: { executeRun }, notify, dataDir,
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
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify, dataDir,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain(task.id);
    expect(text).toContain("Found three ideas.");
  });

  it("notifies with the task id and the error on a failed run", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries, so this failure actually notifies
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" })) },
      notify, dataDir,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain(task.id);
    expect(text).toContain("boom");
  });

  it("fails the task, rather than leaving it stuck running, when the run throws", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockRejectedValue(new Error("prompt.md is missing"));
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
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
      const { tasks, dataDir } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const outcome = await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [specialist()],
          orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult()) }, notify, dataDir,
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
      const { tasks, dataDir } = taskStore();
      const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
      await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [specialist()],
          orchestrator: { executeRun: vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" })) },
          notify, dataDir,
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
      const { tasks, dataDir } = taskStore();
      await tasks.create({ text: "x", createdBy: "discord:owner" });
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runDispatchTick({
          tasks, router: new FakeRouter(null), agents: [specialist()],
          orchestrator: { executeRun: vi.fn() }, notify, dataDir,
        });
        const [updated] = await tasks.list();
        expect(updated?.status).toBe("failed");
        expect(updated?.failureReason).toContain("no specialist matched");
      } finally {
        errors.mockRestore();
      }
    });

    it("keeps the no-specialists-registered reason when that notify rejects", async () => {
      const { tasks, dataDir } = taskStore();
      await tasks.create({ text: "x", createdBy: "discord:owner" });
      const notify = vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runDispatchTick({
          tasks, router: new FakeRouter("research"), agents: [],
          orchestrator: { executeRun: vi.fn() }, notify, dataDir,
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
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir,
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no specialist matched");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task and notifies when no dispatched specialists are registered at all", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [],
      orchestrator: { executeRun: vi.fn() }, notify, dataDir,
    });
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no dispatched specialist");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task when the router names an agent that isn't a registered dispatched specialist", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    await runDispatchTick({
      tasks, router: new FakeRouter("some-other-agent"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("some-other-agent");
  });
});

describe("Dispatcher.wake", () => {
  it("drains every pending task in one wake() call, not just one", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
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
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const router = new FakeRouter("research");
    const dispatcher = new Dispatcher({
      tasks, router, agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
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
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "a", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect((await tasks.get(task.id))?.status).toBe("pending");
  });

  it("attempts two tasks that both silently auto-retry once each, rather than hammering either one", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
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
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const resolvers: Array<(r: RunResult) => void> = [];
    const executeRun = vi.fn().mockImplementation(
      () => new Promise<RunResult>((resolve) => resolvers.push(resolve)),
    );
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    const wakePromise = dispatcher.wake();
    // Poll rather than trust a fixed delay: claiming goes through real
    // (temp-dir) disk I/O, which can take longer than a single event-loop
    // tick, especially under the load of the full suite running in parallel.
    await vi.waitFor(() => expect(executeRun).toHaveBeenCalledTimes(2));
    expect((await tasks.list()).map((t) => t.status).sort()).toEqual(["running", "running"]);

    resolvers.forEach((resolve) => resolve(successResult()));
    await wakePromise;
    expect((await tasks.list()).map((t) => t.status)).toEqual(["done", "done"]);
  });

  it("keeps draining past a task that threw — a thrown error is not a deferral", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner", priority: 90 });
    await tasks.create({ text: "b", createdBy: "discord:owner", priority: 10 });
    const executeRun = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(successResult());
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    const statuses = (await tasks.list()).map((t) => t.status).sort();
    expect(statuses).toEqual(["done", "failed"]);
  });

  it("a re-entrant wake() call while draining is a no-op, not a second concurrent drain", async () => {
    const { tasks, dataDir } = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    let resolveRun!: (r: RunResult) => void;
    const executeRun = vi.fn().mockReturnValue(new Promise<RunResult>((resolve) => { resolveRun = resolve; }));
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    const firstWake = dispatcher.wake();
    const secondWake = dispatcher.wake();
    resolveRun(successResult());
    await Promise.all([firstWake, secondWake]);
    expect(executeRun).toHaveBeenCalledTimes(1);
  });
});
