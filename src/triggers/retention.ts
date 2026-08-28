import { Cron } from "croner";
import { pruneOldData } from "../retention.js";

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
      console.log(`[retention] removed ${removedRuns.length} run(s), ${removedWorkspaceFiles.length} workspace file(s) older than ${opts.days}d`);
      // Quiet on a no-op sweep: most weeks there's nothing to report, and a
      // message every week saying "nothing to clean up" is pure noise.
      if (removedRuns.length > 0 || removedWorkspaceFiles.length > 0) {
        await opts.outbox.postAlert(
          opts.channel,
          `🧹 Cleaned up ${removedRuns.length} run(s) and ${removedWorkspaceFiles.length} workspace file(s) older than ${opts.days} days.`,
        );
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
