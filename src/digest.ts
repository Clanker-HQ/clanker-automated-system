import type { MemoryConfig } from "./config.js";
import type { TaskStore } from "./control/task-store.js";
import type { MemoryStore } from "./memory/memory-store.js";
import type { RunStore } from "./run-store.js";

/**
 * Pure text-building, deliberately separate from src/triggers/digest.ts's
 * scheduling: no LLM call, no cron dependency, so it's cheap to unit test
 * against a plain RunStore/TaskStore fixture.
 */
export async function buildDigestText(opts: {
  store: RunStore;
  tasks: TaskStore;
  since: Date;
  memory?: MemoryStore;
  /**
   * Only ever consulted to SUPPRESS the memory section when memory is
   * explicitly switched off. An absent config means "no opinion" (test
   * fixtures that pass a store and nothing else), not "disabled" — production
   * always passes both.
   */
  memoryConfig?: MemoryConfig;
}): Promise<string> {
  // listSince, not listRecent(10_000): the digest only ever looks at the last
  // 24h, so there's no reason to read/parse every result.json retention has
  // kept around (up to 30 days by default, or more/forever if raised/disabled).
  // The upper bound is derived from `since` (double the digest's normal 24h
  // window), not `new Date()` — this must stay correct against whatever
  // clock `since` itself was computed from, not the real wall clock, the
  // same reasoning that made Governor.spentToday's window symmetric.
  const recentRuns = await opts.store.listSince(opts.since, new Date(opts.since.getTime() + 48 * 60 * 60 * 1000));
  const spentUsd = recentRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const byStatus = new Map<string, number>();
  for (const r of recentRuns) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  // Runs the SDK reported as "success" but whose objective an OutcomeVerifier
  // graded as NOT met — a silent-failure mode `byStatus` alone can never
  // surface, since it only ever sees "success".
  const notAchieved = recentRuns.filter((r) => r.verifiedOutcome?.verdict === "not-achieved").length;

  const allTasks = await opts.tasks.list();
  const finishedTasks = allTasks.filter(
    (t) => (t.status === "done" || t.status === "failed") && t.finishedAt !== undefined && new Date(t.finishedAt) >= opts.since,
  );
  const doneTasks = finishedTasks.filter((t) => t.status === "done");
  const failedTasks = finishedTasks.filter((t) => t.status === "failed");
  // Not scoped to `since`: a task the owner hasn't answered yet matters
  // regardless of how long ago its run parked — this is the one thing a
  // digest exists to make sure never gets missed.
  const waitingTasks = allTasks.filter((t) => t.status === "waiting");

  if (recentRuns.length === 0 && finishedTasks.length === 0 && waitingTasks.length === 0) {
    return "📅 Daily digest: nothing happened in the last 24h.";
  }

  const statusSummary = [...byStatus.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
  const lines = [
    "📅 **Daily digest** (last 24h)",
    `Runs: ${recentRuns.length}${statusSummary ? ` (${statusSummary})` : ""} — $${spentUsd.toFixed(2)} spent`,
    `Tasks: ${doneTasks.length} done, ${failedTasks.length} failed`,
  ];
  if (waitingTasks.length > 0) {
    lines.push(`⏳ Waiting on you: ${waitingTasks.map((t) => t.id.slice(0, 8)).join(", ")}`);
  }
  if (notAchieved > 0) {
    lines.push(`⚠️ ${notAchieved} run(s) succeeded but did not achieve their objective — see \`!runs\`.`);
  }
  const shown = failedTasks.slice(0, 5);
  for (const t of shown) {
    lines.push(`❌ \`${t.id.slice(0, 8)}\` — ${t.failureReason ?? "(no reason recorded)"}`);
  }
  if (failedTasks.length > shown.length) {
    lines.push(`…and ${failedTasks.length - shown.length} more failed task(s) — see \`!tasks\`/\`!result\`.`);
  }
  if (opts.memory && opts.memoryConfig?.enabled !== false) {
    const recentMemory = (await opts.memory.list()).filter((r) => new Date(r.ts) >= opts.since);
    const byKind = new Map<string, number>();
    for (const r of recentMemory) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const suppressed = recentMemory.filter((r) => r.kind === "proposal" && r.body.startsWith("suppressed as a duplicate")).length;
    if (recentMemory.length > 0) {
      const kindSummary = [...byKind.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
      lines.push(`🧠 Memory: ${kindSummary}${suppressed > 0 ? ` (${suppressed} duplicate proposal(s) suppressed)` : ""}`);
    }
  }
  return lines.join("\n");
}
