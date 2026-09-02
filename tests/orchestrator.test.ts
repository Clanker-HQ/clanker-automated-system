import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { FakeOutcomeVerifier, type OutcomeVerifier } from "../src/control/outcome-verifier.js";
import { Governor } from "../src/governor.js";
import { Orchestrator, workspaceNote } from "../src/orchestrator.js";
import { DiscordOutbox } from "../src/outbox/discord.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { ApprovedGrantsStore } from "../src/state/approved-grants.js";
import { BreakerStore } from "../src/state/breaker.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { FakeScript } from "../src/runner/fake-runner.js";
import type { RunContext, Runner } from "../src/runner/types.js";

const CONFIG = parseConfig(
  "config.yaml",
  "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n",
);
const WEBHOOK = "https://discord.test/hook";
const ENV = { DISCORD_WEBHOOK_SMOKE: WEBHOOK };

const RUN_DEFAULTS = {
  model: "claude-haiku-4-5",
  effort: "medium",
  maxTurns: 5,
  maxBudgetUsd: 0.1,
};

/**
 * 60ms. Only the two timeout tests may use this: executeRun does a mkdir, a
 * readFile and two appendFiles before the runner is even reached, and on a
 * loaded Windows box that is not reliably under 60ms — a shared 0.001 made
 * every other test able to fail as a spurious "timeout".
 */
const INSTANT_TIMEOUT = { ...RUN_DEFAULTS, timeoutMinutes: 0.001 };
const NORMAL_TIMEOUT = { ...RUN_DEFAULTS, timeoutMinutes: 5 };

/**
 * A standalone agent fixture (not built via `harness()`) for the governor
 * tests below, which construct their own `Orchestrator` with custom
 * governor/outbox/store stubs. It has a real prompt file on disk so that
 * tests exercising an admitted run (which reach the real `readFile`) succeed.
 */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "cai-orch-agent-"));
const AGENT_PROMPT_PATH = join(AGENT_DIR, "prompt.md");
writeFileSync(AGENT_PROMPT_PATH, "Do the thing.");
const AGENT = {
  name: "smoke",
  enabled: true,
  dir: AGENT_DIR,
  promptPath: AGENT_PROMPT_PATH,
  workspace: join(AGENT_DIR, "workspaces", "smoke"),
  run: NORMAL_TIMEOUT,
  outbox: { discord: "smoke", notifyOn: ["success", "failure"] },
} as unknown as AgentDef;

function harness(
  script: FakeScript,
  agentOverrides: Partial<AgentDef> = {},
  runner: Runner = new FakeRunner(script),
  verifier?: OutcomeVerifier,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-orch-"));
  const promptPath = join(dataDir, "prompt.md");
  writeFileSync(promptPath, "Do the thing.");

  const agent = {
    name: "smoke",
    enabled: true,
    dir: dataDir,
    promptPath,
    workspace: join(dataDir, "workspaces", "smoke"),
    run: NORMAL_TIMEOUT,
    outbox: { discord: "smoke", notifyOn: ["success", "failure"] },
    ...agentOverrides,
  } as unknown as AgentDef;

  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
  );
  const approvedGrants = new ApprovedGrantsStore(dataDir);
  const store = new RunStore(dataDir);
  const orchestrator = new Orchestrator({
    runner,
    store,
    outbox: new DiscordOutbox({
      config: CONFIG,
      dataDir,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    }),
    dataDir,
    governor: {
      admit: vi.fn().mockResolvedValue({ kind: "admit" }),
      releaseSlot: vi.fn(),
      recordRateLimit: vi.fn().mockResolvedValue(undefined),
      recordRateLimitError: vi.fn().mockResolvedValue(undefined),
    } as never,
    breaker: new BreakerStore(dataDir),
    approvedGrants,
    ...(verifier ? { verifier } : {}),
  });
  return { agent, orchestrator, dataDir, fetchImpl, approvedGrants, runner, store };
}

/** The URL and parsed JSON body of one recorded webhook POST. */
function postedCall(
  fetchImpl: ReturnType<typeof harness>["fetchImpl"],
  index = 0,
): { url: string; body: { content: string } } {
  const call = fetchImpl.mock.calls[index];
  if (!call) throw new Error(`no webhook POST was recorded at index ${index}`);
  return { url: String(call[0]), body: JSON.parse(String(call[1]!.body)) };
}

