import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
import { FakeRouter } from "../src/control/router.js";
import { MAX_TASK_TEXT_LENGTH, TaskStore } from "../src/control/task-store.js";
import { FakeTaskReviewer } from "../src/control/task-reviewer.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";

const memoryConfig = {
  enabled: true,
  retentionDays: 90,
  reflectionRetentionDays: 365,
  similarityThreshold: 0.75,
  stalenessDays: 30,
  recencyHalfLifeDays: 14,
  maxChainDepth: 3,
  maxAgentTasksPerDay: 20,
  weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
  reflectionSchedule: "0 3 * * 1",
  reflectionTimezone: "UTC",
  reflectionWindowDays: 14,
};

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { SdkRunner } = await import("../src/runner/sdk-runner.js");

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

const AGENT = {
  name: "opportunity-scout",
  run: { model: "claude-haiku-4-5", effort: "low", maxTurns: 15, timeoutMinutes: 5, maxBudgetUsd: 0.5 },
  permissions: { allowedTools: ["WebSearch"], disallowedTools: [] },
} as unknown as AgentDef;

const CTX = { runId: "scout-run", workspace: "/tmp/ws/opportunity-scout", prompt: "Find a way to make money." };

const RESULT_MESSAGE = {
  type: "result", subtype: "success", is_error: false,
  usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001, duration_ms: 100,
};

interface QueueTaskParams {
  options: {
    mcpServers: Record<
      string,
      { instance?: { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> } } | undefined
    >;
  };
}

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("SdkRunner queueTask tool", () => {
  it("is not registered when tasks/wake are not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir) });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue).toBeUndefined();
  });

  it("is registered, and queues a task, when tasks/wake are wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = await handler({ text: "Research whether X is a viable niche." });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Queued task") }] });
    const created = await tasks.list();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      text: "Research whether X is a viable niche.",
      priority: 30,
      createdBy: "agent:opportunity-scout",
      wantsDetail: true,
      status: "pending",
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("defaults category to exploitation, and honors an explicit exploration tag", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "Default-category idea." });
    await handler({ text: "Explore something new.", category: "exploration" });

    const created = await tasks.list();
    expect(created.find((t) => t.text === "Default-category idea.")?.category).toBe("exploitation");
    expect(created.find((t) => t.text === "Explore something new.")?.category).toBe("exploration");
  });

  it("honors an explicit priority below the self-queued default", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "Low-urgency idea.", priority: 10 });

    const created = await tasks.list();
    expect(created[0]?.priority).toBe(10);
  });

  it("clamps an explicit priority above the self-queued default, so a scout can never outrank a human !task", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "Urgent-ish idea.", priority: 70 });

    const created = await tasks.list();
    expect(created[0]?.priority).toBe(30);
  });

  it("refuses a 4th queueTask call in the same run, and does not queue it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "one" });
    await handler({ text: "two" });
    await handler({ text: "three" });
    const fourth = await handler({ text: "four" });

    expect(fourth).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Refused") }] });
    expect(await tasks.list()).toHaveLength(3);
  });

  it("rejects an empty or oversized text at the schema level, before any task is created", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = params.options.mcpServers.taskQueue!.instance as unknown as { connect: (t: unknown) => Promise<void> };
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

    const oversized = await client.callTool({ name: "queueTask", arguments: { text: "x".repeat(MAX_TASK_TEXT_LENGTH + 1) } });
    expect(oversized.isError).toBe(true);

    const empty = await client.callTool({ name: "queueTask", arguments: { text: "" } });
    expect(empty.isError).toBe(true);

    expect(await tasks.list()).toEqual([]);
    await client.close();
  });

  it("refuses a proposal the novelty gate suppresses, without creating a task", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    await memory.append({
      domain: "research",
      kind: "outcome",
      subject: "Whether X is a viable niche",
      body: "done",
      importance: 5,
      createdBy: "agent:x",
      verdict: "achieved",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({
      text: "Research whether X is a viable niche again.",
      domain: "research",
      subject: "Whether X is a viable niche",
      importance: 5,
      goalAlignment: 0.5,
    })) as { content: { type: string; text: string }[] };

    expect(result.content[0]!.text).toContain("already");
    expect(await tasks.list()).toEqual([]);
  });

  it("records a proposal record in the memory log when it does queue", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({
      text: "Investigate something entirely novel.",
      domain: "research",
      subject: "Something entirely novel",
      importance: 5,
      goalAlignment: 0.5,
    });

    const records = await memory.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "proposal", subject: "Something entirely novel" });
  });

  it("annotates a retry with the prior attempt's reason", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    await memory.append({
      domain: "research",
      kind: "outcome",
      subject: "Approach Y for growth",
      body: "reason: budget too low",
      importance: 5,
      createdBy: "agent:x",
      verdict: "not-achieved",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({
      text: "Try approach Y for growth again.",
      domain: "research",
      subject: "Approach Y for growth",
      importance: 5,
      goalAlignment: 0.5,
    });

    const created = await tasks.list();
    expect(created).toHaveLength(1);
    expect(created[0]?.text).toContain("reason: budget too low");
  });

  it("computes priority from the score rather than always using 30", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({
      text: "Pursue a brand-new, highly-aligned opportunity.",
      domain: "research",
      subject: "Brand-new opportunity that matches nothing on record",
      importance: 6,
      goalAlignment: 0.7,
    });

    const created = await tasks.list();
    expect(created[0]?.priority).toBeGreaterThan(30);
    expect(created[0]?.priority).toBeLessThanOrEqual(49);
  });

  it("still clamps to <= 49 so a human !task always outranks it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({
      text: "Maximally aligned and important proposal.",
      domain: "research",
      subject: "Maximally aligned proposal with nothing similar on record",
      importance: 10,
      goalAlignment: 1,
    });

    const created = await tasks.list();
    expect(created[0]?.priority).toBeLessThanOrEqual(49);
  });

  it("still enforces the existing 3-calls-per-run cap", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "one", domain: "research", subject: "first idea", importance: 5, goalAlignment: 0.5 });
    await handler({ text: "two", domain: "research", subject: "second idea", importance: 5, goalAlignment: 0.5 });
    await handler({ text: "three", domain: "research", subject: "third idea", importance: 5, goalAlignment: 0.5 });
    const fourth = (await handler({
      text: "four",
      domain: "research",
      subject: "fourth idea",
      importance: 5,
      goalAlignment: 0.5,
    })) as { content: { type: string; text: string }[] };

    expect(fourth.content[0]!.text).toContain("Refused");
    expect(await tasks.list()).toHaveLength(3);
  });
});

