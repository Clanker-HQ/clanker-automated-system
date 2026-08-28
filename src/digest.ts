import type { TaskStore } from "./control/task-store.js";
import type { RunStore } from "./run-store.js";

/**
 * Pure text-building, deliberately separate from src/triggers/digest.ts's
 * scheduling: no LLM call, no cron dependency, so it's cheap to unit test
 * against a plain RunStore/TaskStore fixture.
 */
export async function buildDigestText(opts: { store: RunStore; tasks: TaskStore; since: Date }): Promise<string> {
  const recentRuns = (await opts.store.listRecent(10_000)).filter((r) => new Date(r.startedAt) >= opts.since);
  const spentUsd = recentRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const byStatus = new Map<string, number>();
  for (const r of recentRuns) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

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
  const shown = failedTasks.slice(0, 5);
  for (const t of shown) {
    lines.push(`❌ \`${t.id.slice(0, 8)}\` — ${t.failureReason ?? "(no reason recorded)"}`);
  }
  if (failedTasks.length > shown.length) {
    lines.push(`…and ${failedTasks.length - shown.length} more failed task(s) — see \`!tasks\`/\`!result\`.`);
  }
  return lines.join("\n");
}
