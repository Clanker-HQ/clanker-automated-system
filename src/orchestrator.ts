import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscordOutbox } from "./outbox/discord.js";
import type { AgentDef } from "./registry.js";
import { RunStore, newRunId, type RunResult, type RunStatus } from "./run-store.js";
import type { Runner } from "./runner/types.js";

export class Orchestrator {
  private readonly runner: Runner;
  private readonly store: RunStore;
  private readonly outbox: DiscordOutbox;
  private readonly dataDir: string;

  constructor(opts: {
    runner: Runner;
    store: RunStore;
    outbox: DiscordOutbox;
    dataDir: string;
  }) {
    this.runner = opts.runner;
    this.store = opts.store;
    this.outbox = opts.outbox;
    this.dataDir = opts.dataDir;
  }

  private stopRequested(): boolean {
    return existsSync(join(this.dataDir, "STOP"));
  }

  async executeRun(agent: AgentDef, now: Date = new Date()): Promise<RunResult> {
    const runId = newRunId(agent.name, now);
    const writer = await this.store.open(runId, agent.name);

    if (this.stopRequested()) {
      await writer.append({ type: "error", message: "STOP file present; run refused" });
      const result = await writer.close({
        status: "killed", summary: "Refused: STOP file present",
      });
      await this.report(agent, result, writer);
      return result;
    }

    await mkdir(agent.workspace, { recursive: true });
    const prompt = await readFile(agent.promptPath, "utf8");

    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.round(agent.run.timeoutMinutes * 60_000));
    let status: RunStatus = "success";
    let error: string | undefined;

    const timer = setTimeout(() => {
      status = "timeout";
      controller.abort();
    }, timeoutMs);

    try {
      const stream = this.runner.execute(
        agent,
        { runId, workspace: agent.workspace, prompt },
        controller.signal,
      );
      for await (const event of stream) {
        await writer.append(event);
        // The same race the catch block below guards: once the timer has
        // fired, "timeout" is the truthful classification and must win. A
        // runner may still emit a terminal error event *caused by* the abort
        // (SdkRunner maps the last message it pulled so the run's cost
        // accounting is not lost) — that must not re-label the run "failed".
        if (event.type === "error" && (status as RunStatus) !== "timeout") {
          status = "failed";
          error = event.message;
        }
      }
    } catch (thrown) {
      // `status` may already have been set to "timeout" by the setTimeout
      // callback above, racing this catch block. TypeScript's control-flow
      // narrowing cannot see across that closure boundary, so the comparison
      // is cast back to the full RunStatus union rather than left to be
      // (incorrectly) flagged as always-false.
      if ((status as RunStatus) !== "timeout") {
        status = "failed";
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      await writer.append({ type: "error", message: error ?? "aborted" });
    } finally {
      clearTimeout(timer);
    }

    if ((status as RunStatus) === "timeout") {
      error = `Run exceeded its ${agent.run.timeoutMinutes} minute limit and was aborted`;
    }

    const result = await writer.close({ status, summary: "", ...(error ? { error } : {}) });
    await this.report(agent, result, writer);
    return result;
  }

  private async report(
    agent: AgentDef,
    result: RunResult,
    writer: { tail(n: number): Promise<string[]> },
  ): Promise<void> {
    const category = result.status === "success" ? "success" : "failure";
    if (!agent.outbox.notifyOn.includes(category as "success" | "failure")) return;
    try {
      const tail = result.status === "success" ? undefined : await writer.tail(20);
      await this.outbox.post(agent.outbox.discord, result, tail);
    } catch (thrown) {
      // The run is already durably recorded (result.json was written before
      // this call). A reporting failure must never make a completed run
      // look like a crash to the caller — log it and move on.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.error(
        `[orchestrator] failed to report run ${result.runId} for agent "${agent.name}": ${message}`,
      );
    }
  }
}