describe("Orchestrator.executeRun", () => {
  it("runs, records a transcript and result, and reports", async () => {
    const { agent, orchestrator, dataDir, fetchImpl } = harness({
      events: [
        { type: "assistant", text: "Done: wrote notes." },
        { type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001, durationMs: 900 },
      ],
    });

    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Done: wrote notes.");
    expect(existsSync(join(dataDir, "runs", result.runId, "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "runs", result.runId, "result.json"))).toBe(true);
    expect(existsSync(agent.workspace)).toBe(true);

    // What is posted, not merely that something was posted: an empty body or
    // a post to the wrong channel's webhook used to pass every test here.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, body } = postedCall(fetchImpl);
    expect(url).toBe(WEBHOOK);
    expect(body.content).toContain(agent.name);
    expect(body.content).toContain(result.summary);
    expect(body.content).toContain(result.runId);
  });

  it("records a failure and still reports it", async () => {
    const { agent, orchestrator, fetchImpl } = harness({
      // FakeRunner checks `yielded >= throwAfter` before each yield, so the
      // throw only fires on the iteration AFTER the configured count — a
      // single-event script with throwAfter: 1 would never throw (see
      // tests/fake-runner.test.ts's own two-event throwAfter case). A second,
      // never-emitted event is included purely so the throw actually fires.
      events: [{ type: "assistant", text: "starting" }, { type: "assistant", text: "unreachable" }],
      throwAfter: 1,
    });
    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("scripted failure");

    // A failure must carry its reason AND the transcript tail to Discord;
    // dropping either used to pass.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, body } = postedCall(fetchImpl);
    expect(url).toBe(WEBHOOK);
    expect(body.content).toContain(agent.name);
    expect(body.content).toContain("scripted failure");
    expect(body.content).toContain("starting"); // the tail of the transcript
  });

  it("aborts a run that exceeds its timeout", async () => {
    const { agent, orchestrator } = harness({ events: [], hangForever: true }, {
      run: INSTANT_TIMEOUT,
    } as Partial<AgentDef>);
    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");
    expect(result.status).toBe("timeout");
  });

  it("records a timeout as timeout even when the runner throws on abort", async () => {
    const { agent, orchestrator } = harness(
      { events: [], hangForever: true, throwOnAbort: true },
      { run: INSTANT_TIMEOUT } as Partial<AgentDef>,
    );
    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("minute limit");
  });

  // SdkRunner now maps a message before checking the abort signal, so that an
  // aborted run keeps the cost accounting carried by the terminal `result`
  // message (which the SDK marks with an error subtype *because* it was
  // aborted). That terminal error must not re-label a timeout as a plain
  // failure: the catch block already guards this race, and the event loop
  // needs the same guard.
  it("keeps a timed-out run labelled timeout when the runner emits a terminal error after the abort, and keeps its usage", async () => {
    const lateReporter: Runner = {
      async *execute(_agent, _ctx, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "usage", inputTokens: 40, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.02, durationMs: 60 };
        yield {
          type: "error",
          message: 'SDK run ended with subtype "error_during_execution" (is_error=true)',
        };
      },
    };

    const { agent, orchestrator } = harness(
      { events: [] },
      { run: INSTANT_TIMEOUT } as Partial<AgentDef>,
      lateReporter,
    );

    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");

    expect(result.status).toBe("timeout");
    expect(result.error).toContain("minute limit");
    expect(result.costUsd).toBe(0.02);
    expect(result.inputTokens).toBe(40);
  });

  it("suppresses reporting when the status is not in notifyOn", async () => {
    const { agent, orchestrator, fetchImpl } = harness(
      { events: [{ type: "assistant", text: "ok" }] },
      { outbox: { discord: "smoke", notifyOn: ["failure"] } } as Partial<AgentDef>,
    );
    await orchestrator.executeRun(agent);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still returns a successful RunResult when reporting fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-orch-"));
    const promptPath = join(dataDir, "prompt.md");
    writeFileSync(promptPath, "Do the thing.");

    const agent = {
      name: "smoke",
      enabled: true,
      dir: dataDir,
      promptPath,
      workspace: join(dataDir, "workspaces", "smoke"),
      run: NORMAL_TIMEOUT,
      outbox: { discord: "smoke", notifyOn: ["success", "failure"] },
    } as unknown as AgentDef;

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outbox = {
      post: vi.fn(async () => {
        throw new Error("webhook is down");
      }),
    } as unknown as DiscordOutbox;

    const orchestrator = new Orchestrator({
      runner: new FakeRunner({
        events: [{ type: "assistant", text: "Done: wrote notes." }],
      }),
      store: new RunStore(dataDir),
      outbox,
      dataDir,
      governor: {
      admit: vi.fn().mockResolvedValue({ kind: "admit" }),
      releaseSlot: vi.fn(),
      recordRateLimit: vi.fn().mockResolvedValue(undefined),
      recordRateLimitError: vi.fn().mockResolvedValue(undefined),
    } as never,
      breaker: new BreakerStore(dataDir),
      approvedGrants: new ApprovedGrantsStore(dataDir),
    });

    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");

    expect(result.status).toBe("success");
    expect(outbox.post).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalled();
    const loggedText = stderrSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedText).toContain(result.runId);
    expect(loggedText).toContain(agent.name);

    stderrSpy.mockRestore();
  });

  it("does not execute the runner, and creates no run record, when the governor refuses", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "refuse", reason: "quiet hours", alert: false }), releaseSlot: vi.fn() };
    const runner = new FakeRunner({ events: [] });
    const executeSpy = vi.spyOn(runner, "execute");
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-")));
    const outbox = { post: vi.fn(), postAlert: vi.fn().mockResolvedValue("delivered") };
    const orchestrator = new Orchestrator({ runner, store, outbox: outbox as never, dataDir: store["dataDir"] as never, governor: governor as never, breaker: new BreakerStore(store["dataDir"] as never), approvedGrants: new ApprovedGrantsStore(store["dataDir"] as never) });

    const result = await orchestrator.executeRun(AGENT);

    expect(result).toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
    await expect(store.listRecent(10)).resolves.toEqual([]);
  });

  it("posts an alert (not a run report) when the governor's refusal is alert-worthy", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "refuse", reason: "daily budget reached", alert: true }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn(), postAlert: vi.fn().mockResolvedValue("delivered") };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [] }), store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });

    await orchestrator.executeRun(AGENT);

    expect(outbox.postAlert).toHaveBeenCalledWith(AGENT.outbox.discord, expect.stringContaining("daily budget reached"));
    expect(outbox.post).not.toHaveBeenCalled();
  });

  it("releases the governor's slot after a successful run", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1 }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });

    await orchestrator.executeRun(AGENT);
    expect(governor.releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("releases the governor's slot even when the run throws", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "assistant", text: "a" }], throwAfter: 0 }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });

    await orchestrator.executeRun(AGENT);
    expect(governor.releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("records status 'parked' (not 'failed') when the runner emits a parked event, and does not treat it as an error", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "parked", kind: "approval", pendingId: "p1" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("parked");
    expect(result?.error).toBeUndefined();
  });

  it("records status 'question' when the runner emits a parked event with kind question", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "parked", kind: "question", pendingId: "p1" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("question");
  });

  it("records status 'denied' when the runner emits a denied event", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "denied", reason: "no grant matches" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("denied");
    expect(result?.error).toContain("no grant matches");
  });

  it("resumeRun asks the governor with kind 'resume' and calls the runner with the session id", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const runner = new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1 }] });
    const executeSpy = vi.spyOn(runner, "execute");
    const orchestrator = new Orchestrator({
      runner, store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });

    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-1", agentName: AGENT.name, sessionId: "sess-abc", kind: "approval", effect: "x", grantRef: "g", askedAt: new Date().toISOString() },
      { approved: true },
      AGENT,
    );

    expect(governor.admit).toHaveBeenCalledWith(AGENT, "resume");
    const ctxArg = executeSpy.mock.calls[0]![1] as { resume?: string };
    expect(ctxArg.resume).toBe("sess-abc");
  });

  it("feeds a rate_limit_event seen mid-run to the governor live, not only after the run finishes", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn(), recordRateLimit: vi.fn(), recordRateLimitError: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [
        { type: "rate_limit_event", status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91 },
        { type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1 },
      ] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });
    await orchestrator.executeRun(AGENT);
    expect(governor.recordRateLimit).toHaveBeenCalledWith({
      status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: undefined,
    });
  });

  it("calls the governor's reactive backoff when an assistant error reports rate_limit", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn(), recordRateLimit: vi.fn(), recordRateLimitError: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "error", message: "assistant message reported error: rate_limit" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });
    await orchestrator.executeRun(AGENT);
    expect(governor.recordRateLimitError).toHaveBeenCalledTimes(1);
  });

  it("appends promptContext to the file-read prompt when provided", async () => {
    const { agent, orchestrator, runner } = harness({ events: [{ type: "assistant", text: "ok" }] });
    const executeSpy = vi.spyOn(runner, "execute");
    await orchestrator.executeRun(agent, new Date(), "Extra per-run context.");
    const ctxArg = executeSpy.mock.calls[0]![1] as { prompt: string };
    expect(ctxArg.prompt).toContain("Do the thing.");
    expect(ctxArg.prompt).toContain("Extra per-run context.");
  });

  it("prompt is unchanged when promptContext is omitted (cron's existing behaviour)", async () => {
    const { agent, orchestrator, runner } = harness({ events: [{ type: "assistant", text: "ok" }] });
    const executeSpy = vi.spyOn(runner, "execute");
    await orchestrator.executeRun(agent);
    const ctxArg = executeSpy.mock.calls[0]![1] as { prompt: string };
    // The workspace note is appended to every run now. What this still guards
    // — and the reason it stays an exact match — is that NOTHING ELSE is,
    // when no promptContext was passed.
    expect(ctxArg.prompt).toBe(`Do the thing.

${workspaceNote(agent.workspace)}`);
  });

  it("refuses to resume a pending entry with no sessionId, without touching the runner", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const runner = new FakeRunner({ events: [{ type: "assistant", text: "should never run" }] });
    const executeSpy = vi.spyOn(runner, "execute");
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-")));
    const orchestrator = new Orchestrator({
      runner, store, outbox: outbox as never, dataDir: "unused",
      governor: governor as never, breaker: new BreakerStore(mkdtempSync(join(tmpdir(), "cai-orch-brk-"))),
      approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-orch-appr-"))),
    });

    const result = await orchestrator.resumeRun(
      { id: "p-nosession", runId: "smoke-1", agentName: AGENT.name, sessionId: "", kind: "approval", effect: "x", grantRef: "g", askedAt: new Date().toISOString() },
      { approved: true },
      AGENT,
    );

    expect(result).toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
    // Not even admitted: no slot is taken and nothing is recorded.
    expect(governor.admit).not.toHaveBeenCalled();
    await expect(store.listRecent(10)).resolves.toEqual([]);
    expect(stderrSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("p-nosession");
    stderrSpy.mockRestore();
  });
});

