import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
import { MAX_TASK_TEXT_LENGTH, TaskStore } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";

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

  it("uses an explicit priority when one is given, instead of the self-queued default", async () => {
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
    expect(created[0]?.priority).toBe(70);
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

    const result = await client.callTool({ name: "queueTask", arguments: { text: "x".repeat(MAX_TASK_TEXT_LENGTH + 1) } });

    expect(result.isError).toBe(true);
    expect(await tasks.list()).toEqual([]);
    await client.close();
  });
});
