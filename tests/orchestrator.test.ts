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

const CONFIG = parseConfig(
  "config.yaml",
  "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n",
);
const ENV = { DISCORD_WEBHOOK_SMOKE: "https://discord.test/hook" };

function harness(script: FakeScript, agentOverrides: Partial<AgentDef> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-orch-"));
  const promptPath = join(dataDir, "prompt.md");
  writeFileSync(promptPath, "Do the thing.");

  const agent = {
    name: "smoke",
    enabled: true,
    dir: dataDir,
    promptPath,
    workspace: join(dataDir, "workspaces", "smoke"),
    run: { model: "claude-haiku-4-5", effort: "medium", maxTurns: 5,
           timeoutMinutes: 0.001, maxBudgetUsd: 0.1 },
    outbox: { discord: "smoke", notifyOn: ["success", "failure"] },
    ...agentOverrides,
  } as unknown as AgentDef;

  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const orchestrator = new Orchestrator({
    runner: new FakeRunner(script),
    store: new RunStore(dataDir),
    outbox: new DiscordOutbox({ config: CONFIG, dataDir, env: ENV, fetchImpl, sleep: async () => {} }),
    dataDir,
  });
  return { agent, orchestrator, dataDir, fetchImpl };
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts a run that exceeds its timeout", async () => {
    const { agent, orchestrator } = harness({ events: [], hangForever: true });
    const result = await orchestrator.executeRun(agent);
    expect(result.status).toBe("timeout");
  });

  it("records a timeout as timeout even when the runner throws on abort", async () => {
    const { agent, orchestrator } = harness({ events: [], hangForever: true, throwOnAbort: true });
    const result = await orchestrator.executeRun(agent);
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("minute limit");
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
      run: { model: "claude-haiku-4-5", effort: "medium", maxTurns: 5,
             timeoutMinutes: 0.001, maxBudgetUsd: 0.1 },
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