describe("Orchestrator's onParked announcement hook", () => {
  function parkHarness(events: FakeScript["events"], onParked?: (pendingId: string, kind: "approval" | "question") => Promise<void>) {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-orch-park-"));
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events }),
      store: new RunStore(dataDir),
      outbox: { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() } as never,
      dataDir,
      governor: {
      admit: vi.fn().mockResolvedValue({ kind: "admit" }),
      releaseSlot: vi.fn(),
      recordRateLimit: vi.fn().mockResolvedValue(undefined),
      recordRateLimitError: vi.fn().mockResolvedValue(undefined),
    } as never,
      breaker: new BreakerStore(dataDir),
      approvedGrants: new ApprovedGrantsStore(dataDir),
      ...(onParked ? { onParked } : {}),
    });
    return orchestrator;
  }

  it("calls onParked with the pending id and kind the moment a run parks for approval", async () => {
    const onParked = vi.fn().mockResolvedValue(undefined);
    const orchestrator = parkHarness([{ type: "parked", kind: "approval", pendingId: "pending-42" }], onParked);
    const result = await orchestrator.executeRun(AGENT);
    expect(onParked).toHaveBeenCalledTimes(1);
    expect(onParked).toHaveBeenCalledWith("pending-42", "approval");
    expect(result?.status).toBe("parked");
  });

  it("calls onParked with kind 'question' for a question park", async () => {
    const onParked = vi.fn().mockResolvedValue(undefined);
    const orchestrator = parkHarness([{ type: "parked", kind: "question", pendingId: "pending-q" }], onParked);
    await orchestrator.executeRun(AGENT);
    expect(onParked).toHaveBeenCalledWith("pending-q", "question");
  });

  // A resumed run can park again into a *new* pending entry (an agent that
  // asks a second question). The hook lives in runAndRecord, which both paths
  // share, so this must announce too.
  it("also announces a park that happens on the resume path", async () => {
    const onParked = vi.fn().mockResolvedValue(undefined);
    const orchestrator = parkHarness([{ type: "parked", kind: "question", pendingId: "pending-second" }], onParked);
    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-1", agentName: AGENT.name, sessionId: "sess-abc", kind: "question", question: "which?", askedAt: new Date().toISOString() },
      { answer: "this one" },
      AGENT,
    );
    expect(onParked).toHaveBeenCalledWith("pending-second", "question");
  });

  it("does not fail the run when the announcement itself throws", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onParked = vi.fn().mockRejectedValue(new Error("discord is down"));
    const orchestrator = parkHarness([{ type: "parked", kind: "approval", pendingId: "pending-x" }], onParked);
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("parked");
    expect(result?.error).toBeUndefined();
    expect(stderrSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("pending-x");
    stderrSpy.mockRestore();
  });

  it("runs fine with no onParked hook supplied at all", async () => {
    const orchestrator = parkHarness([{ type: "parked", kind: "approval", pendingId: "pending-none" }]);
    await expect(orchestrator.executeRun(AGENT)).resolves.toMatchObject({ status: "parked" });
  });
});

