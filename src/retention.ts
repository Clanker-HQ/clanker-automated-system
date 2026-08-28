import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface RetentionResult {
  removedRuns: string[];
  removedWorkspaceFiles: string[];
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
export async function pruneOldData(opts: { dataDir: string; olderThan: Date }): Promise<RetentionResult> {
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

  return { removedRuns, removedWorkspaceFiles };
}
