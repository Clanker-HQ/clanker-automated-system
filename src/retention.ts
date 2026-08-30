import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryStore } from "./memory/memory-store.js";

export interface RetentionResult {
  removedRuns: string[];
  removedWorkspaceFiles: string[];
  removedMemoryRecords: number;
}

/**
 * Deletes run directories (transcript + result.json) whose recorded
 * `startedAt` is older than the cutoff, and specialist-written workspace
 * files (e.g. research findings) whose mtime is older than it. Pure
 * filesystem work — no LLM call, no cost, so it's cheap to run and to test.
 *
 * A run directory still missing result.json (in progress, or a crash that
 * never closed it) is left alone rather than guessed at from directory mtime
 * — deleting a run that's still writing would be a real, hard-to-diagnose
 * loss, and it eventually gets a result.json (and thus becomes eligible) once
 * it actually finishes.
 */
export async function pruneOldData(opts: {
  dataDir: string;
  olderThan: Date;
  memory?: { store: MemoryStore; olderThan: Date; reflectionsOlderThan: Date };
}): Promise<RetentionResult> {
  const removedRuns: string[] = [];
  const runsRoot = join(opts.dataDir, "runs");
  for (const runId of await readdir(runsRoot).catch(() => [] as string[])) {
    const raw = await readFile(join(runsRoot, runId, "result.json"), "utf8").catch(() => null);
    if (raw === null) continue;
    let startedAt: string | undefined;
    try {
      startedAt = (JSON.parse(raw) as { startedAt?: string }).startedAt;
    } catch {
      continue; // Corrupt result.json — leave it for a human to look at, not guess.
    }
    if (startedAt !== undefined && new Date(startedAt) < opts.olderThan) {
      await rm(join(runsRoot, runId), { recursive: true, force: true });
      removedRuns.push(runId);
    }
  }

  const removedWorkspaceFiles: string[] = [];
  const workspacesRoot = join(opts.dataDir, "workspaces");
  for (const agentName of await readdir(workspacesRoot).catch(() => [] as string[])) {
    const agentDir = join(workspacesRoot, agentName);
    for (const file of await readdir(agentDir).catch(() => [] as string[])) {
      const filePath = join(agentDir, file);
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile() || info.mtime >= opts.olderThan) continue;
      await rm(filePath, { force: true });
      removedWorkspaceFiles.push(join(agentName, file));
    }
  }

  // Two cutoffs, not one: a reflection is already a compressed synthesis of
  // many raw records, so throwing it away on the raw schedule would discard
  // the most condensed thing in the log first.
  let removedMemoryRecords = 0;
  if (opts.memory) {
    removedMemoryRecords =
      (await opts.memory.store.prune({ olderThan: opts.memory.olderThan, keepKinds: ["reflection"] })) +
      (await opts.memory.store.prune({ olderThan: opts.memory.reflectionsOlderThan, keepKinds: [] }));
  }

  return { removedRuns, removedWorkspaceFiles, removedMemoryRecords };
}

/**
 * A run directory with no result.json is normally just still running — but a
 * real run finishes well within its `timeoutMinutes` cap (180 minutes, max),
 * so one whose transcript hasn't been written to in `olderThan` almost
 * certainly means the process died mid-run rather than that it's still going.
 * pruneOldData() deliberately never deletes these (see its own comment) — this
 * only reports them, so a crash that would otherwise sit invisible on disk
 * forever gets surfaced instead.
 */
export async function findOrphanedRuns(opts: { dataDir: string; olderThan: Date }): Promise<string[]> {
  const orphaned: string[] = [];
  const runsRoot = join(opts.dataDir, "runs");
  for (const runId of await readdir(runsRoot).catch(() => [] as string[])) {
    const runDir = join(runsRoot, runId);
    const hasResult = await stat(join(runDir, "result.json")).then(
      () => true,
      () => false,
    );
    if (hasResult) continue;
    const transcript = await stat(join(runDir, "transcript.jsonl")).catch(() => null);
    if (transcript && transcript.mtime < opts.olderThan) orphaned.push(runId);
  }
  return orphaned;
}