/**
 * Covers the actual bug: an agent parks for approval, a human approves, the
 * resumed run retries the exact same outward effect. Without persisting the
 * approval and threading it back into the resumed run's RunContext,
 * SdkRunner's canUseTool has no memory of the approval and parks again from
 * scratch — approve -> resume -> retry -> park, forever. These tests go
 * through a REAL ApprovedGrantsStore (via `harness`), the same way "a real
 * circuit breaker" below proves the breaker is actually wired, not just
 * unit-tested in isolation.
 */
describe("Orchestrator.resumeRun grant approval persistence", () => {
  it("persists an approved grant and forwards it in the resumed run's RunContext", async () => {
    const runner = new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1 }] });
    const executeSpy = vi.spyOn(runner, "execute");
    const { agent, orchestrator, approvedGrants } = harness({ events: [] }, {}, runner);

    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-persist", agentName: agent.name, sessionId: "sess-abc", kind: "approval", effect: "network call", grantRef: "test-echo", askedAt: new Date().toISOString() },
      { approved: true },
      agent,
    );

    expect(await approvedGrants.read("smoke-persist")).toEqual(["test-echo"]);
    const ctxArg = executeSpy.mock.calls[0]![1] as { approvedGrantRefs?: string[] };
    expect(ctxArg.approvedGrantRefs).toContain("test-echo");
  });

  // The exact scenario that was looping live: two resumes of the SAME run,
  // approving a different grant each time. The second resume must see BOTH
  // — proof that approvals accumulate across multiple park/resume cycles
  // within one run, not just the most recent one.
  it("accumulates approvals across sequential resumes of the same run", async () => {
    const runner = new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1 }] });
    const executeSpy = vi.spyOn(runner, "execute");
    const { agent, orchestrator, approvedGrants } = harness({ events: [] }, {}, runner);

    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-loop", agentName: agent.name, sessionId: "sess-1", kind: "approval", effect: "x", grantRef: "a", askedAt: new Date().toISOString() },
      { approved: true },
      agent,
    );
    await orchestrator.resumeRun(
      { id: "p2", runId: "smoke-loop", agentName: agent.name, sessionId: "sess-2", kind: "approval", effect: "y", grantRef: "b", askedAt: new Date().toISOString() },
      { approved: true },
      agent,
    );

    expect(await approvedGrants.read("smoke-loop")).toEqual(["a", "b"]);
    expect(executeSpy.mock.calls).toHaveLength(2);
    const secondCtx = executeSpy.mock.calls[1]![1] as { approvedGrantRefs?: string[] };
    expect(secondCtx.approvedGrantRefs).toEqual(["a", "b"]);
  });

  it("does not persist anything when the resume decision is a denial", async () => {
    const runner = new FakeRunner({ events: [{ type: "assistant", text: "ok" }] });
    const { agent, orchestrator, approvedGrants } = harness({ events: [] }, {}, runner);

    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-deny", agentName: agent.name, sessionId: "sess-1", kind: "approval", effect: "x", grantRef: "a", askedAt: new Date().toISOString() },
      { approved: false },
      agent,
    );

    expect(await approvedGrants.read("smoke-deny")).toEqual([]);
  });
});

