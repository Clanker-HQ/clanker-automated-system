import { Cron } from "croner";
import { findOrphanedRuns, pruneOldData } from "../retention.js";

/** Well beyond any agent's timeoutMinutes cap (180 minutes, max) — a run this stale with no result.json almost certainly crashed rather than being still in progress. */
const ORPHAN_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

interface RetentionOutbox {
  postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered">;
}

export function startRetention(opts: {
  schedule: string;
  timezone: string;
  dataDir: string;
  days: number;
  channel: string;
  outbox: RetentionOutbox;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, () => {
    void (async () => {
      const olderThan = new Date(now().getTime() - opts.days * 24 * 60 * 60 * 1000);
      const { removedRuns, removedWorkspaceFiles } = await pruneOldData({ dataDir: opts.dataDir, olderThan });
      const orphanedRuns = await findOrphanedRuns({
        dataDir: opts.dataDir,
        olderThan: new Date(now().getTime() - ORPHAN_STALE_AFTER_MS),
      });
      console.log(
        `[retention] removed ${removedRuns.length} run(s), ${removedWorkspaceFiles.length} workspace file(s) older than ${opts.days}d; ` +
          `${orphanedRuns.length} orphaned run(s) found`,
      );
      // Quiet on a no-op sweep: most weeks there's nothing to report, and a
      // message every week saying "nothing happened" is pure noise.
      if (removedRuns.length > 0 || removedWorkspaceFiles.length > 0 || orphanedRuns.length > 0) {
        const lines = [`🧹 Cleaned up ${removedRuns.length} run(s) and ${removedWorkspaceFiles.length} workspace file(s) older than ${opts.days} days.`];
        if (orphanedRuns.length > 0) {
          // Reported, never deleted — see findOrphanedRuns' own comment.
          lines.push(`⚠️ ${orphanedRuns.length} run(s) look crashed (no result ever recorded): ${orphanedRuns.slice(0, 5).join(", ")}`);
        }
        await opts.outbox.postAlert(opts.channel, lines.join("\n"));
      }
    })().catch((error: unknown) => {
      console.error("[retention] failed to prune old data", error);
    });
  });
  console.log(
    `[retention] scheduled "${opts.schedule}" (${opts.timezone}), pruning data older than ${opts.days}d; next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