// Scoped to research alone (see TASK_REVIEW_AGENTS in sdk-runner.ts): a
// research-proposed build task is the one that flows straight to builder and
// eventually real spend (hosting, registration fees), which is what a
// research run's own recordFinding conclusion getting ahead of its sourcing
// actually put at risk. The scouts/overseer propose narrower, more reversible
// work, so review is not applied to them here.
describe("SdkRunner queueTask automated review (research only)", () => {
  const RESEARCH_AGENT = { ...AGENT, name: "research" } as unknown as AgentDef;

  it("refuses a poorly-grounded proposal from research, without queuing it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const taskReviewer = new FakeTaskReviewer({
      allowed: false,
      reason: "claim about competitor pricing rests on a blog roundup, not the vendor's own page",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, taskReviewer });
    await collect(runner.execute(RESEARCH_AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Build the checkout flow for candidate 1.", domain: "general" })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Refused");
    expect(result.content[0]!.text).toContain("blog roundup");
    expect(await tasks.list()).toEqual([]);
    expect(taskReviewer.calls).toEqual([
      { text: "Build the checkout flow for candidate 1.", domain: "general", subject: undefined, createdBy: "agent:research" },
    ]);
  });

  it("queues a well-grounded proposal from research normally", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const taskReviewer = new FakeTaskReviewer({ allowed: true });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, taskReviewer });
    await collect(runner.execute(RESEARCH_AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Build the checkout flow for candidate 1." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Queued task");
    expect(await tasks.list()).toHaveLength(1);
  });

  it("does not apply review to a non-research agent, even with an always-refusing reviewer wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const taskReviewer = new FakeTaskReviewer({ allowed: false, reason: "would refuse everything" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, taskReviewer });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Look into a new opportunity." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Queued task");
    expect(await tasks.list()).toHaveLength(1);
    expect(taskReviewer.calls).toEqual([]);
  });

  it("still queues the task when TaskReviewer throws", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const taskReviewer = { review: vi.fn().mockRejectedValue(new Error("grading call exploded")) };
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, taskReviewer });
    await collect(runner.execute(RESEARCH_AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Build the checkout flow for candidate 1." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Queued task");
    expect(await tasks.list()).toHaveLength(1);
  });

  it("counts a review refusal against the same per-run cap as a duplicate refusal", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const taskReviewer = new FakeTaskReviewer({ allowed: false, reason: "not grounded" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, taskReviewer });
    await collect(runner.execute(RESEARCH_AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "one" });
    await handler({ text: "two" });
    await handler({ text: "three" });
    const fourth = (await handler({ text: "four" })) as { content: { type: string; text: string }[] };

    expect(fourth.content[0]!.text).toContain("maximum allowed in one run");
    expect(await tasks.list()).toEqual([]);
  });
});

