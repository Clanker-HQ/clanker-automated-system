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

export interface WebhookRetryEntry {
  id: string;
  event: WebhookEvent;
  attempts: number;
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

  async create(event: WebhookEvent): Promise<WebhookRetryEntry> {
    await mkdir(this.dir(), { recursive: true });
    const now = new Date().toISOString();
    const entry: WebhookRetryEntry = { id: randomUUID(), event, attempts: 1, createdAt: now, lastAttemptAt: now };
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

  /** Bumps the attempt count and lastAttemptAt on an existing entry — a no-op returning null if it was already resolved (e.g. by a concurrent drain). */
  async recordAttempt(id: string): Promise<WebhookRetryEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    const next: WebhookRetryEntry = { ...entry, attempts: entry.attempts + 1, lastAttemptAt: new Date().toISOString() };
    await writeFile(this.path(id), JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  async resolve(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