/**
 * The circuit breaker was fully built and unit-tested, and Governor.admit read
 * it — but nothing in production ever called recordResult, so
 * consecutiveFailures was permanently 0 and the breaker could never trip. Every
 * other orchestrator test above stubs the governor with vi.fn(), which is
 * exactly why that gap was invisible; this block wires a REAL BreakerStore and
 * a REAL Governor so the loop is closed end to end.
 */
describe("Orchestrator + a real circuit breaker", () => {
  function realHarness(script: FakeScript) {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-orch-real-"));
    const promptPath = join(dataDir, "prompt.md");
    writeFileSync(promptPath, "Do the thing.");
    const agent = {
      name: "smoke", enabled: true, dir: dataDir, promptPath,
      workspace: join(dataDir, "workspaces", "smoke"),
      run: NORMAL_TIMEOUT,
      outbox: { discord: "smoke", notifyOn: [] },
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
    const orchestrator = new Orchestrator({ runner: new FakeRunner(script), store, outbox, dataDir, governor, breaker, approvedGrants });

    /** A second orchestrator over the SAME store/governor/breaker, running a different script. */
    const withScript = (other: FakeScript) =>
      new Orchestrator({ runner: new FakeRunner(other), store, outbox, dataDir, governor, breaker, approvedGrants });

    return { agent, orchestrator, breaker, governor, approvedGrants, withScript };
  }

  /** Two events with throwAfter: 1 — FakeRunner only throws on the iteration after the count, so a single-event script would never fail. */
  const FAILING: FakeScript = {
    events: [{ type: "assistant", text: "starting" }, { type: "assistant", text: "unreachable" }],
    throwAfter: 1,
  };

  it("trips after three consecutive failed triggered runs, and the governor then refuses the next one", async () => {
    const { agent, orchestrator, breaker, governor } = realHarness(FAILING);

    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);
    expect(await breaker.isTripped(agent.name)).toBe(false);

    await orchestrator.executeRun(agent);
    expect(await breaker.isTripped(agent.name)).toBe(true);

    // The whole point: a tripped breaker actually stops the next trigger.
    await expect(governor.admit(agent, "trigger")).resolves.toMatchObject({ kind: "refuse" });
    expect(await orchestrator.executeRun(agent)).toBeUndefined();
  });

  it("clears the failure count again once a run succeeds", async () => {
    const { agent, orchestrator, breaker, withScript } = realHarness(FAILING);
    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);

    // One success resets the streak, so two further failures still don't trip.
    await withScript({ events: [{ type: "assistant", text: "fine" }] }).executeRun(agent);
    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);
    expect(await breaker.isTripped(agent.name)).toBe(false);
  });

  it("does not count a resume toward tripping the breaker", async () => {
    const { agent, orchestrator, breaker } = realHarness(FAILING);

    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);

    // A failing *resume* between them must not be the third strike.
    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-resume", agentName: agent.name, sessionId: "sess-abc", kind: "approval", effect: "x", grantRef: "g", askedAt: new Date().toISOString() },
      { approved: true },
      agent,
    );
    expect(await breaker.isTripped(agent.name)).toBe(false);

    await orchestrator.executeRun(agent);
    expect(await breaker.isTripped(agent.name)).toBe(true);
  });
});