// A task queued for work no registered specialist is scoped to do (a domain
// registration, a stakeholder-validation checklist, a weeks-long demand-
// validation campaign) previously sailed straight into the queue and only
// died later at dispatch with "no specialist matched this task" — a terminal,
// non-retryable failure the queueing agent never even sees. This gate runs
// the same routing decision dispatcher.ts makes, but at queue time, so the
// calling agent can react (recast or drop it) in the same run instead of the
// proposal silently dying days later.
describe("SdkRunner queueTask router preflight", () => {
  const BUILDER_SPECIALIST = {
    name: "builder",
    enabled: true,
    trigger: { type: "dispatched" },
    description: "Implements a small, well-described code change.",
  } as unknown as AgentDef;

  it("refuses a proposal no registered specialist would take, without creating a task", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const router = new FakeRouter(null);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({
      grants: [], pending: new PendingStore(dir), tasks, wake, router, agents: [BUILDER_SPECIALIST],
    });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Register a domain and configure DNS for the VPS." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Refused");
    expect(await tasks.list()).toEqual([]);
  });

  it("queues the task with the routed specialist pre-assigned when one fits", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const router = new FakeRouter("builder");
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({
      grants: [], pending: new PendingStore(dir), tasks, wake, router, agents: [BUILDER_SPECIALIST],
    });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Fix the off-by-one in the pagination helper." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Queued task");
    const created = await tasks.list();
    expect(created[0]?.specialistAgent).toBe("builder");
  });

  it("counts a routing refusal against the same per-run cap as any other refusal", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const router = new FakeRouter(null);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({
      grants: [], pending: new PendingStore(dir), tasks, wake, router, agents: [BUILDER_SPECIALIST],
    });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "one" });
    await handler({ text: "two" });
    await handler({ text: "three" });
    const fourth = (await handler({ text: "four" })) as { content: { type: string; text: string }[] };

    expect(fourth.content[0]!.text).toContain("maximum allowed in one run");
    expect(await tasks.list()).toEqual([]);
  });

  it("keeps the old behavior (no preflight) when router is not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({
      grants: [], pending: new PendingStore(dir), tasks, wake, agents: [BUILDER_SPECIALIST],
    });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Register a domain and configure DNS for the VPS." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Queued task");
    expect(await tasks.list()).toHaveLength(1);
  });

  it("keeps the old behavior (no preflight) when the agent registry is not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const router = new FakeRouter(null);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, router });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = (await handler({ text: "Register a domain and configure DNS for the VPS." })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Queued task");
    expect(await tasks.list()).toHaveLength(1);
  });
});

describe("SdkRunner listMyTasks tool", () => {
  it("is registered even without wake — read-only, no dispatcher nudge needed", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue).toBeDefined();
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask).toBeUndefined();
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks).toBeDefined();
  });

  it("returns only the calling agent's own tasks, most recent first, capped at 20", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    // TaskStore.create() stamps createdAt from the real system clock with
    // only millisecond resolution — on a fast machine, several of these 25
    // sequential creates can land in the same millisecond, and listMyTasks'
    // sort (a stable sort on createdAt) then breaks that tie by whatever
    // order readdir() happens to return, not creation order. Faking the
    // clock and advancing it a full second between creates guarantees each
    // task gets a distinct, correctly-ordered createdAt.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    try {
      for (let i = 0; i < 25; i++) {
        await tasks.create({ text: `mine ${i}`, createdBy: "agent:opportunity-scout" });
        vi.advanceTimersByTime(1000);
      }
    } finally {
      vi.useRealTimers();
    }
    await tasks.create({ text: "not mine", createdBy: "agent:improvement-scout" });
    await tasks.create({ text: "human", createdBy: "discord:owner" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    const mine = JSON.parse(result.content[0]!.text) as { text: string }[];
    expect(mine).toHaveLength(20);
    expect(mine.every((t) => t.text.startsWith("mine "))).toBe(true);
    expect(mine[0]!.text).toBe("mine 24");
  });

  it("truncates a long task's text to 200 characters", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    await tasks.create({ text: "x".repeat(300), createdBy: "agent:opportunity-scout" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    const [mine] = JSON.parse(result.content[0]!.text) as { text: string }[];
    expect(mine!.text).toBe(`${"x".repeat(200)}…`);
  });
});

