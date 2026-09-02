import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { PendingStore } from "../src/control/pending.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";
import { BreakerStore } from "../src/state/breaker.js";
import { StrategyStore } from "../src/world/strategy.js";
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

const OVERSEER_AGENT = {
  name: "overseer",
  run: { model: "claude-opus-5", effort: "high", maxTurns: 40, timeoutMinutes: 30, maxBudgetUsd: 5 },
  permissions: { allowedTools: ["Read", "Glob", "Grep"], disallowedTools: [] },
} as unknown as AgentDef;

const OVERSEER_CTX = { runId: "overseer-run", workspace: "/tmp/ws/overseer", prompt: "Decide the next cycle's strategy." };

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
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
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

  it("round-trips extensionCount when the caller sets it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.worldModel!.instance!._registeredTools.updatePortfolioEntry!.handler;

    await handler({
      slug: "widget-tool",
      purpose: "A tool that does widgets.",
      status: "live",
      nextReviewAt: "2026-10-01",
      bar: "Must show 5 paying customers.",
      monthlyCostUsd: 12,
      notes: [],
      extensionCount: 2,
    });

    const portfolio = await world.readPortfolio();
    expect(portfolio[0]?.extensionCount).toBe(2);
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
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
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

  // recordFinding and updatePortfolioEntry each go to exactly one agent —
  // research is the only prompt.md that ever calls recordFinding, and
  // updatePortfolioEntry is a product-portfolio concept only overseer's
  // prompt touches. Unlike taskQueue (which deliberately keeps
  // listMyTasks/recentFailures broadly available — see its own doc
  // comment), worldModelServer makes no "every tier" claim, so both tools
  // are scoped to their one real caller.
  it("does not register updatePortfolioEntry for research", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    expect(params.options.mcpServers.worldModel!.instance!._registeredTools.recordFinding).toBeDefined();
    expect(params.options.mcpServers.worldModel!.instance!._registeredTools.updatePortfolioEntry).toBeUndefined();
  });

  it("does not register recordFinding for overseer", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    expect(params.options.mcpServers.worldModel!.instance!._registeredTools.updatePortfolioEntry).toBeDefined();
    expect(params.options.mcpServers.worldModel!.instance!._registeredTools.recordFinding).toBeUndefined();
  });

  it("does not mount the worldModel server at all for an agent that calls neither tool, even when world is wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const world = new WorldModel(dataDir);
    const scout = { ...AGENT, name: "opportunity-scout" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), world });
    await collect(runner.execute(scout, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    expect(params.options.mcpServers.worldModel).toBeUndefined();
  });
});