describe("Orchestrator outcome verification", () => {
  it("grades a successful run and persists the verdict on the returned/stored result", async () => {
    const verifier = new FakeOutcomeVerifier({ verdict: "not-achieved", reason: "only checked one option" });
    const { agent, orchestrator, store } = harness(
      { events: [{ type: "assistant", text: "Done: picked the first option." }] },
      {},
      undefined,
      verifier,
    );
    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");

    expect(result.verifiedOutcome).toEqual({ verdict: "not-achieved", reason: "only checked one option" });
    const stored = await store.readResult(result.runId);
    expect(stored.verifiedOutcome).toEqual({ verdict: "not-achieved", reason: "only checked one option" });
  });

  it("passes the run's own prompt, summary, and transcript tail to the verifier", async () => {
    const verifier = new FakeOutcomeVerifier({ verdict: "achieved", reason: "fine" });
    const { agent, orchestrator } = harness(
      { events: [{ type: "assistant", text: "starting" }, { type: "assistant", text: "Done: wrote notes." }] },
      {},
      undefined,
      verifier,
    );
    await orchestrator.executeRun(agent);

    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]!.prompt).toContain("Do the thing.");
    expect(verifier.calls[0]!.summary).toBe("Done: wrote notes.");
    expect(verifier.calls[0]!.tail.join("\n")).toContain("starting");
  });

  it("passes the run's own cost/turns and the agent's ceiling to the verifier", async () => {
    const verifier = new FakeOutcomeVerifier({ verdict: "achieved", reason: "fine" });
    const { agent, orchestrator } = harness(
      {
        events: [
          { type: "tool_use", name: "WebSearch" },
          { type: "tool_use", name: "WebFetch" },
          { type: "assistant", text: "Done: wrote notes." },
          { type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.05, durationMs: 900 },
        ],
      },
      {},
      undefined,
      verifier,
    );
    await orchestrator.executeRun(agent);

    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]!.costUsd).toBe(0.05);
    expect(verifier.calls[0]!.maxBudgetUsd).toBe(agent.run.maxBudgetUsd);
    expect(verifier.calls[0]!.turns).toBe(2);
    expect(verifier.calls[0]!.maxTurns).toBe(agent.run.maxTurns);
  });

  it("never grades a run that isn't a clean success", async () => {
    const verifier = new FakeOutcomeVerifier({ verdict: "achieved", reason: "fine" });
    const { agent, orchestrator } = harness(
      { events: [{ type: "assistant", text: "starting" }, { type: "assistant", text: "unreachable" }], throwAfter: 1 },
      {},
      undefined,
      verifier,
    );
    const result = await orchestrator.executeRun(agent);
    expect(result?.status).toBe("failed");
    expect(verifier.calls).toHaveLength(0);
    expect(result?.verifiedOutcome).toBeUndefined();
  });

  it("still returns and reports a successful run when the verifier itself throws", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingVerifier: OutcomeVerifier = { verify: vi.fn().mockRejectedValue(new Error("grading call exploded")) };
    const { agent, orchestrator, fetchImpl } = harness(
      { events: [{ type: "assistant", text: "Done: wrote notes." }] },
      {},
      undefined,
      failingVerifier,
    );
    const result = await orchestrator.executeRun(agent);
    if (!result) throw new Error("expected a RunResult");

    expect(result.status).toBe("success");
    expect(result.verifiedOutcome).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("grading call exploded");
    stderrSpy.mockRestore();
  });

  it("runs fine with no verifier supplied at all (existing behaviour)", async () => {
    const { agent, orchestrator } = harness({ events: [{ type: "assistant", text: "ok" }] });
    const result = await orchestrator.executeRun(agent);
    expect(result?.status).toBe("success");
    expect(result?.verifiedOutcome).toBeUndefined();
  });

  it("posts a warning with the transcript tail to Discord when the verdict is not-achieved", async () => {
    const verifier = new FakeOutcomeVerifier({ verdict: "not-achieved", reason: "missed the actual ask" });
    const { agent, orchestrator, fetchImpl } = harness(
      { events: [{ type: "assistant", text: "clue in the tail" }, { type: "assistant", text: "Done: wrote notes." }] },
      {},
      undefined,
      verifier,
    );
    await orchestrator.executeRun(agent);

    const { body } = postedCall(fetchImpl);
    expect(body.content).toContain("⚠️");
    expect(body.content).toContain("not-achieved");
    expect(body.content).toContain("missed the actual ask");
    expect(body.content).toContain("clue in the tail");
  });

  it("does not mention verification in the Discord post when the verdict is achieved", async () => {
    const verifier = new FakeOutcomeVerifier({ verdict: "achieved", reason: "did exactly what was asked" });
    const { agent, orchestrator, fetchImpl } = harness(
      { events: [{ type: "assistant", text: "Done: wrote notes." }] },
      {},
      undefined,
      verifier,
    );
    await orchestrator.executeRun(agent);

    const { body } = postedCall(fetchImpl);
    expect(body.content).not.toContain("Verification");
    expect(body.content).not.toContain("did exactly what was asked");
  });
});

