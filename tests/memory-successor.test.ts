import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";
import { proposeSuccessors, type SuccessorSuggestion } from "../src/memory/successor.js";
import { FakeRouter } from "../src/control/router.js";
import { TaskStore } from "../src/control/task-store.js";
import type { Task } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";

const BUILDER = {
  name: "builder",
  description: "Implements a small, well-described code change.",
  enabled: true,
  trigger: { type: "dispatched" },
} as unknown as AgentDef;

const NOW = new Date("2026-08-30T00:00:00.000Z");

const CONFIG = {
  enabled: true, retentionDays: 90, reflectionRetentionDays: 365,
  similarityThreshold: 0.75, stalenessDays: 30, recencyHalfLifeDays: 14,
  maxChainDepth: 3, maxAgentTasksPerDay: 20,
  weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
  reflectionSchedule: "0 3 * * 1", reflectionTimezone: "UTC", reflectionWindowDays: 14,
} as const;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "cai-successor-"));
  return { tasks: new TaskStore(dir), memory: new MemoryStore(dir) };
}

function suggestion(over: Partial<SuccessorSuggestion> = {}): SuccessorSuggestion {
  return { text: "investigate pricing tiers", domain: "research", subject: "investigate pricing tiers", importance: 5, goalAlignment: 0.6, ...over };
}

function parent(over: Partial<Task> = {}): Task {
  return { id: "task-parent", text: "original work", priority: 30, status: "done", createdBy: "agent:research", createdAt: NOW.toISOString(), ...over };
}

function input(over: Record<string, unknown> = {}) {
  const { tasks, memory } = harness();
  return {
    parentTask: parent(), summary: "found three candidates", parentDepth: 0,
    agentName: "research", tasks, memory, config: { ...CONFIG },
    suggest: async () => [suggestion()], now: NOW, ...over,
  } as Parameters<typeof proposeSuccessors>[0];
}

describe("proposeSuccessors", () => {
  it("creates a task per suggestion, recorded at depth parent+1", async () => {
    const args = input({ suggest: async () => [suggestion(), suggestion({ subject: "compare hosting costs", text: "compare hosting costs" })] });
    const created = await proposeSuccessors(args);
    expect(created).toHaveLength(2);
    const records = await args.memory.list();
    expect(records.every((r) => r.kind === "proposal" && r.chainDepth === 1)).toBe(true);
    expect((await args.tasks.list()).every((t) => t.parentId === "task-parent")).toBe(true);
  });

  it("proposes nothing once the depth cap is reached, without calling the suggester", async () => {
    const suggest = vi.fn(async () => [suggestion()]);
    const args = input({ parentDepth: CONFIG.maxChainDepth, suggest });
    expect(await proposeSuccessors(args)).toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  });

  it("drops a suggestion the novelty gate suppresses", async () => {
    const args = input({ suggest: async () => [suggestion(), suggestion({ subject: "compare hosting costs", text: "compare hosting costs" })] });
    await args.memory.append({
      domain: "research", kind: "outcome", subject: "investigate pricing tiers",
      body: "done", importance: 5, createdBy: "agent:research", verdict: "achieved",
    });
    expect(await proposeSuccessors(args)).toHaveLength(1);
  });

  it("stops at the daily cap on agent-originated tasks", async () => {
    const args = input({ config: { ...CONFIG, maxAgentTasksPerDay: 1 } });
    await args.tasks.create({ text: "already queued today", createdBy: "agent:research" });
    expect(await proposeSuccessors(args)).toEqual([]);
  });

  it("caps priority below the human default even for a maximal suggestion", async () => {
    const args = input({ suggest: async () => [suggestion({ goalAlignment: 1, importance: 10 })] });
    await proposeSuccessors(args);
    expect((await args.tasks.list())[0]!.priority).toBeLessThanOrEqual(49);
  });

  it("proposes at most three successors from one completed task", async () => {
    const args = input({ suggest: async () => [1, 2, 3, 4, 5].map((n) => suggestion({ subject: `distinct subject ${n}`, text: `distinct body ${n}` })) });
    expect(await proposeSuccessors(args)).toHaveLength(3);
  });

  it("returns [] rather than throwing when the suggester rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const args = input({ suggest: async () => { throw new Error("model unavailable"); } });
      expect(await proposeSuccessors(args)).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("proposes nothing when memory is disabled", async () => {
    expect(await proposeSuccessors(input({ config: { ...CONFIG, enabled: false } }))).toEqual([]);
  });

  // The bug this closes: proposeSuccessors used to call tasks.create() with no
  // routing check at all, unlike queueTask (the MCP tool an agent calls
  // directly), which got a router preflight so an unroutable proposal is
  // refused before it ever enters the queue. A successor suggestion nothing
  // can execute still slipped through this path, silently queuing and dying
  // days later at dispatch with a terminal "no specialist matched this task" —
  // the exact failure mode the preflight fix was supposed to eliminate.
  it("skips a suggestion no registered specialist would take, creating no task for it", async () => {
    const router = new FakeRouter(null);
    const args = input({ router, agents: [BUILDER] });
    expect(await proposeSuccessors(args)).toEqual([]);
    expect((await args.tasks.list())).toHaveLength(0);
    expect(router.calls).toHaveLength(1);
  });

  it("pre-assigns the routed specialist on a created successor task, same as queueTask's preflight", async () => {
    const router = new FakeRouter("builder");
    const args = input({ router, agents: [BUILDER] });
    const created = await proposeSuccessors(args);
    expect(created).toHaveLength(1);
    const task = await args.tasks.get(created[0]!);
    expect(task?.specialistAgent).toBe("builder");
  });

  it("keeps the old behavior (no routing check, no specialistAgent) when router/agents are not wired in", async () => {
    const args = input();
    const created = await proposeSuccessors(args);
    expect(created).toHaveLength(1);
    const task = await args.tasks.get(created[0]!);
    expect(task?.specialistAgent).toBeUndefined();
  });
});
