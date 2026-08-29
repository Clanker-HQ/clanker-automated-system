import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
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
  name: "research",
  run: { model: "claude-haiku-4-5", effort: "medium", maxTurns: 30, timeoutMinutes: 20, maxBudgetUsd: 2 },
  permissions: { allowedTools: ["WebSearch", "WebFetch", "Write"], disallowedTools: [] },
} as unknown as AgentDef;

const CTX = { runId: "research-run", workspace: "/tmp/ws/research", prompt: "Research VPS providers." };

const RESULT_MESSAGE = {
  type: "result", subtype: "success", is_error: false,
  usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001, duration_ms: 100,
};

interface SystemContextParams {
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

describe("SdkRunner systemContext tool", () => {
  it("is not registered when systemContext is not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir) });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as SystemContextParams;
    expect(params.options.mcpServers.systemContext).toBeUndefined();
  });

  it("is registered, and returns the wired-in content verbatim, when systemContext is provided", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({
      grants: [],
      pending: new PendingStore(dir),
      systemContext: "## What this system is\n\nA primer.\n",
    });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as SystemContextParams;
    const handler = params.options.mcpServers.systemContext!.instance!._registeredTools.systemContext!.handler;

    const result = await handler({});

    expect(result).toMatchObject({ content: [{ type: "text", text: "## What this system is\n\nA primer.\n" }] });
  });
});