// Every agent prompt says "your workspace", and until this landed nothing made
// that true: the runner passes cwd: ctx.workspace to the SDK, but file tools
// resolve a relative path against the PROCESS working directory. An agent told
// to write "findings-x.md" put it in the repo root instead of its own
// directory — observed 2026-09-02, and the reason an earlier run's output
// landed in /tmp. The separation docs/decisions.md claims as the reason
// per-run sandboxing was unnecessary only holds if agents know where to write.
describe("Orchestrator workspace disclosure", () => {
  function capturing(): { runner: Runner; seen: () => RunContext | undefined } {
    let captured: RunContext | undefined;
    return {
      runner: {
        // eslint-disable-next-line require-yield
        async *execute(_agent: AgentDef, ctx: RunContext) {
          captured = ctx;
        },
      } as unknown as Runner,
      seen: () => captured,
    };
  }

  it("gives the agent its workspace as an absolute path", async () => {
    const { runner, seen } = capturing();
    const { agent, orchestrator } = harness({ events: [] }, {}, runner);

    await orchestrator.executeRun(agent);

    expect(seen()?.prompt).toContain(agent.workspace);
  });

  it("keeps the agent's own prompt and any per-run context intact", async () => {
    const { runner, seen } = capturing();
    const { agent, orchestrator } = harness({ events: [] }, {}, runner);

    await orchestrator.executeRun(agent, new Date(), "## Extra\n\nper-run context");

    const prompt = seen()?.prompt ?? "";
    expect(prompt).toContain("Do the thing.");
    expect(prompt).toContain("per-run context");
    expect(prompt).toContain(agent.workspace);
  });
});

