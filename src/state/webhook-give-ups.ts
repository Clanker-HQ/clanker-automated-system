import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One `(repo, PR)` pair drainWebhookRetries gave up retrying — the same
 * moment it already posts a "review it manually" comment on the PR itself
 * (webhook-wiring.ts). That comment was, until this store existed, the ONLY
 * trace of the give-up: nothing local remembered it happened, so a human
 * would only ever find out by browsing every repo's every PR by hand.
 */
export interface WebhookGiveUp {
  /** Why drainWebhookRetries stopped — the plain-refusal cap or the rate-limit-defer cap, whichever was reached. */
  reason: "attempts" | "rate-limit-defers";
  /** attempts + rateLimitDeferCount at the moment this was recorded — the same figure the give-up PR comment itself reports. */
  totalTries: number;
  createdAt: string;
  /** When the give-up itself happened (WebhookRetryEntry.lastAttemptAt at that moment) — distinct from createdAt, which is when the ORIGINAL event first got queued. */
  gaveUpAt: string;
}

/**
 * Tracks every webhook-triggered PR review drainWebhookRetries has given up
 * retrying, so digest.ts can report it — mirrors PrFixAttemptStore's
 * listExhausted() for the same underlying problem (a per-PR retry/attempt
 * cap being reached leaves its only trace on the PR itself, never anywhere
 * a human would see it without checking every repo). One JSON file, keyed by
 * `repo#PR`, same shape as pr-fix-attempts.json.
 */
export class WebhookGiveUpStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "webhook-give-ups.json");
  }

  private async readAll(): Promise<Record<string, WebhookGiveUp>> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as Record<string, WebhookGiveUp>;
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, WebhookGiveUp>): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFile(this.path(), JSON.stringify(data, null, 2) + "\n");
  }

  async record(key: string, giveUp: WebhookGiveUp): Promise<void> {
    const data = await this.readAll();
    data[key] = giveUp;
    await this.writeAll(data);
  }

  /**
   * Called the next time processEvent actually reaches a real review for
   * this same `(repo, PR)` — a later push re-triggered a fresh delivery that
   * got all the way through, so whatever needed a human before doesn't
   * anymore. Mirrors PrFixAttemptStore.reset()'s same "done, stop counting
   * against it" posture. A no-op if nothing was recorded for this key.
   */
  async clear(key: string): Promise<void> {
    const data = await this.readAll();
    if (!(key in data)) return;
    delete data[key];
    await this.writeAll(data);
  }

  /** Every `(repo, PR)` still waiting on a human, for digest.ts's "needing human attention" section. */
  async list(): Promise<Record<string, WebhookGiveUp>> {
    return this.readAll();
  }
}