describe("SdkRunner recentFailures tool", () => {
  async function failedTask(
    tasks: TaskStore,
    opts: { text: string; specialistAgent?: string; failureReason?: string; finishedAt: string },
  ) {
    const t = await tasks.create({ text: opts.text, createdBy: "discord:owner" });
    return tasks.update(t.id, {
      status: "failed",
      specialistAgent: opts.specialistAgent,
      failureReason: opts.failureReason,
      finishedAt: opts.finishedAt,
    });
  }

  it("is registered whenever tasks is wired in, independent of wake", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures).toBeDefined();
  });

  it("groups failures by specialist and truncated reason, sorted by count descending", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const recent = "2026-08-28T00:00:00.000Z";
    await failedTask(tasks, { text: "a", specialistAgent: "research", failureReason: "boom", finishedAt: recent });
    await failedTask(tasks, { text: "b", specialistAgent: "research", failureReason: "boom", finishedAt: recent });
    await failedTask(tasks, { text: "c", specialistAgent: "research", failureReason: "boom", finishedAt: recent });
    await failedTask(tasks, { text: "d", specialistAgent: "builder", failureReason: "other", finishedAt: recent });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    const buckets = JSON.parse(result.content[0]!.text) as { specialistAgent: string; reason: string; count: number }[];
    expect(buckets[0]).toMatchObject({ specialistAgent: "research", reason: "boom", count: 3 });
    expect(buckets[1]).toMatchObject({ specialistAgent: "builder", reason: "other", count: 1 });
  });

  it("excludes failures older than 14 days", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await failedTask(tasks, { text: "a", specialistAgent: "research", failureReason: "boom", finishedAt: old });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual([]);
  });

  it("never includes raw task text in its output", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    await failedTask(tasks, {
      text: "a very specific and sensitive task description",
      specialistAgent: "research",
      failureReason: "boom",
      finishedAt: "2026-08-28T00:00:00.000Z",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    expect(result.content[0]!.text).not.toContain("sensitive task description");
  });
});

describe("SdkRunner cancelTask tool", () => {
  const SCOUT = { ...AGENT, name: "portfolio-sync-scout" } as unknown as AgentDef;

  it("is not registered for an agent outside its allowlist, even though taskQueue is mounted for it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures).toBeDefined();
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.cancelTask).toBeUndefined();
  });

  it("is registered for portfolio-sync-scout, and cancels a pending task", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const pending = await tasks.create({ text: "stale proposal", createdBy: "operator" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(SCOUT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.cancelTask!.handler;

    const result = await handler({ id: pending.id, reason: "superseded by a newer finding" });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining(pending.id) }] });
    expect(await tasks.get(pending.id)).toBeNull();
  });

  it("cancels a failed task the same way", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const created = await tasks.create({ text: "dead-end proposal", createdBy: "agent:research" });
    await tasks.update(created.id, { status: "failed", failureReason: "no specialist matched this task" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(SCOUT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.cancelTask!.handler;

    const result = await handler({ id: created.id, reason: "premise superseded" });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining(created.id) }] });
    expect(await tasks.get(created.id)).toBeNull();
  });

  it("refuses to cancel a task that is not pending or failed, and leaves it in place", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const created = await tasks.create({ text: "finished work", createdBy: "agent:research" });
    await tasks.update(created.id, { status: "done", finishedAt: new Date().toISOString() });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(SCOUT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.cancelTask!.handler;

    const result = (await handler({ id: created.id, reason: "irrelevant" })) as { content: { type: string; text: string }[] };

    expect(result.content[0]!.text).toMatch(/refus/i);
    expect(await tasks.get(created.id)).not.toBeNull();
  });

  it("refuses cancelling a task id that does not exist, without throwing", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(SCOUT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.cancelTask!.handler;

    const result = (await handler({ id: "no-such-task", reason: "irrelevant" })) as { content: { type: string; text: string }[] };

    expect(result.content[0]!.text).toMatch(/no task|not found/i);
  });
});

