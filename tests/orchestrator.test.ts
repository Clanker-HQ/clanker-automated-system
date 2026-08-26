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
    expect(result.status).toBe("timeout");
  });

  it("records a timeout as timeout even when the runner throws on abort", async () => {
    const { agent, orchestrator } = harness(
      { events: [], hangForever: true, throwOnAbort: true },
      { run: INSTANT_TIMEOUT } as Partial<AgentDef>,
    );
    const result = await orchestrator.executeRun(agent);
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

  it("halts when the STOP file is present", async () => {
    const { agent, orchestrator, dataDir } = harness({
      events: [{ type: "assistant", text: "ok" }],
    });
    writeFileSync(join(dataDir, "STOP"), "");
    const result = await orchestrator.executeRun(agent);
    expect(result.status).toBe("killed");
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
    });

    const result = await orchestrator.executeRun(agent);

    expect(result.status).toBe("success");
    expect(outbox.post).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalled();
    const loggedText = stderrSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedText).toContain(result.runId);
    expect(loggedText).toContain(agent.name);

    stderrSpy.mockRestore();
  });
});
