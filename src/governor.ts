import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, QuietHours } from "./config.js";
import { ConfigOverridesStore, resolveGovernorSettings } from "./config-overrides.js";
import type { AgentDef } from "./registry.js";
import { RunStore } from "./run-store.js";
import { BreakerStore } from "./state/breaker.js";
import { RateLimitTracker } from "./state/rate-limit.js";

export type AdmitResult = { kind: "admit" } | { kind: "refuse"; reason: string; alert: boolean };

function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quietHours.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")!.value;
  const minute = parts.find((p) => p.type === "minute")!.value;
  const current = `${hour}:${minute}`;
  // Same-day window only (from < to), matching config.yaml's documented examples.
  return current >= quietHours.from && current < quietHours.to;
}

function startOfDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export class Governor {
  private readonly dataDir: string;
  private readonly config: Config;
  private readonly store: RunStore;
  private readonly overrides: ConfigOverridesStore;
  private readonly rateLimits: RateLimitTracker;
  private readonly breaker: BreakerStore;
  private readonly now: () => Date;
  private activeSlots = 0;
  private readonly waiters: Array<() => void> = [];
  private consecutiveRateLimitErrors = 0;

  constructor(opts: {
    dataDir: string; config: Config; store: RunStore; overrides: ConfigOverridesStore;
    rateLimits: RateLimitTracker; breaker: BreakerStore; now?: () => Date;
  }) {
    this.dataDir = opts.dataDir;
    this.config = opts.config;
    this.store = opts.store;
    this.overrides = opts.overrides;
    this.rateLimits = opts.rateLimits;
    this.breaker = opts.breaker;
    this.now = opts.now ?? (() => new Date());
  }

  async admit(agent: AgentDef, kind: "trigger" | "resume"): Promise<AdmitResult> {
    if (existsSync(join(this.dataDir, "STOP"))) {
      return { kind: "refuse", reason: "STOP file present; refusing all new runs", alert: false };
    }

    if (kind === "trigger" && (await this.breaker.isTripped(agent.name))) {
      return { kind: "refuse", reason: `circuit breaker tripped for "${agent.name}" (3 consecutive failures)`, alert: true };
    }

    const overrides = await this.overrides.read();
    const settings = resolveGovernorSettings(this.config, overrides);
    const now = this.now();

    if (settings.quietHours && isWithinQuietHours(settings.quietHours, now)) {
      return { kind: "refuse", reason: `quiet hours (${settings.quietHours.from}-${settings.quietHours.to} ${settings.quietHours.timezone})`, alert: false };
    }

    const today = startOfDay(now, settings.quietHours?.timezone ?? "UTC");
    const recent = await this.store.listRecent(10_000);
    const spentToday = recent
      .filter((r) => startOfDay(new Date(r.startedAt), settings.quietHours?.timezone ?? "UTC") === today)
      .reduce((sum, r) => sum + r.costUsd, 0);
    if (spentToday >= settings.dailyBudgetUsd) {
      return { kind: "refuse", reason: `daily budget reached ($${spentToday.toFixed(2)} of $${settings.dailyBudgetUsd})`, alert: true };
    }

    const snapshot = await this.rateLimits.read();
    if (snapshot?.status === "rejected") {
      return { kind: "refuse", reason: `rate limit currently rejected (as of ${snapshot.recordedAt})`, alert: true };
    }

    await this.acquireSlot(settings.maxConcurrent);
    return { kind: "admit" };
  }

  private async acquireSlot(maxConcurrent: number): Promise<void> {
    if (this.activeSlots < maxConcurrent) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.activeSlots += 1;
  }

  releaseSlot(): void {
    this.activeSlots -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Called live as a run streams a rate_limit_event — updates the snapshot admit() consults, without waiting for the run to finish. */
  async recordRateLimit(info: { status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; utilization?: number; resetsAt?: number }): Promise<void> {
    await this.rateLimits.record(info, this.now());
    if (info.status !== "rejected") this.consecutiveRateLimitErrors = 0;
  }

  /**
   * Reactive backoff: called when the SDK itself reports a rate_limit error
   * (distinct from recordRateLimit, which reflects the SDK's own live
   * utilization figure — this fires when no such figure caught it in time).
   * Marks the shared snapshot "rejected" so admit() refuses new runs, with a
   * cooldown that doubles per consecutive miss, capped at 30 minutes.
   * consecutiveRateLimitErrors is in-memory only: a restart resets the
   * backoff level but not safety, since the snapshot itself still reads
   * "rejected" until a genuinely fresh non-rejected reading arrives.
   */
  async recordRateLimitError(): Promise<void> {
    this.consecutiveRateLimitErrors += 1;
    const cooldownMinutes = Math.min(2 ** this.consecutiveRateLimitErrors, 30);
    // Deliberately real wall-clock time, not the injectable this.now(): this
    // cooldown is consulted by future admit() calls (and by external readers
    // of state/rate-limit.json) against the real clock, so it must never be
    // computed from a test-fixed or otherwise skewed "now".
    const now = new Date();
    await this.rateLimits.record(
      { status: "rejected", resetsAt: Math.floor(now.getTime() / 1000) + cooldownMinutes * 60 },
      now,
    );
  }
}