describe("SdkRunner recallMemory tool", () => {
  it("is registered when memory is wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.recallMemory).toBeDefined();
  });

  it("is not registered when memory is not wired in, independent of listMyTasks", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.recallMemory).toBeUndefined();
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks).toBeDefined();
  });

  it("returns retrieved context when a matching record exists", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const memory = new MemoryStore(dir);
    await memory.append({
      domain: "research",
      kind: "outcome",
      subject: "research paid newsletter platforms for developers",
      body: "found several viable platforms",
      importance: 5,
      createdBy: "agent:research",
      verdict: "achieved",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recallMemory!.handler;

    const result = (await handler({
      subject: "research paid newsletter platforms for developers",
      domain: "research",
    })) as { content: { type: string; text: string }[] };

    expect(result.content[0]!.text).toContain("found several viable platforms");
  });

  it("returns the fallback message when nothing matches", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, memory, memoryConfig });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recallMemory!.handler;

    const result = (await handler({
      subject: "completely unrelated topic about gardening tools",
      domain: "research",
    })) as { content: { type: string; text: string }[] };

    expect(result.content[0]!.text).toBe("Nothing recorded on this subject yet.");
  });
});

// research is a pure web-research specialist, categorically different from
// the self-improving scouts/overseer these three tools exist for — its own
// prompt.md calls queueTask and nothing else on this server. Excluding it
// from the other three doesn't touch the "available at every tier" design
// the rest of this server keeps (see the doc comment on taskQueueServer in
// sdk-runner.ts): every other agent with tasksDep wired in is unaffected —
// the tests above, which all use AGENT ("opportunity-scout"), prove that.
describe("SdkRunner taskQueue tools excluded for research", () => {
  const RESEARCH_AGENT = { ...AGENT, name: "research" } as unknown as AgentDef;

  it("still registers queueTask for research, but not listMyTasks, recentFailures, or recallMemory", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const memory = new MemoryStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
    await collect(runner.execute(RESEARCH_AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const registered = params.options.mcpServers.taskQueue!.instance!._registeredTools;

    expect(registered.queueTask).toBeDefined();
    expect(registered.listMyTasks).toBeUndefined();
    expect(registered.recentFailures).toBeUndefined();
    expect(registered.recallMemory).toBeUndefined();
  });
});

// builder, pr-reviewer, repair, and e2e-approval-test reference NONE of
// this server's tools in their own prompt.md -- unlike research (queueTask)
// or the scouts/overseer (queueTask, listMyTasks, ...), there's nothing
// "available at every tier" for these four to use, so the whole server is
// dead weight for them: four tool schemas paid on every turn for a
// capability their prompt never calls into. Gated the same way githubPr is
// -- an explicit allowlist of agents whose own prompt actually references
// something on this server -- rather than excluding tools one at a time.
describe("SdkRunner taskQueue server not mounted for agents that never reference it", () => {
  it.each(["builder", "pr-reviewer", "repair", "e2e-approval-test"])(
    "does not mount taskQueue for %s, even with tasks/wake/memory all wired in",
    async (name) => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const tasks = new TaskStore(dir);
      const wake = vi.fn().mockResolvedValue(undefined);
      const memory = new MemoryStore(dir);
      const agent = { ...AGENT, name } as unknown as AgentDef;
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake, memory, memoryConfig });
      await collect(runner.execute(agent, CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
      expect(params.options.mcpServers.taskQueue).toBeUndefined();
    },
  );

  it.each(["research", "improvement-scout", "opportunity-scout", "dependency-scout", "overseer", "cleanup-scout"])(
    "still mounts taskQueue for %s",
    async (name) => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const tasks = new TaskStore(dir);
      const agent = { ...AGENT, name } as unknown as AgentDef;
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
      await collect(runner.execute(agent, CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
      expect(params.options.mcpServers.taskQueue).toBeDefined();
    },
  );
});
