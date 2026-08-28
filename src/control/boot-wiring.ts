import type { DiscordBot } from "./bot.js";
import type { PendingStore } from "./pending.js";

/**
 * Reconciles pending approval/question entries left over from a previous
 * process, then connects the Discord bot and re-posts any still-active
 * entries.
 *
 * Reconciliation always runs, independent of Discord connectivity — a bad
 * token, a network drop, or a Discord outage must not stop expired entries
 * from being auto-denied (that's `reconcile` itself) or the active count
 * from being logged. `bot.start()`'s rejection is caught and logged right
 * here rather than left as an unhandled rejection or allowed to crash the
 * process; a failed connection just means re-posting active entries is
 * skipped, since that genuinely needs a live connection, while cron and the
 * governor carry on unaffected.
 */
export async function reconcileAndConnectBot(opts: {
  pending: PendingStore;
  bot: DiscordBot;
  timeoutHours: number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const logError = opts.logError ?? ((line: string) => console.error(line));

  const reconcilePromise = opts.pending.reconcile({ timeoutHours: opts.timeoutHours });

  // Kicked off concurrently with reconciliation, not nested inside it, so a
  // slow or failing Discord connection never delays or gates the
  // unconditional reconcile work below. Both branches resolve to a boolean
  // rather than rejecting, so this can never become an unhandled rejection.
  const botStartPromise = opts.bot.start().then(
    () => {
      log("[boot] Discord bot connected");
      return true;
    },
    (error: unknown) => {
      logError("\n[boot] Failed to connect the Discord bot. Admin commands and approval prompts are unavailable.\n");
      logError(error instanceof Error ? error.message : String(error));
      return false;
    },
  );

  const { expired, active } = await reconcilePromise;
  for (const entry of expired) {
    log(`[pending] expired (auto-denied): ${entry.id} for ${entry.agentName}`);
  }
  log(`[pending] ${active.length} awaiting a response after startup`);

  // Runs regardless of Discord connectivity, same as reconcile() above — a
  // dispatched task's record staying accurate doesn't depend on whether the
  // failure can also be announced in the channel right now.
  const failedTasks = await opts.bot.failTasksForExpiredEntries(expired);
  for (const { task } of failedTasks) {
    log(`[pending] task ${task.id} marked failed — its approval/question request expired unanswered`);
  }

  const connected = await botStartPromise;
  if (!connected) return;
  if (failedTasks.length > 0) await opts.bot.notifyExpiredTaskFailures(failedTasks);
  for (const entry of active) {
    if (entry.kind === "approval") await opts.bot.postApproval(entry);
    else await opts.bot.postQuestion(entry);
  }
}