// Hitting the subscription's rate limit is the environment saying "not now",
// not the agent failing at its task. It was recorded as "failed", which
// BreakerStore counts — so three limit hits in a row disabled the agent, and
// every subsequent dispatch re-posted "circuit breaker tripped" to Discord.
// With a queue of pending tasks that is a loop, and none of it was research's
// fault. Same shape as the tool-failure fix: classify, don't blame.
describe("Orchestrator rate-limit classification", () => {
  it("records a rate-limited run as interrupted, not failed", async () => {
    const { agent, orchestrator, store } = harness({
      events: [{ type: "error", message: "assistant message reported error: rate_limit" }],
    });

    const result = await orchestrator.executeRun(agent);

    expect(result?.status).toBe("interrupted");
    expect((await store.listRecent(5))[0]?.status).toBe("interrupted");
  });

  it("does not let repeated rate limits trip the agent's breaker", async () => {
    const { agent, orchestrator, dataDir } = harness({
      events: [{ type: "error", message: "assistant message reported error: rate_limit" }],
    });

    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);

    expect(await new BreakerStore(dataDir).isTripped(agent.name)).toBe(false);
  });

  it("still records a genuine failure as failed", async () => {
    const { agent, orchestrator } = harness({
      events: [{ type: "error", message: "TypeError: cannot read property of undefined" }],
    });

    expect((await orchestrator.executeRun(agent))?.status).toBe("failed");
  });
});

// The breaker refusal used to alert on EVERY refused trigger. With a queue of
// pending tasks that is a loop: the same "circuit breaker tripped" line posted
// to Discord over and over, describing a state rather than reporting an event.
// Announce the trip once, when it happens, and say how to clear it.
describe("Orchestrator breaker announcement", () => {
  it("announces the trip once, when the breaker actually trips", async () => {
    const { agent, orchestrator, dataDir, fetchImpl } = harness({
      events: [{ type: "error", message: "TypeError: boom" }],
    });

    await orchestrator.executeRun(agent);
    await orchestrator.executeRun(agent);
    const before = fetchImpl.mock.calls.length;
    await orchestrator.executeRun(agent);

    expect(await new BreakerStore(dataDir).isTripped(agent.name)).toBe(true);
    const posted = fetchImpl.mock.calls.slice(before).map((c) => JSON.parse(String(c[1]!.body)).content as string);
    const trip = posted.filter((t) => /circuit breaker/i.test(t));
    expect(trip).toHaveLength(1);
    expect(trip[0]).toContain("!enable smoke");
  });
});
