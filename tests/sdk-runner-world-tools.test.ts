import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";
import { WorldModel } from "../src/world/world-model.js";

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

interface WorldToolParams {
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

describe("SdkRunner worldModel tools", () => {
  it("is not registered when world is not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir) });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    expect(params.options.mcpServers.worldModel).toBeUndefined();
  });

  it("records a finding that the WorldModel then returns", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.worldModel!.instance!._registeredTools.recordFinding!.handler;

    const result = await handler({
      topic: "Headless CMS pricing",
      conclusion: "Not worth pursuing: margins are too thin below $20/mo.",
      confidence: "medium",
      sources: ["https://example.com/pricing"],
    });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Headless CMS pricing") }] });
    const finding = await world.readFinding("Headless CMS pricing");
    expect(finding).toMatchObject({
      topic: "Headless CMS pricing",
      conclusion: "Not worth pursuing: margins are too thin below $20/mo.",
      confidence: "medium",
      sources: ["https://example.com/pricing"],
    });
  });

  // Zod's .default() is only applied on the real MCP request path (the
  // server validates arguments before invoking the callback) — calling
  // .handler directly, as most tests in this file do, bypasses that
  // entirely, so this one goes through the real protocol layer instead, the
  // same way the "rejects a bad ... value" tests below have to.
  it("defaults sources to an empty array when omitted", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = params.options.mcpServers.worldModel!.instance as unknown as { connect: (t: unknown) => Promise<void> };
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "recordFinding",
      arguments: { topic: "Print-on-demand mugs", conclusion: "Saturated.", confidence: "low" },
    });

    expect(result.isError).not.toBe(true);
    const finding = await world.readFinding("Print-on-demand mugs");
    expect(finding?.sources).toEqual([]);
    await client.close();
  });

  it("updates a portfolio entry that the WorldModel then returns", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.worldModel!.instance!._registeredTools.updatePortfolioEntry!.handler;

    const result = await handler({
      slug: "widget-tool",
      purpose: "A tool that does widgets.",
      status: "live",
      nextReviewAt: "2026-10-01",
      bar: "Must show 5 paying customers.",
      monthlyCostUsd: 12,
      notes: ["2026-09-01: launched"],
    });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("widget-tool") }] });
    const portfolio = await world.readPortfolio();
    expect(portfolio).toEqual([
      {
        slug: "widget-tool",
        purpose: "A tool that does widgets.",
        status: "live",
        nextReviewAt: "2026-10-01",
        bar: "Must show 5 paying customers.",
        monthlyCostUsd: 12,
        notes: ["2026-09-01: launched"],
      },
    ]);
  });

  // Both tools must go through Zod at the MCP layer, exactly like queueTask —
  // an agent passing a bad enum value must get a tool error, never a
  // corrupted world model, since other agents treat these files as fact.
  // Calling .handler directly bypasses Zod entirely (see the equivalent
  // comment in tests/sdk-runner-options.test.ts), so this drives the real MCP
  // protocol layer instead.
  it("rejects a bad confidence value at the schema level, never reaching WorldModel.writeFinding", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = params.options.mcpServers.worldModel!.instance as unknown as { connect: (t: unknown) => Promise<void> };
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "recordFinding",
      arguments: { topic: "X", conclusion: "Y", confidence: "extremely-sure", sources: [] },
    });

    expect(result.isError).toBe(true);
    expect(await world.readFinding("X")).toBeNull();
    await client.close();
  });

  it("rejects a bad status value at the schema level, never reaching WorldModel.upsertPortfolioEntry", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = params.options.mcpServers.worldModel!.instance as unknown as { connect: (t: unknown) => Promise<void> };
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "updatePortfolioEntry",
      arguments: {
        slug: "widget-tool",
        purpose: "A tool.",
        status: "thriving",
        nextReviewAt: "2026-10-01",
        bar: "Bar.",
        monthlyCostUsd: 5,
        notes: [],
      },
    });

    expect(result.isError).toBe(true);
    expect(await world.readPortfolio()).toEqual([]);
    await client.close();
  });
});
