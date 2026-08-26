import { mkdir, appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "./runner/types.js";

export type RunStatus =
  | "success" | "failed" | "timeout" | "budget-exceeded" | "killed" | "interrupted";

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
    const startedAt = new Date();

    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
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
    for (const runId of dirs.sort().reverse().slice(0, limit)) {
      const result = await this.readResult(runId).catch(() => null);
      if (result) results.push(result);
    }
    return results;
  }
}
