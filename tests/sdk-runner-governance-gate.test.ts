import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INFRA_REPO } from "../src/control/excluded-paths.js";
import { FakeGithubTransport } from "../src/control/github-transport.js";
import { PendingStore } from "../src/control/pending.js";
import type { Grant } from "../src/grants.js";
import type { AgentDef } from "../src/registry.js";
import { GovernanceGateStore, MAX_GOVERNANCE_MERGES_PER_WINDOW } from "../src/state/governance-gate.js";
import type { RunEvent } from "../src/runner/types.js";
import type { DiscordOutbox } from "../src/outbox/discord.js";

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

function agent(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    tier: "autonomous",
    approval: "auto",
    run: { model: "claude-sonnet-5", effort: "high", maxTurns: 60, timeoutMinutes: 30, maxBudgetUsd: 3 },
    permissions: { allowedTools: ["Read", "Bash"], disallowedTools: [] },
    grantRefs: [],
    outbox: { discord: "ops", notifyOn: ["success", "failure"] },
    ...overrides,
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

function attestHandler(params: GithubPrParams): (input: unknown) => Promise<unknown> {
  return params.options.mcpServers.githubPr!.instance!._registeredTools.attestGovernanceSafety!.handler;
}

function mergeHandler(params: GithubPrParams): (input: unknown) => Promise<unknown> {
  return params.options.mcpServers.githubPr!.instance!._registeredTools.mergePR!.handler;
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

const INFRA_GRANT: Grant = { id: "infra-repo", kind: "github-pr", repos: [INFRA_REPO], secret: "X" };

describe("SdkRunner attestGovernanceSafety tool", () => {
  it("is not registered when governanceGate is not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github });
    await collect(runner.execute(agent("pr-reviewer"), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    expect(params.options.mcpServers.githubPr?.instance?._registeredTools.attestGovernanceSafety).toBeUndefined();
  });

  it("is not registered for builder or repair even when governanceGate is wired — pr-reviewer only", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const github = new FakeGithubTransport();
    for (const name of ["builder", "repair"]) {
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const governanceGate = new GovernanceGateStore(dir);
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github, governanceGate });
      await collect(runner.execute(agent(name), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as GithubPrParams;
      expect(params.options.mcpServers.githubPr?.instance?._registeredTools.attestGovernanceSafety, `expected absent for "${name}"`).toBeUndefined();
    }
  });

  it("records an attestation against the PR's CURRENT head SHA fetched from GitHub, not anything the caller supplies", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 92, repo: INFRA_REPO, headSha: "real-head-sha", changedFiles: ["src/governor.ts"], diff: "", title: "t", body: "b" });
    const governanceGate = new GovernanceGateStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;
    const handler = attestHandler(params);

    const result = await handler({
      repo: INFRA_REPO,
      number: 92,
      verdict: "safe",
      reasoning: "Only widens a rate-limit defer window; no cap, check, or refusal removed.",
      headSha: "attacker-supplied-sha", // not part of the schema — proves it's ignored even if present
    } as never);

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("real-head-sha") }] });
    const attestation = await governanceGate.getAttestation(INFRA_REPO, 92);
    expect(attestation).toMatchObject({ headSha: "real-head-sha", verdict: "safe" });
  });
});

describe("mergePR governance gate", () => {
  function seedGovernorPr(github: FakeGithubTransport, overrides: Partial<Parameters<FakeGithubTransport["seedPullRequest"]>[0]> = {}) {
    github.seedPullRequest({
      number: 92, repo: INFRA_REPO, headSha: "sha-current", changedFiles: ["src/governor.ts"], diff: "", title: "t", body: "b",
      ...overrides,
    });
  }

  it("refuses when there is no attestation at all for a governance-only PR", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    const governanceGate = new GovernanceGateStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/no safety attestation/i) }] });
  });

  it("refuses when the recorded attestation is for a different (stale) head SHA", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    const governanceGate = new GovernanceGateStore(dir);
    await governanceGate.recordAttestation({ repo: INFRA_REPO, number: 92, headSha: "sha-old", verdict: "safe", reasoning: "fine at the time" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/no safety attestation/i) }] });
  });

  it("refuses, quoting the reasoning, when the attestation's own verdict is unsafe", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    const governanceGate = new GovernanceGateStore(dir);
    await governanceGate.recordAttestation({
      repo: INFRA_REPO, number: 92, headSha: "sha-current", verdict: "unsafe",
      reasoning: "removes the daily budget cap entirely",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("removes the daily budget cap entirely") }] });
  });

  it("merges, records the merge, and posts a distinct Discord alert when the attestation is safe and fresh", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    const governanceGate = new GovernanceGateStore(dir);
    await governanceGate.recordAttestation({
      repo: INFRA_REPO, number: 92, headSha: "sha-current", verdict: "safe",
      reasoning: "Only widens a rate-limit defer window; no cap, check, or refusal removed.",
    });
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) } as unknown as DiscordOutbox;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate, outbox });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Successfully merged") }] });
    expect(github.merged).toEqual([{ repo: INFRA_REPO, number: 92 }]);
    expect(await governanceGate.countRecentMerges()).toBe(1);
    expect(outbox.postAlert).toHaveBeenCalledTimes(1);
    const [channel, text] = (outbox.postAlert as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(channel).toBe("ops");
    expect(text).toContain(`${INFRA_REPO}#92`);
    expect(text).toContain("no human looked at this");
    expect(text).toContain("Only widens a rate-limit defer window");
  });

  it("refuses once the velocity cap is already reached, even with a fresh safe attestation", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    const governanceGate = new GovernanceGateStore(dir);
    for (let i = 0; i < MAX_GOVERNANCE_MERGES_PER_WINDOW; i++) {
      await governanceGate.recordMerge({ repo: INFRA_REPO, number: 100 + i, headSha: `sha-${i}` });
    }
    await governanceGate.recordAttestation({ repo: INFRA_REPO, number: 92, headSha: "sha-current", verdict: "safe", reasoning: "fine" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/cap/i) }] });
  });

  it("falls back to the unconditional refusal when the PR mixes a governance file with a floor (non-governance) excluded file, even with a safe attestation", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github, { changedFiles: ["src/governor.ts", "src/runner/sdk-runner.ts"] });
    const governanceGate = new GovernanceGateStore(dir);
    await governanceGate.recordAttestation({ repo: INFRA_REPO, number: 92, headSha: "sha-current", verdict: "safe", reasoning: "fine" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/never merge through this pipeline/i) }] });
  });

  it("falls back to the unconditional refusal for a governance-only PR when governanceGate is simply not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-current" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/never merge through this pipeline/i) }] });
  });

  it("still enforces the grant and stale-SHA gates after passing the governance gate", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    seedGovernorPr(github);
    const governanceGate = new GovernanceGateStore(dir);
    await governanceGate.recordAttestation({ repo: INFRA_REPO, number: 92, headSha: "sha-current", verdict: "safe", reasoning: "fine" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [INFRA_GRANT], pending: new PendingStore(dir), github, governanceGate });
    await collect(runner.execute(agent("pr-reviewer", { grantRefs: ["infra-repo"] }), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as GithubPrParams;

    // Stale expectedHeadSha, distinct from the PR's actual current head —
    // gate 3 must still refuse even though the governance gate passed.
    const result = await mergeHandler(params)({ repo: INFRA_REPO, number: 92, expectedHeadSha: "sha-old-from-before-a-new-commit" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("head moved") }] });
  });
});
