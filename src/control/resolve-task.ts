import type { Task, TaskStore } from "./task-store.js";

export type ResolvedTask = { task: Task } | { error: string; notFound: boolean };

/** Shared by `!result`/`!retry`/`!cancel` (bot.ts) and the dashboard's task endpoints: resolves the short id `!tasks` shows (or a full id) to exactly one task. */
export async function resolveTaskByPrefix(tasks: TaskStore, prefix: string): Promise<ResolvedTask> {
  const matches = await tasks.findByPrefix(prefix);
  if (matches.length === 0) return { error: `No task found starting with \`${prefix}\`.`, notFound: true };
  if (matches.length > 1) {
    // createdAt alone isn't a stable sort key — two tasks created back to
    // back can land on the same millisecond (seen in CI, where it's fast
    // enough to happen often; rare but not impossible locally too), and an
    // equal-createdAt tie left order dependent on whatever findByPrefix
    // happened to return, which isn't guaranteed. id as a tiebreaker makes
    // this message's order deterministic regardless of timing.
    const ids = matches
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((t) => t.id.slice(0, 8))
      .join(", ");
    return { error: `\`${prefix}\` matches ${matches.length} tasks — be more specific: ${ids}`, notFound: false };
  }
  return { task: matches[0]! };
}
