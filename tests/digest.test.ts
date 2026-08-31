import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/control/task-store.js";
import { buildDigestText } from "../src/digest.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { RunStore, newRunId } from "../src/run-store.js";

function stores() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-"));
  return { store: new RunStore(dataDir), tasks: new TaskStore(dataDir), memory: new MemoryStore(dataDir) };
}

const SINCE = new Date("2026-08-27T00:00:00.000Z");
const WITHIN_WINDOW = new Date("2026-08-27T12:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-08-26T12:00:00.000Z");

/** RunWriter.close() stamps startedAt from the real system clock, not from any date embedded in the runId — so faking the clock is the only way to land a run at a chosen time. */
async function recordRun(store: RunStore, at: Date, status: "success" | "failed", costUsd: number) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    const writer = await store.open(newRunId("smoke", at), "smoke");
    await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd, durationMs: 1 });
    await writer.close({ status, summary: "" });
  } finally {
    vi.useRealTimers();
  }
}

describe("buildDigestText", () => {
  afterEach(() => {
    vi.useRealTimers();
  });


  it("says nothing happened when the window is empty", async () => {
    const { store, tasks } = stores();
    expect(await buildDigestText({ store, tasks, since: SINCE })).toBe("📅 Daily digest: nothing happened in the last 24h.");
  });

  it("still says nothing happened when only memory activity is in the window", async () => {
    const { store, tasks, memory } = stores();
    await memory.append({ domain: "research", kind: "finding", subject: "x", body: "y", importance: 5, createdBy: "agent:research" });
    expect(await buildDigestText({ store, tasks, since: SINCE, memory })).toBe("📅 Daily digest: nothing happened in the last 24h.");
  });

  it("counts runs and spend within the window, ignoring runs before it", async () => {
    const { store, tasks } = stores();
    // Distinct timestamps: newRunId derives its id from agent name + time, so
    // two runs at the identical instant would collide into one run directory.
    await recordRun(store, WITHIN_WINDOW, "success", 1.5);
    await recordRun(store, new Date(WITHIN_WINDOW.getTime() + 1000), "failed", 0.5);
    await recordRun(store, BEFORE_WINDOW, "success", 100);
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("Runs: 2");
    expect(text).toContain("1 success");
    expect(text).toContain("1 failed");
    expect(text).toContain("$2.00 spent");
    expect(text).not.toContain("100");
  });

  it("counts tasks finished within the window, ignoring ones finished before it", async () => {
    const { store, tasks } = stores();
    const done = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(done.id, { status: "done", finishedAt: WITHIN_WINDOW.toISOString() });
    const failed = await tasks.create({ text: "y", createdBy: "discord:owner" });
    await tasks.update(failed.id, { status: "failed", finishedAt: WITHIN_WINDOW.toISOString(), failureReason: "boom" });
    const oldDone = await tasks.create({ text: "z", createdBy: "discord:owner" });
    await tasks.update(oldDone.id, { status: "done", finishedAt: BEFORE_WINDOW.toISOString() });

    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("Tasks: 1 done, 1 failed");
    expect(text).toContain(`\`${failed.id.slice(0, 8)}\``);
    expect(text).toContain("boom");
  });

  it("lists tasks waiting on the owner regardless of how long they've been waiting", async () => {
    const { store, tasks } = stores();
    const waiting = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(waiting.id, { status: "waiting" });
    const text = await buildDigestText({ store, tasks, since: WITHIN_WINDOW });
    expect(text).toContain("Waiting on you");
    expect(text).toContain(waiting.id.slice(0, 8));
  });

  it("flags runs that succeeded but were graded not-achieved, within the window only", async () => {
    const { store, tasks } = stores();
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW);
    const flagged = await store.open(newRunId("smoke", WITHIN_WINDOW), "smoke");
    await flagged.close({ status: "success", summary: "" });
    vi.useRealTimers();
    await store.recordVerification(flagged.runId, { verdict: "not-achieved", reason: "missed it" });
    // Distinct timestamp: same reasoning as the "counts runs and spend" test
    // above — two runs at the identical instant for the same agent collide
    // into one run directory.
    await recordRun(store, new Date(WITHIN_WINDOW.getTime() + 1000), "success", 1); // an ordinary success, not flagged

    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("1 run(s) succeeded but did not achieve their objective");
  });

  it("says nothing about verification when no run was graded not-achieved", async () => {
    const { store, tasks } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).not.toContain("did not achieve their objective");
  });

  it("caps the listed failed tasks at 5 and notes the rest", async () => {
    const { store, tasks } = stores();
    for (let i = 0; i < 7; i++) {
      const t = await tasks.create({ text: `t${i}`, createdBy: "discord:owner" });
      await tasks.update(t.id, { status: "failed", finishedAt: WITHIN_WINDOW.toISOString(), failureReason: `reason ${i}` });
    }
    const text = await buildDigestText({ store, tasks, since: SINCE });
    expect(text).toContain("Tasks: 0 done, 7 failed");
    expect(text).toContain("…and 2 more failed task(s)");
  });

  it("includes memory counts, including suppressed duplicates, within the window", async () => {
    const { store, tasks, memory } = stores();
    // Needs at least one run/task in the window to get past the "nothing
    // happened" early return — this test is about the memory section's
    // content, not about whether the digest fires on a memory-only day.
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW);
    try {
      await memory.append({ domain: "research", kind: "finding", subject: "x", body: "found something", importance: 5, createdBy: "agent:research" });
      await memory.append({ domain: "research", kind: "outcome", subject: "x", body: "did something", importance: 5, createdBy: "agent:research" });
      await memory.append({ domain: "research", kind: "proposal", subject: "x", body: "suppressed as a duplicate of mem_prior", importance: 5, createdBy: "agent:research" });
    } finally {
      vi.useRealTimers();
    }
    const text = await buildDigestText({ store, tasks, since: SINCE, memory });
    expect(text).toContain("🧠 Memory:");
    expect(text).toContain("1 finding");
    expect(text).toContain("1 outcome");
    expect(text).toContain("1 proposal");
    expect(text).toContain("1 duplicate proposal(s) suppressed");
  });

  it("omits the memory section when memory is explicitly disabled in config", async () => {
    const { store, tasks, memory } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW);
    try {
      await memory.append({ domain: "research", kind: "finding", subject: "x", body: "found something", importance: 5, createdBy: "agent:research" });
    } finally {
      vi.useRealTimers();
    }
    const memoryConfig = {
      enabled: false, retentionDays: 90, reflectionRetentionDays: 365,
      similarityThreshold: 0.75, stalenessDays: 30, recencyHalfLifeDays: 14,
      maxChainDepth: 3, maxAgentTasksPerDay: 20,
      weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
      reflectionSchedule: "0 3 * * 1", reflectionTimezone: "UTC", reflectionWindowDays: 14,
    };
    const text = await buildDigestText({ store, tasks, since: SINCE, memory, memoryConfig });
    expect(text).not.toContain("🧠 Memory");
  });

  it("omits the memory section when there is no memory activity in the window", async () => {
    const { store, tasks, memory } = stores();
    // A run in the window (so the digest actually fires) but zero memory
    // records at all — the section must not appear.
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    const text = await buildDigestText({ store, tasks, since: SINCE, memory });
    expect(text).not.toContain("🧠 Memory");
  });

  it("omits the memory section when memory activity is outside the window", async () => {
    const { store, tasks, memory } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_WINDOW);
    try {
      await memory.append({ domain: "research", kind: "finding", subject: "x", body: "old finding", importance: 5, createdBy: "agent:research" });
    } finally {
      vi.useRealTimers();
    }
    const text = await buildDigestText({ store, tasks, since: SINCE, memory });
    expect(text).not.toContain("🧠 Memory");
  });
});
