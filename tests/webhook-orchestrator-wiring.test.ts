import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApprovedGrantsStore } from "../src/state/approved-grants.js";
import { BreakerStore } from "../src/state/breaker.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { FakeGithubTransport } from "../src/control/github-transport.js";
import { WebhookReceiver } from "../src/control/webhook-receiver.js";
import { makeWebhookHandler } from "../src/control/webhook-wiring.js";
import { Governor } from "../src/governor.js";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { RunStore } from "../src/run-store.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { AgentDef } from "../src/registry.js";

const SECRET = "test-webhook-secret";
const CONFIG = parseConfig("config.yaml", "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n");

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function prPayload(repo: string, number: number, action = "opened"): string {
  // author_association defaults to a trusted value so this file's tests
  // (none of which are about author trust) keep exercising the accepted
  // path — see tests/webhook-receiver.test.ts for the dedicated coverage
  // of the author-association filter itself.
  return JSON.stringify({ action, number, repository: { full_name: repo }, pull_request: { author_association: "OWNER" } });
}

/** Mirrors tests/orchestrator.test.ts's realHarness() — a real Governor
 * over a real (temp-dir) RunStore/BreakerStore, with a FakeRunner standing
 * in for SdkRunner, since this test's job is the webhook->agent resolution
 * and admission path, not the merge-gating logic (already covered at the
 * SdkRunner unit level in Tasks 7-8).
 *
 * Uses the real `makeWebhookHandler` (src/control/webhook-wiring.ts) rather
 * than a hand-reimplementation of index.ts's onEvent closure — that's the
 * exact function index.ts itself calls, extracted out precisely so it can
 * be exercised for real here instead of by a copy that could quietly drift
 * from what actually ships. */
function buildSystem(agentOverrides: Partial<AgentDef> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-webhook-wiring-"));
  const promptPath = join(dataDir, "prompt.md");
  writeFileSync(promptPath, "Review the PR.");

  const prReviewerAgent = {
    name: "pr-reviewer", enabled: true, dir: dataDir, promptPath,
    workspace: join(dataDir, "workspaces", "pr-reviewer"),
    trigger: { type: "webhook", repo: "owner/repo", event: "pull_request" },
    run: { model: "claude-sonnet-5", effort: "high", maxTurns: 60, maxBudgetUsd: 3, timeoutMinutes: 30 },
    outbox: { discord: "smoke", notifyOn: [] },
    ...agentOverrides,
  } as unknown as AgentDef;

  const store = new RunStore(dataDir);
  const breaker = new BreakerStore(dataDir);
  const governor = new Governor({
    dataDir, config: CONFIG, store,
    overrides: new ConfigOverridesStore(dataDir),
    rateLimits: new RateLimitTracker(dataDir),
    breaker,
  });
  const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn().mockResolvedValue("delivered") } as never;
  const approvedGrants = new ApprovedGrantsStore(dataDir);
  const runner = new FakeRunner({ events: [{ type: "assistant", text: "reviewed" }] });
  const executeSpy = vi.spyOn(runner, "execute");
  const orchestrator = new Orchestrator({ runner, store, outbox, dataDir, governor, breaker, approvedGrants });

  const github = new FakeGithubTransport();
  github.seedPullRequest({
    number: 7, repo: "owner/repo", headSha: "sha-1",
    changedFiles: ["src/index.ts"], diff: "diff --git a/src/index.ts...", title: "A change", body: "Does a thing.",
  });

  const agents = [prReviewerAgent];
  const receiver = new WebhookReceiver({ secret: SECRET });
  receiver.onEvent(makeWebhookHandler({ agents, github, orchestrator }));

  return { receiver, executeSpy, dataDir, github };
}

describe("webhook -> agent resolution", () => {
  it("triggers the matching webhook-triggered agent's run, with the PR's actual content in its prompt", async () => {
    const { receiver, executeSpy } = buildSystem();
    const body = prPayload("owner/repo", 7);

    const result = await receiver.handleRequest(body, sign(body));
    expect(result.status).toBe(202);

    // handleRequest fires the handler asynchronously (fire-and-forget, per
    // Task 6) — the handler itself runs a real Governor/RunStore/BreakerStore
    // over real (temp-dir) disk I/O, which can take longer than a single
    // event-loop tick, so poll for the call rather than trusting a fixed
    // delay to always be long enough.
    await vi.waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(1));
    const ctxArg = executeSpy.mock.calls[0]![1] as { prompt: string };
    expect(ctxArg.prompt).toContain("Head SHA: sha-1");
    expect(ctxArg.prompt).toContain("src/index.ts");
    // The prompt-injection boundary (Important #6): PR-authored content must
    // be fenced off, not spliced in as if it were part of the instructions.
    // The markers carry a per-run nonce (final review's Important #3), so
    // match by shape rather than by a fixed literal string.
    const beginMatch = /^--- BEGIN (UNTRUSTED-[0-9a-f-]{36}) ---$/m.exec(ctxArg.prompt);
    expect(beginMatch, "expected a nonce-bearing BEGIN fence marker").not.toBeNull();
    expect(ctxArg.prompt).toContain(`--- END ${beginMatch![1]!} ---`);
  });

  it("does not trigger any run for a disabled webhook agent, even for a matching repo/event", async () => {
    const { receiver, executeSpy } = buildSystem({ enabled: false });
    const body = prPayload("owner/repo", 7);

    const result = await receiver.handleRequest(body, sign(body));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.status).toBe(202); // the HTTP layer still accepts the event...
    expect(executeSpy).not.toHaveBeenCalled(); // ...but the disabled agent never runs
  });

  it("does not trigger any run for a repo with no matching webhook-triggered agent", async () => {
    const { receiver, executeSpy } = buildSystem();
    const body = prPayload("owner/some-other-repo", 3);

    await receiver.handleRequest(body, sign(body));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does not trigger a run for an unsigned/forged webhook, even for a matching repo", async () => {
    const { receiver, executeSpy } = buildSystem();
    const body = prPayload("owner/repo", 7);

    const result = await receiver.handleRequest(body, "sha256=forged");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.status).toBe(401);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
