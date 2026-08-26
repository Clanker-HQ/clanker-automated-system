import { mkdir, appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "./runner/types.js";

export type RunStatus =
  | "success" | "failed" | "timeout" | "budget-exceeded" | "killed" | "interrupted"
  | "parked" | "question" | "denied";

export interface RunResult {
  runId: string;
  agent: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  summary: string;
  error?: string;
}

/** Filesystem-safe on Windows: no colons. */
export function newRunId(agentName: string, now: Date = new Date()): string {
  return `${agentName}-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export interface RunWriter {
  readonly runId: string;
  append(event: RunEvent): Promise<void>;
  tail(lines: number): Promise<string[]>;
  close(partial: {
    status: RunStatus;
    summary: string;
    error?: string;
  }): Promise<RunResult>;
}

export class RunStore {
  constructor(private readonly dataDir: string) {}

  private runDir(runId: string): string {
    return join(this.dataDir, "runs", runId);
  }

  async open(runId: string, agentName: string): Promise<RunWriter> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const transcript = join(dir, "transcript.jsonl");

    // A resume (Task 13's `resumeRun`) reuses the SAME runId as the segment
    // that was parked: this run's directory (and its result.json) may
    // already exist from that earlier open()/close() pair. Seed the
    // counters — and `startedAt` — from it so the eventual close() below
    // reports the TRUE cumulative total across both segments, not just the
    // resumed one — otherwise close()'s writeFile silently overwrites
    // result.json with only the new segment's numbers, and the Governor's
    // daily-budget check (which sums costUsd across listRecent()'s
    // result.json files, bucketed by `startedAt`'s day) would undercount
    // this run's real spend and/or attribute it to the wrong day: an
    // unseeded `startedAt` would take on the resume's (possibly next-day)
    // time instead of the original run's, silently moving day 1's spend
    // into day 2's budget bucket. `durationMs` (endedAt - startedAt) also
    // falls out correctly once `startedAt` is the true original start.
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    let startedAt = new Date();
    const existing = await readFile(join(dir, "result.json"), "utf8")
      .then((raw) => JSON.parse(raw) as RunResult)
      .catch(() => null);
    if (existing) {
      costUsd = existing.costUsd;
      inputTokens = existing.inputTokens;
      outputTokens = existing.outputTokens;
      turns = existing.turns;
      startedAt = new Date(existing.startedAt);
    }
    let lastText = "";

    const writer: RunWriter = {
      runId,
      async append(event: RunEvent): Promise<void> {
        if (event.type === "usage") {
          costUsd += event.costUsd;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        }
        if (event.type === "tool_use") turns += 1;
        if (event.type === "assistant" && event.text.trim()) lastText = event.text.trim();
        await appendFile(transcript, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
      },
      async tail(lines: number): Promise<string[]> {
        const raw = await readFile(transcript, "utf8").catch(() => "");
        return raw.trim().split("\n").filter(Boolean).slice(-lines);
      },
      async close(partial): Promise<RunResult> {
        const endedAt = new Date();
        const result: RunResult = {
          runId,
          agent: agentName,
          status: partial.status,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
          costUsd,
          inputTokens,
          outputTokens,
          turns,
          summary: partial.summary || lastText,
          ...(partial.error ? { error: partial.error } : {}),
        };
        await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
        return result;
      },
    };
    return writer;
  }

  async readResult(runId: string): Promise<RunResult> {
    const raw = await readFile(join(this.runDir(runId), "result.json"), "utf8");
    return JSON.parse(raw) as RunResult;
  }

  async listRecent(limit: number): Promise<RunResult[]> {
    const root = join(this.dataDir, "runs");
    const dirs = await readdir(root).catch(() => [] as string[]);
    const results: RunResult[] = [];
    // Read all results first, then sort by time (not by directory name which sorts by agent name)
    for (const runId of dirs) {
      const result = await this.readResult(runId).catch(() => null);
      if (result) results.push(result);
    }
    // Sort by startedAt descending (most recent first)
    results.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return results.slice(0, limit);
  }
}
