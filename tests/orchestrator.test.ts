import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { DiscordOutbox } from "../src/outbox/discord.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { FakeScript } from "../src/runner/fake-runner.js";
import type { Runner } from "../src/runner/types.js";

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
  const orchestrator = new Orchestrator({
    runner,
    store: new RunStore(dataDir),
    outbox: new DiscordOutbox({
      config: CONFIG,
      dataDir,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    }),
    dataDir,
    governor: { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() } as never,
  });
  return { agent, orchestrator, dataDir, fetchImpl };
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
        { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.001, durationMs: 900 },
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
        yield { type: "usage", inputTokens: 40, outputTokens: 9, costUsd: 0.02, durationMs: 60 };
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
      governor: { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() } as never,
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
    const orchestrator = new Orchestrator({ runner, store, outbox: outbox as never, dataDir: store["dataDir"] as never, governor: governor as never });

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
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });

    await orchestrator.executeRun(AGENT);

    expect(outbox.postAlert).toHaveBeenCalledWith(AGENT.outbox.discord, expect.stringContaining("daily budget reached"));
    expect(outbox.post).not.toHaveBeenCalled();
  });

  it("releases the governor's slot after a successful run", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
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
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
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
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
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
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
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
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("denied");
    expect(result?.error).toContain("no grant matches");
  });

  it("resumeRun asks the governor with kind 'resume' and calls the runner with the session id", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const runner = new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }] });
    const executeSpy = vi.spyOn(runner, "execute");
    const orchestrator = new Orchestrator({
      runner, store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
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
        { type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
      ] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
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
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    await orchestrator.executeRun(AGENT);
    expect(governor.recordRateLimitError).toHaveBeenCalledTimes(1);
  });
});
