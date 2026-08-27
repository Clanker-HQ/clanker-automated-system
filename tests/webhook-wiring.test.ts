import { describe, expect, it, vi } from "vitest";
import type { WebhookEvent } from "../src/control/webhook-receiver.js";
import { FakeGithubTransport } from "../src/control/github-transport.js";
import { makeWebhookHandler } from "../src/control/webhook-wiring.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { AgentDef } from "../src/registry.js";

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "pr-reviewer",
    enabled: true,
    trigger: { type: "webhook", repo: "owner/repo", event: "pull_request" },
    ...overrides,
  } as unknown as AgentDef;
}

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return { repo: "owner/repo", event: "pull_request", action: "opened", pullRequestNumber: 7, ...overrides };
}

function githubWithSeededPr(overrides: Partial<Parameters<FakeGithubTransport["seedPullRequest"]>[0]> = {}): FakeGithubTransport {
  const github = new FakeGithubTransport();
  github.seedPullRequest({
    number: 7, repo: "owner/repo", headSha: "sha-1",
    changedFiles: ["src/index.ts"], diff: "diff --git a/x b/x\n+evil line", title: "A change", body: "Does a thing.",
    ...overrides,
  });
  return github;
}

describe("makeWebhookHandler", () => {
  it("resolves the matching enabled webhook agent and hands executeRun a prompt with the PR's content fenced as untrusted", async () => {
    const github = githubWithSeededPr();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const handler = makeWebhookHandler({ agents: [agent()], github, orchestrator });

    await handler(event());

    expect(executeRun).toHaveBeenCalledTimes(1);
    const [calledAgent, , promptContext] = executeRun.mock.calls[0] as [AgentDef, Date, string];
    expect(calledAgent.name).toBe("pr-reviewer");
    expect(promptContext).toContain("Head SHA: sha-1");

    // The prompt-injection boundary (Task 9 review, Important #6): title,
    // description, changed files and diff are all PR-submitter-controlled
    // text and must be fenced off as data, not spliced in unmarked.
    const beginIdx = promptContext.indexOf("--- BEGIN UNTRUSTED PR CONTENT ---");
    const endIdx = promptContext.indexOf("--- END UNTRUSTED PR CONTENT ---");
    expect(beginIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(beginIdx);
    for (const needle of ["Title: A change", "Does a thing.", "src/index.ts", "evil line"]) {
      const idx = promptContext.indexOf(needle);
      expect(idx, `expected "${needle}" to appear`).toBeGreaterThan(beginIdx);
      expect(idx, `expected "${needle}" to appear before the closing marker`).toBeLessThan(endIdx);
    }
    // The head SHA is the one thing the agent must treat as ground truth
    // (mergePR's stale-SHA check depends on it) — it must NOT sit inside the
    // untrusted block alongside attacker-controlled text.
    expect(promptContext.indexOf("Head SHA: sha-1")).toBeLessThan(beginIdx);
  });

  it("does not call executeRun for a disabled webhook agent, even with a matching repo/event", async () => {
    const github = githubWithSeededPr();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const handler = makeWebhookHandler({ agents: [agent({ enabled: false })], github, orchestrator });

    await handler(event());

    expect(executeRun).not.toHaveBeenCalled();
  });

  it("does not call executeRun when no agent matches the event's repo", async () => {
    const github = githubWithSeededPr();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const handler = makeWebhookHandler({ agents: [agent()], github, orchestrator });

    await handler(event({ repo: "owner/some-other-repo" }));

    expect(executeRun).not.toHaveBeenCalled();
  });

  it("does not match a cron-triggered agent, even if it happened to share a name", async () => {
    const github = githubWithSeededPr();
    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;
    const cronAgent = agent({ trigger: { type: "cron", schedule: "0 6 * * *", timezone: "UTC" } } as never);
    const handler = makeWebhookHandler({ agents: [cronAgent], github, orchestrator });

    await handler(event());

    expect(executeRun).not.toHaveBeenCalled();
  });
});
