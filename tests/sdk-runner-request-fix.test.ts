import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeGithubTransport } from "../src/control/github-transport.js";
import { PendingStore } from "../src/control/pending.js";
import { TaskStore } from "../src/control/task-store.js";
import type { Grant } from "../src/grants.js";
import type { AgentDef } from "../src/registry.js";
import { MAX_FIX_ATTEMPTS_PER_PR, PrFixAttemptStore } from "../src/state/pr-fix-attempts.js";
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

const CTX = { runId: "pr-reviewer-run", workspace: "/tmp/ws/pr-reviewer", prompt: "Review this PR." };

const RESULT_MESSAGE = {
  type: "result", subtype: "success", is_error: false,
  usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001, duration_ms: 100,
};

function agent(name: string): AgentDef {
  return {
    name,
    run: { model: "claude-sonnet-5", effort: "high", maxTurns: 60, timeoutMinutes: 30, maxBudgetUsd: 3 },
    permissions: { allowedTools: ["Read", "Bash"], disallowedTools: [] },
    grantRefs: [],
  } as unknown as AgentDef;
}

interface GithubPrParams {
  options: {
    mcpServers: Record<
      string,
      { instance?: { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> } } | undefined
    >;
  };
}

function requestFixHandler(params: GithubPrParams): (input: unknown) => Promise<unknown> {
  return params.options.mcpServers.githubPr!.instance!._registeredTools.requestFix!.handler;
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

describe("SdkRunner requestFix tool", () => {
  it("is not registered when tasks/wake/fixAttempts are not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github });
    await collect(runner.execute(agent("pr-reviewer"), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    const tools = params.options.mcpServers.githubPr?.instance?._registeredTools ?? {};
    expect(tools.requestFix).toBeUndefined();
  });

  it("is not registered for builder or repair even when fully wired — pr-reviewer only", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const github = new FakeGithubTransport();
    for (const name of ["builder", "repair"]) {
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const tasks = new TaskStore(dir);
      const wake = vi.fn().mockResolvedValue(undefined);
      const fixAttempts = new PrFixAttemptStore(dir);
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github, tasks, wake, fixAttempts });
      await collect(runner.execute(agent(name), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as GithubPrParams;
      const tools = params.options.mcpServers.githubPr?.instance?._registeredTools ?? {};
      expect(tools.requestFix, `expected requestFix to be absent for "${name}"`).toBeUndefined();
    }
  });

  it("queues a builder task, routed directly (no router call needed), and increments the attempt count", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const fixAttempts = new PrFixAttemptStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github, tasks, wake, fixAttempts });
    await collect(runner.execute(agent("pr-reviewer"), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    const handler = requestFixHandler(params);

    const result = await handler({
      repo: "AAS-Labs/pilot-01",
      number: 5,
      findings: "upsertSubscriber never updates access_token on conflict.",
    });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Queued fix task") }] });
    const created = await tasks.list();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      specialistAgent: "builder",
      createdBy: "agent:pr-reviewer",
      status: "pending",
    });
    expect(created[0]!.text).toContain("AAS-Labs/pilot-01#5");
    expect(created[0]!.text).toContain("upsertSubscriber never updates access_token on conflict.");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await fixAttempts.get("AAS-Labs/pilot-01#5")).toBe(1);
  });

  it(`refuses once the same PR has already had ${MAX_FIX_ATTEMPTS_PER_PR} attempts queued, without creating another task`, async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const fixAttempts = new PrFixAttemptStore(dir);
    for (let i = 0; i < MAX_FIX_ATTEMPTS_PER_PR; i++) {
      await fixAttempts.increment("AAS-Labs/pilot-01#5");
    }
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github, tasks, wake, fixAttempts });
    await collect(runner.execute(agent("pr-reviewer"), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    const handler = requestFixHandler(params);

    const result = await handler({ repo: "AAS-Labs/pilot-01", number: 5, findings: "still broken." });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Refused") }] });
    expect(await tasks.list()).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
    expect(await fixAttempts.get("AAS-Labs/pilot-01#5")).toBe(MAX_FIX_ATTEMPTS_PER_PR);
  });

  it("tracks separate PRs' attempt counts independently", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const fixAttempts = new PrFixAttemptStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github, tasks, wake, fixAttempts });
    await collect(runner.execute(agent("pr-reviewer"), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    const handler = requestFixHandler(params);

    await handler({ repo: "AAS-Labs/pilot-01", number: 5, findings: "finding A" });
    const result = await handler({ repo: "AAS-Labs/pilot-01", number: 7, findings: "finding B" });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Queued fix task") }] });
    expect(await fixAttempts.get("AAS-Labs/pilot-01#5")).toBe(1);
    expect(await fixAttempts.get("AAS-Labs/pilot-01#7")).toBe(1);
  });

  it("a successful mergePR resets that PR's fix-attempt count", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 5, repo: "owner/repo", headSha: "sha-1", changedFiles: ["src/orchestrator.ts"], diff: "", title: "t", body: "b" });
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    const fixAttempts = new PrFixAttemptStore(dir);
    await fixAttempts.increment("owner/repo#5");
    await fixAttempts.increment("owner/repo#5");
    const grant: Grant = { id: "infra-repo", kind: "github-pr", repos: ["owner/repo"], secret: "X" };
    const runner = new SdkRunner({ grants: [grant], pending: new PendingStore(dir), github, tasks, wake, fixAttempts });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(
      runner.execute(
        { ...agent("pr-reviewer"), tier: "autonomous", approval: "auto", grantRefs: ["infra-repo"] } as unknown as AgentDef,
        CTX,
        new AbortController().signal,
      ),
    );
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    const mergeHandler = params.options.mcpServers.githubPr!.instance!._registeredTools.mergePR!.handler;

    const result = await mergeHandler({ repo: "owner/repo", number: 5, expectedHeadSha: "sha-1" });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Successfully merged") }] });
    expect(await fixAttempts.get("owner/repo#5")).toBe(0);
  });
});
