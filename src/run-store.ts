import { mkdir, appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { VerifiedOutcome } from "./control/outcome-verifier.js";
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
  /**
   * Set only for a status "success" run, and only when an OutcomeVerifier was
   * wired in (Orchestrator's `verifier` dep) — grades whether the agent's
   * actual objective was achieved, not just that the SDK finished without
   * erroring. Absent means "not graded", never "graded and unclear".
   */
  verifiedOutcome?: VerifiedOutcome;
}

/** Filesystem-safe on Windows: no colons. */
export function newRunId(agentName: string, now: Date = new Date()): string {
  return `${agentName}-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/** The trailing timestamp newRunId embeds, e.g. "-2026-08-26T12-00-00-000Z" — anchored to the end so a dash anywhere in the agent name can't be mistaken for part of it. */
const RUN_ID_TIMESTAMP = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

/** Reverses newRunId's `:`/`.` -> `-` substitution and parses it, or null if runId doesn't end in the expected shape (defensive — every real runId does). */
function runIdTimestamp(runId: string): Date | null {
  const match = runId.match(RUN_ID_TIMESTAMP);
  if (!match) return null;
  const iso = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The agent name embedded in a runId, recovered by stripping the timestamp suffix newRunId appended -- never by prefix-matching, which would let "cleanup" wrongly match "cleanup-scout-...". */
function runIdAgentName(runId: string): string | null {
  const match = runId.match(RUN_ID_TIMESTAMP);
  if (!match) return null;
  return runId.slice(0, runId.length - match[1]!.length - 1);
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

  /**
   * Like the `tail()` a RunWriter exposes while a run is still open
   * (see `writer.tail` above), but for any run id after the fact — used by
   * the dashboard's run-detail view, which has no open writer to ask.
   */
  async readTranscriptTail(runId: string, lines: number): Promise<string[]> {
    const raw = await readFile(join(this.runDir(runId), "transcript.jsonl"), "utf8").catch(() => "");
    return raw.trim().split("\n").filter(Boolean).slice(-lines);
  }

  /**
   * Stamps a verification verdict onto an already-closed run — verification
   * happens after writer.close() (it grades the run's own final summary), so
   * it can't be folded into that write. Rewrites the same result.json a
   * second time rather than a separate file: every other reader (listRecent,
   * listSince, !runs, the digest) already reads exactly one file per run.
   */
  async recordVerification(runId: string, verifiedOutcome: VerifiedOutcome): Promise<RunResult> {
    const existing = await this.readResult(runId);
    const updated: RunResult = { ...existing, verifiedOutcome };
    await writeFile(join(this.runDir(runId), "result.json"), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  }

  /**
   * The most recent run for one agent, or null if it has never run -- used
   * by the digest's cron-liveness check to answer "when did this agent last
   * actually run" without reading every result.json ever retained. Only
   * filenames are read here (via the runId-embedded timestamp); the winning
   * directory's result.json is read once, at the end.
   */
  async latestFor(agentName: string): Promise<RunResult | null> {
    const root = join(this.dataDir, "runs");
    const dirs = await readdir(root).catch(() => [] as string[]);
    let best: { runId: string; at: Date } | null = null;
    for (const runId of dirs) {
      if (runIdAgentName(runId) !== agentName) continue;
      const at = runIdTimestamp(runId);
      if (!at) continue;
      if (!best || at.getTime() > best.at.getTime()) best = { runId, at };
    }
    if (!best) return null;
    return this.readResult(best.runId).catch(() => null);
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

  /**
   * Like listRecent, but for a caller that only cares about a bounded time
   * window (Governor's daily-budget check: "today"; the digest: "the last
   * 24h") — reading and JSON-parsing every result.json ever retained
   * (`retention.days` defaults to 30, and can be raised or disabled) on every
   * single admission check doesn't scale with how much history has piled up,
   * only with how much of it falls in the window actually being asked about.
   *
   * The pre-filter uses the timestamp newRunId embeds in the directory name
   * itself, with a full day of slack on both sides of [from, to] — enough to
   * absorb the (sub-second, in practice) gap between that embedded timestamp
   * and the run's real recorded `startedAt` (see RunStore.open's seeding for
   * a resumed run). Every candidate that survives the pre-filter still gets
   * its result.json read and its REAL startedAt checked exactly as
   * listRecent does — this changes how many files get read, never which runs
   * end up counted.
   */
  async listSince(from: Date, to: Date = new Date()): Promise<RunResult[]> {
    const root = join(this.dataDir, "runs");
    const dirs = await readdir(root).catch(() => [] as string[]);
    const SLOP_MS = 24 * 60 * 60 * 1000;
    const fromMs = from.getTime() - SLOP_MS;
    const toMs = to.getTime() + SLOP_MS;
    const results: RunResult[] = [];
    for (const runId of dirs) {
      const embedded = runIdTimestamp(runId);
      // No parseable timestamp (an unexpected runId shape) is read anyway,
      // never silently skipped — only a runId that PROVES it's out of range
      // gets to skip the read.
      if (embedded && (embedded.getTime() < fromMs || embedded.getTime() > toMs)) continue;
      const result = await this.readResult(runId).catch(() => null);
      if (result && new Date(result.startedAt) >= from && new Date(result.startedAt) <= to) {
        results.push(result);
      }
    }
    results.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return results;
  }
}