const VALID_EXPECTATION = { id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd" as const, atLeast: 50 } };

describe("SdkRunner overseer tools", () => {
  it("registers neither writeStrategy nor setAgentEnabled when none of their deps are wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir) });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    expect(params.options.mcpServers.overseer).toBeUndefined();
  });

  // These two tools are the only ones in this file gated on the calling
  // agent's identity, not just on which deps are wired in — see the doc
  // comment on `overseerServer` in sdk-runner.ts for why: unlike
  // recordFinding/queueTask (meant for every agent), writeStrategy and
  // setAgentEnabled are powers Design §3 of the autonomous-operation plan
  // reserves for the overseer alone.
  it("registers neither tool for a non-overseer agent, even when every dependency is wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-strategy-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const strategyStore = new StrategyStore(dataDir);
    const overrides = new ConfigOverridesStore(dataDir);
    const breaker = new BreakerStore(dataDir);
    const agents = [{ name: "overseer" }, { name: "research" }] as unknown as AgentDef[];
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) };
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({
      grants: [], pending: new PendingStore(dir), strategyStore, overrides, breaker, agents, outbox: outbox as never,
    });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    expect(params.options.mcpServers.overseer).toBeUndefined();
  });

  it("writes a strategy that StrategyStore then returns", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-strategy-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const strategyStore = new StrategyStore(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), strategyStore });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.overseer!.instance!._registeredTools.writeStrategy!.handler;

    const result = await handler({
      intent: "Push the CLI product toward its first paying customer.",
      allocation: { research: 20, build: 60, maintain: 20 },
      expectations: [VALID_EXPECTATION],
      changeReason: "",
    });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Strategy") }] });
    const latest = await strategyStore.latest();
    expect(latest).toMatchObject({
      intent: "Push the CLI product toward its first paying customer.",
      allocation: { research: 20, build: 60, maintain: 20 },
      expectations: [VALID_EXPECTATION],
    });
  });

  it("refuses to write a strategy whose allocation does not sum to 100, without touching StrategyStore", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-strategy-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const strategyStore = new StrategyStore(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), strategyStore });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.overseer!.instance!._registeredTools.writeStrategy!.handler;

    const result = (await handler({
      intent: "x",
      allocation: { research: 10, build: 10, maintain: 10 },
      expectations: [],
      changeReason: "",
    })) as { content: { type: string; text: string }[] };

    expect(result.content[0]!.text).toContain("Refused");
    expect(await strategyStore.latest()).toBeNull();
  });

  // Calling .handler directly bypasses Zod entirely (see the equivalent
  // comment on the worldModel tests above), so this drives the real MCP
  // protocol layer instead.
  it("rejects a malformed expectation check at the schema level, never reaching StrategyStore.write", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-strategy-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const strategyStore = new StrategyStore(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), strategyStore });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = params.options.mcpServers.overseer!.instance as unknown as { connect: (t: unknown) => Promise<void> };
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "writeStrategy",
      arguments: {
        intent: "x",
        allocation: { research: 20, build: 60, maintain: 20 },
        expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "somethingElse" } }],
        changeReason: "",
      },
    });

    expect(result.isError).toBe(true);
    expect(await strategyStore.latest()).toBeNull();
    await client.close();
  });

  it("registers writeStrategy without setAgentEnabled when only strategyStore is wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dataDir = mkdtempSync(join(tmpdir(), "cai-strategy-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const strategyStore = new StrategyStore(dataDir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), strategyStore });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const tools = params.options.mcpServers.overseer!.instance!._registeredTools;
    expect(tools.writeStrategy).toBeDefined();
    expect(tools.setAgentEnabled).toBeUndefined();
  });

  function setAgentEnabledFixture() {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-overrides-"));
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const overrides = new ConfigOverridesStore(dataDir);
    const breaker = new BreakerStore(dataDir);
    const agents = [{ name: "overseer" }, { name: "builder" }] as unknown as AgentDef[];
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) };
    return { dataDir, dir, overrides, breaker, agents, outbox };
  }

  it("refuses to disable the overseer itself", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const { dir, overrides, breaker, agents, outbox } = setAgentEnabledFixture();
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), overrides, breaker, agents, outbox: outbox as never });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.overseer!.instance!._registeredTools.setAgentEnabled!.handler;

    const result = (await handler({ agent: "overseer", enabled: false, reason: "test" })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("Refused");
    expect((await overrides.read()).disabledAgents ?? []).not.toContain("overseer");
    expect(outbox.postAlert).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent name, naming the agents that do exist", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const { dir, overrides, breaker, agents, outbox } = setAgentEnabledFixture();
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), overrides, breaker, agents, outbox: outbox as never });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.overseer!.instance!._registeredTools.setAgentEnabled!.handler;

    const result = (await handler({ agent: "nonexistent", enabled: false, reason: "test" })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]!.text).toContain("nonexistent");
    expect(result.content[0]!.text).toContain("builder");
  });

  it("disables a known agent and posts the reason to Discord", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const { dir, overrides, breaker, agents, outbox } = setAgentEnabledFixture();
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), overrides, breaker, agents, outbox: outbox as never });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.overseer!.instance!._registeredTools.setAgentEnabled!.handler;

    await handler({ agent: "builder", enabled: false, reason: "kept failing to achieve anything" });

    expect((await overrides.read()).disabledAgents).toContain("builder");
    expect(outbox.postAlert).toHaveBeenCalledTimes(1);
    const [channel, text] = outbox.postAlert.mock.calls[0]!;
    expect(channel).toBe("ops");
    expect(text).toContain("builder");
    expect(text).toContain("kept failing to achieve anything");
  });

  it("re-enabling a disabled agent also resets its circuit breaker", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const { dir, overrides, breaker, agents, outbox } = setAgentEnabledFixture();
    await overrides.set("disabledAgents", ["builder"], "test-setup");
    await breaker.recordResult("builder", "failed");
    await breaker.recordResult("builder", "failed");
    await breaker.recordResult("builder", "failed");
    expect(await breaker.isTripped("builder")).toBe(true);

    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), overrides, breaker, agents, outbox: outbox as never });
    await collect(runner.execute(OVERSEER_AGENT, OVERSEER_CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as WorldToolParams;
    const handler = params.options.mcpServers.overseer!.instance!._registeredTools.setAgentEnabled!.handler;

    await handler({ agent: "builder", enabled: true, reason: "probation cleared" });

    expect((await overrides.read()).disabledAgents ?? []).not.toContain("builder");
    expect(await breaker.isTripped("builder")).toBe(false);
  });
});
