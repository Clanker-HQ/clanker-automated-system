import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, QuietHours } from "./config.js";
import { ConfigOverridesStore, resolveGovernorSettings } from "./config-overrides.js";
import type { AgentDef } from "./registry.js";
import { RunStore } from "./run-store.js";
import { BreakerStore } from "./state/breaker.js";
import { RateLimitTracker } from "./state/rate-limit.js";

export type AdmitResult = { kind: "admit" } | { kind: "refuse"; reason: string; alert: boolean };

export interface GovernorStatus {
  stopped: boolean;
  quietHours: QuietHours | null;
  quietHoursActive: boolean;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  maxConcurrent: number;
  breakerEnabled: boolean;
  disabledAgents: string[];
  /** null when no rate_limit_event has ever been recorded — distinct from 0, which is a real reading. */
  rateLimitUtilization: number | null;
  rateLimitPauseThreshold: number;
}

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

    const overrides = await this.overrides.read();

    // breakerEnabled: false is an explicit opt-out (e.g. a dedicated,
    // unmetered account where a run failing repeatedly costs nothing you're
    // trying to protect) — unlike the checks below it, off is off, there is no
    // "resume ignores it" carve-out to preserve since a resume already ignores
    // the breaker unconditionally.
    if (kind === "trigger" && overrides.breakerEnabled !== false && (await this.breaker.isTripped(agent.name))) {
      return { kind: "refuse", reason: `circuit breaker tripped for "${agent.name}" (3 consecutive failures)`, alert: true };
    }

    // A manual `!disable <agent>` kill-switch: like the breaker check above,
    // it only gates a fresh `trigger` — a human resuming an already-parked
    // run via `!resume`/approve/answer is deliberately overriding automatic
    // gating, the same precedent the breaker check establishes ("a resume
    // ignores the breaker"). alert: false because this is an operator's own
    // deliberate, expected action, not something gone wrong.
    if (kind === "trigger" && overrides.disabledAgents?.includes(agent.name)) {
      return { kind: "refuse", reason: `"${agent.name}" is manually disabled (!enable ${agent.name} to resume)`, alert: false };
    }

    const settings = resolveGovernorSettings(this.config, overrides);
    const now = this.now();

    if (settings.quietHours && isWithinQuietHours(settings.quietHours, now)) {
      return { kind: "refuse", reason: `quiet hours (${settings.quietHours.from}-${settings.quietHours.to} ${settings.quietHours.timezone})`, alert: false };
    }

    const spentToday = await this.spentToday(settings, now);
    if (spentToday >= settings.dailyBudgetUsd) {
      return { kind: "refuse", reason: `daily budget reached ($${spentToday.toFixed(2)} of $${settings.dailyBudgetUsd})`, alert: true };
    }

    const snapshot = await this.rateLimits.read();
    if (snapshot?.status === "rejected") {
      return { kind: "refuse", reason: `rate limit currently rejected (as of ${snapshot.recordedAt})`, alert: true };
    }
    // Utilization can climb toward 1.0 for days under "allowed_warning"
    // before the API ever starts rejecting — the check above alone means
    // finding out only once that happens. Gated on `snapshot.utilization`
    // being present (fails open on `undefined`, same posture as a missing
    // snapshot entirely) since a status-only record — no rate_limit_event
    // has carried a figure yet — has nothing to compare against the
    // threshold. Unconditional on `kind`, matching the rejected check right
    // above it: a resume is exactly as costly against the real window as a
    // fresh trigger, unlike the breaker/disabled-agent checks earlier in
    // this function, which a resume deliberately bypasses.
    if (snapshot?.utilization !== undefined && snapshot.utilization >= settings.rateLimitPauseThreshold) {
      return {
        kind: "refuse",
        reason: `rate limit utilization ${(snapshot.utilization * 100).toFixed(0)}% has reached the pause threshold (${(settings.rateLimitPauseThreshold * 100).toFixed(0)}%, as of ${snapshot.recordedAt})`,
        alert: true,
      };
    }

    await this.acquireSlot(settings.maxConcurrent);
    return { kind: "admit" };
  }

  private async spentToday(settings: { quietHours: QuietHours | null }, now: Date): Promise<number> {
    const timezone = settings.quietHours?.timezone ?? "UTC";
    const today = startOfDay(now, timezone);
    // "Today" (in ANY timezone) is the 24h-long calendar day containing
    // `now`, so it can start no more than 24h before `now` and end no more
    // than 24h after it — this bound is what lets listSince skip reading
    // months of retention-kept run history on every single admission check.
    // The window is symmetric (not just backward from `now`) because `now`
    // is Governor's own injectable clock, not necessarily identical to the
    // real wall-clock time a run's startedAt was recorded against (tests
    // exploit exactly this to hold "now" fixed while runs are written) — the
    // exact `startOfDay` filter below, not this window, is what actually
    // decides which runs count.
    const oneDayMs = 24 * 60 * 60 * 1000;
    const recent = await this.store.listSince(new Date(now.getTime() - oneDayMs), new Date(now.getTime() + oneDayMs));
    return recent
      .filter((r) => startOfDay(new Date(r.startedAt), timezone) === today)
      .reduce((sum, r) => sum + r.costUsd, 0);
  }

  /** A point-in-time snapshot of everything admit() would currently check, for `!status` — read-only, changes nothing. */
  async status(): Promise<GovernorStatus> {
    const overrides = await this.overrides.read();
    const settings = resolveGovernorSettings(this.config, overrides);
    const now = this.now();
    const snapshot = await this.rateLimits.read();
    return {
      stopped: existsSync(join(this.dataDir, "STOP")),
      quietHours: settings.quietHours,
      quietHoursActive: settings.quietHours !== null && isWithinQuietHours(settings.quietHours, now),
      dailyBudgetUsd: settings.dailyBudgetUsd,
      spentTodayUsd: await this.spentToday(settings, now),
      maxConcurrent: settings.maxConcurrent,
      breakerEnabled: overrides.breakerEnabled !== false,
      disabledAgents: overrides.disabledAgents ?? [],
      rateLimitUtilization: snapshot?.utilization ?? null,
      rateLimitPauseThreshold: settings.rateLimitPauseThreshold,
    };
  }

  private async acquireSlot(maxConcurrent: number): Promise<void> {
    if (this.activeSlots < maxConcurrent) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Exactly one slot just freed up, so at most one queued waiter (if any) is granted — same as before this was split out. */
  releaseSlot(): void {
    this.activeSlots -= 1;
    const next = this.waiters.shift();
    if (next) {
      this.activeSlots += 1;
      next();
    }
  }

  /**
   * `!concurrency <n>` raising the limit must take effect immediately, not
   * just for the next admit() call: without this, an admit() already queued
   * in `waiters` (blocked under the OLD, lower maxConcurrent) stays queued
   * until enough already-running runs finish on their own and call
   * releaseSlot — one waiter drained per release, same as before the raise —
   * rather than being let through right away up to the new, higher limit.
   * A lowered limit does nothing here: it's enforced passively, the next time
   * activeSlots drops enough for a future acquireSlot/releaseSlot to compare
   * against it — there is no way to revoke a slot already granted.
   */
  adjustConcurrency(maxConcurrent: number): void {
    while (this.activeSlots < maxConcurrent && this.waiters.length > 0) {
      this.activeSlots += 1;
      this.waiters.shift()!();
    }
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
