import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Dispatcher, runDispatchTick } from "../src/control/dispatcher.js";
import { FakeRouter } from "../src/control/router.js";
import { TaskStore } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";
import type { RunResult } from "../src/run-store.js";

function taskStore(): TaskStore {
  return new TaskStore(mkdtempSync(join(tmpdir(), "cai-dispatcher-")));
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
    const result = await runDispatchTick({
      tasks: taskStore(), router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun: vi.fn() }, notify: vi.fn(),
    });
    expect(result).toEqual({ ran: false });
  });

  it("routes a pending task, runs it, and marks it done on success", async () => {
    const tasks = taskStore();
    const task = await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const result = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    expect(result).toEqual({ ran: true, taskId: task.id });
    expect(executeRun).toHaveBeenCalledWith(specialist(), expect.any(Date), "find a profitable niche");
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.specialistAgent).toBe("research");
    expect(updated?.result).toEqual({ summary: "Found three ideas.", path: "data/runs/research-1" });
  });

  it("marks the task failed, with the run's own error, when the run doesn't succeed", async () => {
    const tasks = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("boom");
  });

  it("puts the task back to pending, without failing it, when the governor refuses admission", async () => {
    const tasks = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("pending");
  });

  it("fails the task and notifies, without ever calling executeRun, when no specialist matches", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun }, notify,
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no specialist matched");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task and notifies when no dispatched specialists are registered at all", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [],
      orchestrator: { executeRun: vi.fn() }, notify,
    });
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no dispatched specialist");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task when the router names an agent that isn't a registered dispatched specialist", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    await runDispatchTick({
      tasks, router: new FakeRouter("some-other-agent"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("some-other-agent");
  });
});

describe("Dispatcher.wake", () => {
  it("drains every pending task in one wake() call, not just one", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    const remaining = (await tasks.list()).filter((t) => t.status === "pending" || t.status === "running");
    expect(remaining).toEqual([]);
  });

  it("a re-entrant wake() call while draining is a no-op, not a second concurrent drain", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    let resolveRun!: (r: RunResult) => void;
    const executeRun = vi.fn().mockReturnValue(new Promise<RunResult>((resolve) => { resolveRun = resolve; }));
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    const firstWake = dispatcher.wake();
    const secondWake = dispatcher.wake();
    resolveRun(successResult());
    await Promise.all([firstWake, secondWake]);
    expect(executeRun).toHaveBeenCalledTimes(1);
  });
});
