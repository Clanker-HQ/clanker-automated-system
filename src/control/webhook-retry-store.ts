import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebhookEvent } from "./webhook-receiver.js";

/**
 * How many times drainWebhookRetries will re-attempt a refused event before
 * giving up and posting a notice on the PR instead. Matches the "3
 * consecutive failures" family of caps elsewhere in this codebase
 * (BreakerStore, MAX_FIX_ATTEMPTS_PER_PR) in spirit, but higher: unlike
 * those, every retry here is cheap (Governor.admit()'s refusal checks are
 * local reads, no API call, no spend) and the thing being waited on — a
 * rate limit, a budget reset, quiet hours ending — can legitimately take
 * hours, so a low cap would give up long before the condition clears on its
 * own.
 */
export const MAX_WEBHOOK_RETRY_ATTEMPTS = 20;

/**
 * Separate cap for a defer whose wait time is KNOWN (a parsed session/rate
 * limit reset instant), mirroring dispatcher.ts's identically-named
 * constant and the same reasoning: each such defer jumps straight to the
 * real reset time rather than guessing, so it practically never needs more
 * than one or two before the window actually clears. Kept low anyway so a
 * bad parse or a limit that genuinely never clears can't defer forever.
 */
export const MAX_WEBHOOK_RATE_LIMIT_DEFERS = 5;

export interface WebhookRetryEntry {
  id: string;
  event: WebhookEvent;
  /**
   * Count of plain refusals/interruptions with no known reset time (a
   * Governor budget/quiet-hours refusal, or an interruption whose message
   * didn't parse a reset instant) — drained on the next tick, capped by
   * MAX_WEBHOOK_RETRY_ATTEMPTS. Session/rate-limit defers with a known reset
   * time do NOT bump this counter — see rateLimitDeferCount.
   */
  attempts: number;
  /**
   * Count of defers caused by a session/rate limit whose reset instant was
   * parsed out of the error message — capped separately by
   * MAX_WEBHOOK_RATE_LIMIT_DEFERS. Kept apart from `attempts` for the same
   * reason dispatcher.ts's rateLimitDeferCount is: a five-hour window ticked
   * every 30s would exhaust MAX_WEBHOOK_RETRY_ATTEMPTS in ten minutes, long
   * before the limit actually clears, if it shared that counter.
   */
  rateLimitDeferCount?: number;
  /**
   * When set, drainWebhookRetries skips this entry entirely (no attempt, no
   * defer bump, no processEvent call) until this instant — the known reset
   * time a rate/session limit named. Undefined means "eligible on the very
   * next drain tick", the original behavior for a plain refusal.
   */
  nextRetryAt?: string;
  createdAt: string;
  lastAttemptAt: string;
}

/**
 * Persists a webhook-triggered run that Governor.admit() refused (rate
 * limit, daily budget, quiet hours), so a periodic drain can retry it later
 * instead of the event being silently dropped forever — see
 * drainWebhookRetries in webhook-wiring.ts.
 *
 * Modeled directly on PendingStore's one-file-per-entry shape (same reasons:
 * durable across a restart, no single shared file to corrupt or race on).
 * Unlike PendingStore, entries here are never resumed by a human — they're
 * drained automatically once admission succeeds, or given up on past
 * MAX_WEBHOOK_RETRY_ATTEMPTS.
 */
export class WebhookRetryStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "webhook-retries");
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  /**
   * @param opts.rateLimitResetAt When this event's first refusal was itself
   * a session/rate limit with a known reset instant, the entry is created
   * already deferred to that instant instead of being eligible on the very
   * next drain tick — see `nextRetryAt`'s doc comment.
   */
  async create(event: WebhookEvent, opts?: { rateLimitResetAt?: Date }): Promise<WebhookRetryEntry> {
    await mkdir(this.dir(), { recursive: true });
    const now = new Date().toISOString();
    const entry: WebhookRetryEntry = opts?.rateLimitResetAt
      ? {
          id: randomUUID(), event, attempts: 0, rateLimitDeferCount: 1,
          nextRetryAt: opts.rateLimitResetAt.toISOString(), createdAt: now, lastAttemptAt: now,
        }
      : { id: randomUUID(), event, attempts: 1, createdAt: now, lastAttemptAt: now };
    await writeFile(this.path(entry.id), JSON.stringify(entry, null, 2) + "\n");
    return entry;
  }

  async get(id: string): Promise<WebhookRetryEntry | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as WebhookRetryEntry;
    } catch {
      return null;
    }
  }

  async list(): Promise<WebhookRetryEntry[]> {
    const files = await readdir(this.dir()).catch(() => [] as string[]);
    const entries: WebhookRetryEntry[] = [];
    for (const file of files) {
      const entry = await this.get(file.replace(/\.json$/, ""));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Bumps either `rateLimitDeferCount` (when `opts.rateLimitResetAt` names a
   * known reset instant — also refreshes `nextRetryAt` to it) or `attempts`
   * (otherwise, clearing `nextRetryAt` so the entry is eligible again on the
   * very next tick) — never both, so the two caps stay independent. A no-op
   * returning null if the entry was already resolved (e.g. by a concurrent
   * drain).
   */
  async recordAttempt(id: string, opts?: { rateLimitResetAt?: Date }): Promise<WebhookRetryEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    const lastAttemptAt = new Date().toISOString();
    const { nextRetryAt: _droppedNextRetryAt, ...rest } = entry;
    const next: WebhookRetryEntry = opts?.rateLimitResetAt
      ? {
          ...rest, rateLimitDeferCount: (entry.rateLimitDeferCount ?? 0) + 1,
          nextRetryAt: opts.rateLimitResetAt.toISOString(), lastAttemptAt,
        }
      : { ...rest, attempts: entry.attempts + 1, lastAttemptAt };
    await writeFile(this.path(id), JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  async resolve(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
