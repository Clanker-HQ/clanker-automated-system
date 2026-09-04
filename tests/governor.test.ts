import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { Governor } from "../src/governor.js";
import { RunStore, newRunId } from "../src/run-store.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { BreakerStore } from "../src/state/breaker.js";
import type { AgentDef } from "../src/registry.js";

const CONFIG = parseConfig(
  "config.yaml",
  'governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\n  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }\ndiscord:\n  channels: {}\n',
);

function agent(name = "smoke"): AgentDef {
  return { name } as AgentDef;
}

/**
 * Polls rather than sleeping a fixed duration: admit() awaits overrides/
 * rate-limit/run-history reads before ever reaching acquireSlot's waiter
 * queue, so a fixed sleep is a race under load (CI, or the full suite running
 * many files at once) — too short and adjustConcurrency() runs before a
 * waiter is actually registered, hanging the test on a promise nothing will
 * ever resolve.
 */
async function waitForWaiters(governor: Governor, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while ((governor as unknown as { waiters: unknown[] }).waiters.length < count) {
    if (Date.now() > deadline) throw new Error(`waiters never reached ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The clock `build` fixes below, so a test can place a snapshot before or after it. */
const FIXED_NOW_MS = new Date("2026-08-26T12:00:00.000Z").getTime();
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);

function build(dataDir: string, now: () => Date = () => new Date("2026-08-26T12:00:00.000Z")) {
  return new Governor({
    dataDir, config: CONFIG, store: new RunStore(dataDir),
    overrides: new ConfigOverridesStore(dataDir),
    rateLimits: new RateLimitTracker(dataDir),
    breaker: new BreakerStore(dataDir),
    now,
  });
}

describe("Governor.admit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits when nothing is blocking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses when the STOP file is present, with alert: false (routine, not actionable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    writeFileSync(join(dir, "STOP"), "");
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("STOP"), alert: false });
  });

  // alert: FALSE deliberately. This refusal is re-evaluated on every dispatch,
  // so alerting here posted an identical "circuit breaker tripped" line to
  // Discord once per refused trigger — a loop, once a task queue is involved.
  // The Orchestrator announces the trip once, as the event it is.
  it("refuses when the agent's breaker is tripped, without alerting each time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const breaker = new BreakerStore(dir);
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("breaker"), alert: false });
  });

  it("does not refuse a tripped breaker once overridden off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const breaker = new BreakerStore(dir);
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await new ConfigOverridesStore(dir).set("breakerEnabled", false, "test");
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("a resume ignores the breaker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const breaker = new BreakerStore(dir);
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    expect(await build(dir).admit(agent(), "resume")).toEqual({ kind: "admit" });
  });

  it("refuses a trigger for a manually-disabled agent, with alert: false (operator-initiated, expected)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new ConfigOverridesStore(dir).set("disabledAgents", ["smoke"], "test");
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("disabled"), alert: false });
  });

  it("a resume ignores the manual-disable kill-switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new ConfigOverridesStore(dir).set("disabledAgents", ["smoke"], "test");
    expect(await build(dir).admit(agent(), "resume")).toEqual({ kind: "admit" });
  });

  it("does not refuse an agent that isn't in disabledAgents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new ConfigOverridesStore(dir).set("disabledAgents", ["some-other-agent"], "test");
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses during quiet hours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    // 02:30 Europe/Berlin falls inside the 02:00-03:00 window in CONFIG.
    const inWindow = () => new Date("2026-08-26T00:30:00.000Z"); // 02:30 CEST (UTC+2)
    const result = await build(dir, inWindow).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("quiet hours"), alert: false });
  });

  it("does not refuse for quiet hours once overridden off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new ConfigOverridesStore(dir).set("quietHours", null, "test");
    const inWindow = () => new Date("2026-08-26T00:30:00.000Z");
    expect(await build(dir, inWindow).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses once today's spend meets the daily budget, with alert: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const runStore = new RunStore(dir);
    // RunStore.open() stamps RunResult.startedAt from the real system clock
    // (node:fs writer, `new Date()`), not from any date embedded in the runId
    // string — so faking the system clock is the only way to make this run
    // actually land "today" relative to the governor's fixed "today", rather
    // than relying on this test coincidentally running on the real calendar
    // date 2026-08-26.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T08:00:00.000Z"));
    try {
      const writer = await runStore.open(newRunId("smoke", new Date("2026-08-26T08:00:00.000Z")), "smoke");
      await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 10, durationMs: 1 });
      await writer.close({ status: "success", summary: "" });
    } finally {
      vi.useRealTimers();
    }
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("budget"), alert: true });
  });

  // Same reasoning as the breaker's alert:false above: budget-reached is a
  // STATE re-checked on every dispatch for the rest of the day, so a task
  // queue turns "alert: true" into an identical Discord message per refused
  // trigger. One alert per day the threshold is first crossed is enough.
  it("alerts only once per day once the daily budget is reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const runStore = new RunStore(dir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T08:00:00.000Z"));
    try {
      const writer = await runStore.open(newRunId("smoke", new Date("2026-08-26T08:00:00.000Z")), "smoke");
      await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 10, durationMs: 1 });
      await writer.close({ status: "success", summary: "" });
    } finally {
      vi.useRealTimers();
    }
    const governor = build(dir);
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("budget"), alert: true });
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("budget"), alert: false });
  });

  it("does not count yesterday's spend against today's budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const runStore = new RunStore(dir);
    // RunStore.open() stamps RunResult.startedAt from the real system clock
    // (node:fs writer, `new Date()`), not from any date embedded in the runId
    // string — so faking the system clock is the only way to make this run
    // actually land "yesterday" relative to the governor's fixed "today".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T08:00:00.000Z"));
    try {
      const writer = await runStore.open(newRunId("smoke", new Date("2026-08-25T08:00:00.000Z")), "smoke");
      await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 10, durationMs: 1 });
      await writer.close({ status: "success", summary: "" });
    } finally {
      vi.useRealTimers();
    }
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses when the last known rate-limit snapshot says rejected, with alert: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "rejected" });
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("rate limit"), alert: true });
  });

  // Same STATE-vs-EVENT reasoning as the breaker's alert:false: this snapshot
  // is re-read on every dispatch, so a dispatcher tick (or a queued task)
  // firing every 30s reposted the same "rate limit ... 94%" line to Discord
  // for as long as utilization stayed above threshold. Alert once per distinct
  // snapshot (keyed by recordedAt), then stay quiet until a fresh reading
  // actually changes something — `!status` shows the current figure meanwhile.
  it("alerts only once for an unchanged rejected snapshot, so a queue of refused triggers doesn't spam Discord", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "rejected" });
    const governor = build(dir);
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("rate limit"), alert: true });
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("rate limit"), alert: false });
  });

  it("refuses once utilization crosses the pause threshold, even when status is only a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.97 });
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: true });
  });

  it("alerts only once for an unchanged over-threshold utilization reading, across repeated admits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.97 });
    const governor = build(dir);
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: true });
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: false });
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: false });
  });

  it("alerts again once a fresh rate-limit snapshot replaces the one already alerted on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const tracker = new RateLimitTracker(dir);
    await tracker.record({ status: "allowed_warning", utilization: 0.97 }, new Date(FIXED_NOW_MS));
    const governor = build(dir);
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: true });
    // Same recordedAt as the snapshot above (a real rate_limit_event stream can
    // land two readings in the same millisecond) but a different utilization —
    // this must still count as a fresh snapshot, not a repeat of the one
    // already alerted on.
    await tracker.record({ status: "allowed_warning", utilization: 0.98 }, new Date(FIXED_NOW_MS));
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: true });
  });

  it("admits below the pause threshold, warning status and all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.84 });
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  // A "rejected" snapshot refuses every run, and the only thing that writes a
  // fresher snapshot is a run. So without an expiry the first rejection locks
  // the system out permanently — which is exactly what happened on
  // 2026-09-01: a snapshot whose own resetsAt had already passed kept
  // refusing every dispatch hours later. recordRateLimitError's comment says
  // its doubling cooldown is "consulted by future admit() calls"; it was not.
  it("admits again once a rejected snapshot's cooldown has passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "rejected", resetsAt: FIXED_NOW_SECONDS - 60 }, new Date(FIXED_NOW_MS - 60_000));
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("keeps refusing while a rejected snapshot's cooldown is still in the future", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "rejected", resetsAt: FIXED_NOW_SECONDS + 600 }, new Date(FIXED_NOW_MS));
    expect(await build(dir).admit(agent(), "trigger")).toMatchObject({ kind: "refuse" });
  });

  it("admits again on a rejected snapshot too old to describe the present, cooldown or not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "rejected" }, new Date(FIXED_NOW_MS - 3 * 60 * 60 * 1000));
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  // The utilization gate deadlocks identically: a recorded 0.99 refuses every
  // run, and no run can then record the reading that would clear it.
  it("admits again on a stale high-utilization reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record(
      { status: "allowed_warning", utilization: 0.99 },
      new Date(FIXED_NOW_MS - 3 * 60 * 60 * 1000),
    );
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses a resume too, not only a fresh trigger — matching the adjacent rejected-status check's unconditional gating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "allowed_warning", utilization: 0.99 });
    const result = await build(dir).admit(agent(), "resume");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: true });
  });

  it("respects a configured rateLimitPauseThreshold instead of the built-in default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const config = parseConfig(
      "config.yaml",
      'governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\n  rateLimitPauseThreshold: 0.5\n  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }\ndiscord:\n  channels: {}\n',
    );
    const governor = new Governor({
      dataDir: dir, config, store: new RunStore(dir), overrides: new ConfigOverridesStore(dir),
      rateLimits: new RateLimitTracker(dir), breaker: new BreakerStore(dir),
    });
    await new RateLimitTracker(dir).record({ status: "allowed", utilization: 0.6 });
    const result = await governor.admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("utilization"), alert: true });
  });

  it("admits when utilization is absent from the snapshot, even with a warning status (fails open on missing data)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "allowed_warning" });
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("admits when there is no rate-limit snapshot yet (fails open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("a second admit waits for a slot when maxConcurrent is 1, and proceeds once released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    mkdirSync(dir, { recursive: true });
    const config = parseConfig(
      "config.yaml",
      'governor:\n  maxConcurrent: 1\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\ndiscord:\n  channels: {}\n',
    );
    const governor = new Governor({
      dataDir: dir, config, store: new RunStore(dir), overrides: new ConfigOverridesStore(dir),
      rateLimits: new RateLimitTracker(dir), breaker: new BreakerStore(dir),
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    const first = await governor.admit(agent("a"), "trigger");
    expect(first).toEqual({ kind: "admit" });

    let secondResolved = false;
    const secondPromise = governor.admit(agent("b"), "trigger").then((r) => {
      secondResolved = true;
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondResolved).toBe(false);

    governor.releaseSlot();
    expect(await secondPromise).toEqual({ kind: "admit" });
    expect(secondResolved).toBe(true);
  });

  it("adjustConcurrency immediately admits runs already queued behind the old, lower limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const config = parseConfig(
      "config.yaml",
      'governor:\n  maxConcurrent: 1\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\ndiscord:\n  channels: {}\n',
    );
    const governor = new Governor({
      dataDir: dir, config, store: new RunStore(dir), overrides: new ConfigOverridesStore(dir),
      rateLimits: new RateLimitTracker(dir), breaker: new BreakerStore(dir),
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    expect(await governor.admit(agent("a"), "trigger")).toEqual({ kind: "admit" });

    let secondResolved = false;
    let thirdResolved = false;
    const secondPromise = governor.admit(agent("b"), "trigger").then((r) => {
      secondResolved = true;
      return r;
    });
    const thirdPromise = governor.admit(agent("c"), "trigger").then((r) => {
      thirdResolved = true;
      return r;
    });

    await waitForWaiters(governor, 2);
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);

    // Raising the limit to 3 (without ever calling releaseSlot) should admit
    // both already-queued waiters right away, not just one of them.
    governor.adjustConcurrency(3);

    expect(await secondPromise).toEqual({ kind: "admit" });
    expect(await thirdPromise).toEqual({ kind: "admit" });
    expect((governor as unknown as { activeSlots: number }).activeSlots).toBe(3);
  });

  it("adjustConcurrency grants only as many waiters as the new limit allows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const config = parseConfig(
      "config.yaml",
      'governor:\n  maxConcurrent: 1\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\ndiscord:\n  channels: {}\n',
    );
    const governor = new Governor({
      dataDir: dir, config, store: new RunStore(dir), overrides: new ConfigOverridesStore(dir),
      rateLimits: new RateLimitTracker(dir), breaker: new BreakerStore(dir),
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    expect(await governor.admit(agent("a"), "trigger")).toEqual({ kind: "admit" });
    let secondResolved = false;
    let thirdResolved = false;
    const secondPromise = governor.admit(agent("b"), "trigger").then((r) => {
      secondResolved = true;
      return r;
    });
    // Both admit() calls must reach the queued-waiter stage before adjusting —
    // admit() awaits overrides/breaker/spend/rate-limit reads first, so calling
    // adjustConcurrency() synchronously right after starting them would find an
    // empty waiters queue.
    //
    // They are enqueued ONE AT A TIME on purpose. adjustConcurrency(2) below
    // grants exactly one waiter — waiters.shift() — so the assertions depend on
    // b sitting ahead of c in the queue. Starting both at once and waiting for
    // length 2 proves only that both are queued, not in which order: each
    // admit() races an independent chain of file reads to reach acquireSlot,
    // and whichever lands first is enqueued first. When that was c, the slot
    // went to c, secondPromise never resolved, and the test timed out — roughly
    // one run in six.
    await waitForWaiters(governor, 1);
    void governor.admit(agent("c"), "trigger").then(() => {
      thirdResolved = true;
    });
    await waitForWaiters(governor, 2);

    // Raised to 2, not 3: only room for one more of the two queued waiters.
    governor.adjustConcurrency(2);
    expect(await secondPromise).toEqual({ kind: "admit" });
    expect(secondResolved).toBe(true);
    expect(thirdResolved).toBe(false);
  });

  it("adjustConcurrency with a lower limit does nothing (no negative slots, no spurious grants)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    governor.adjustConcurrency(0);
    expect((governor as unknown as { activeSlots: number }).activeSlots).toBe(0);
    expect(await governor.admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });
});

describe("Governor.status", () => {
  it("reports the config defaults with nothing overridden and nothing spent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const status = await build(dir).status();
    expect(status).toEqual({
      stopped: false,
      quietHours: { from: "02:00", to: "03:00", timezone: "Europe/Berlin" },
      quietHoursActive: false,
      dailyBudgetUsd: 10,
      spentTodayUsd: 0,
      maxConcurrent: 2,
      breakerEnabled: true,
      disabledAgents: [],
      rateLimitUtilization: null,
      rateLimitPauseThreshold: 0.95,
    });
  });

  it("reflects the STOP file, quiet-hours-active, overrides, and today's spend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    writeFileSync(join(dir, "STOP"), "");
    const overrides = new ConfigOverridesStore(dir);
    await overrides.set("breakerEnabled", false, "test");
    await overrides.set("disabledAgents", ["smoke"], "test");
    await overrides.set("maxConcurrent", 5, "test");

    const runStore = new RunStore(dir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T08:00:00.000Z"));
    try {
      const writer = await runStore.open(newRunId("smoke", new Date("2026-08-26T08:00:00.000Z")), "smoke");
      await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 3, durationMs: 1 });
      await writer.close({ status: "success", summary: "" });
    } finally {
      vi.useRealTimers();
    }

    // 02:30 Europe/Berlin falls inside the 02:00-03:00 window in CONFIG.
    const inWindow = () => new Date("2026-08-26T00:30:00.000Z");
    const status = await build(dir, inWindow).status();
    expect(status.stopped).toBe(true);
    expect(status.quietHoursActive).toBe(true);
    expect(status.breakerEnabled).toBe(false);
    expect(status.disabledAgents).toEqual(["smoke"]);
    expect(status.maxConcurrent).toBe(5);
    expect(status.spentTodayUsd).toBe(3);
  });

  it("does not itself consume a concurrency slot — a read-only snapshot", async () => {
    // A real acquireSlot() that hung (the bug this guards) would make this
    // test hang too, rather than fail cleanly — so assert the private counter
    // directly instead of proving it via a second admit() that could block
    // forever on a regression.
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.status();
    await governor.status();
    expect((governor as unknown as { activeSlots: number }).activeSlots).toBe(0);
  });
});

describe("Governor rate-limit recording", () => {
  it("recordRateLimit persists a live-streamed snapshot that a later admit() consults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimit({ status: "rejected" });
    expect(await governor.admit(agent(), "trigger")).toEqual({
      kind: "refuse", reason: expect.stringContaining("rate limit"), alert: true,
    });
  });

  it("recordRateLimitError marks the snapshot rejected even with no rate_limit_event to hand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimitError();
    const snapshot = await new RateLimitTracker(dir).read();
    expect(snapshot?.status).toBe("rejected");
    expect(snapshot?.resetsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("recordRateLimitError's cooldown grows on repeated calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimitError();
    const first = (await new RateLimitTracker(dir).read())?.resetsAt ?? 0;
    await governor.recordRateLimitError();
    const second = (await new RateLimitTracker(dir).read())?.resetsAt ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  it("a non-rejected recordRateLimit call resets the backoff level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimitError();
    await governor.recordRateLimitError();
    await governor.recordRateLimit({ status: "allowed", utilization: 0.1 });
    await governor.recordRateLimitError();
    const afterReset = (await new RateLimitTracker(dir).read())?.resetsAt ?? 0;
    // One error after a reset should back off by the base cooldown (2^1 = 2
    // minutes), not continue compounding from the earlier two errors.
    const now = Math.floor(Date.now() / 1000);
    expect(afterReset).toBeLessThanOrEqual(now + 3 * 60);
  });
});
