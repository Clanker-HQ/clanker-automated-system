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

  it("refuses when the agent's breaker is tripped, with alert: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const breaker = new BreakerStore(dir);
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("breaker"), alert: true });
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
      await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 10, durationMs: 1 });
      await writer.close({ status: "success", summary: "" });
    } finally {
      vi.useRealTimers();
    }
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("budget"), alert: true });
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
      await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 10, durationMs: 1 });
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
