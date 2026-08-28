import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface CrashOutbox {
  postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered">;
}

/**
 * Separate from installCrashHandlers so the logging/alerting behavior is
 * testable without triggering a real process-level uncaughtException/
 * unhandledRejection (which vitest cannot safely simulate in-process).
 */
export async function logFatal(
  opts: { dataDir: string; outbox: CrashOutbox; channel: string },
  kind: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    mkdirSync(join(opts.dataDir, "state"), { recursive: true });
    appendFileSync(join(opts.dataDir, "state", "crash.log"), `${new Date().toISOString()} [${kind}] ${message}\n`);
  } catch (writeError) {
    // The disk itself may be part of what's broken — never let logging the
    // crash become a second, uncaught one.
    console.error("[fatal] could not write crash.log", writeError);
  }
  console.error(`[fatal] ${kind}:`, error);
  try {
    await opts.outbox.postAlert(opts.channel, `💥 Process crashing (${kind}): ${message.slice(0, 500)}`);
  } catch (alertError) {
    console.error("[fatal] could not post crash alert to Discord", alertError);
  }
}

/**
 * Without this, an unhandled rejection or uncaught exception anywhere just
 * kills the process with nothing but ephemeral container stdout as evidence.
 * Docker's `restart: unless-stopped` brings it back either way, but with this
 * installed there's a durable record of why on disk, and a best-effort
 * Discord alert — the difference between "something crashed at 3am, here's
 * what" and an unexplained restart nobody notices for days.
 */
export function installCrashHandlers(opts: { dataDir: string; outbox: CrashOutbox; channel: string }): void {
  const handleFatal = (kind: string, error: unknown): void => {
    // Bounded: a crash handler that hangs forever defeats the whole point of
    // restart-on-crash, so exit either way once the alert settles or a short
    // timeout elapses, whichever comes first.
    void logFatal(opts, kind, error).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("uncaughtException", (error) => handleFatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
}
