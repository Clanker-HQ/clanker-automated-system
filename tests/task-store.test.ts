import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXPLORATION_INTERVAL, TaskStore, type Task } from "../src/control/task-store.js";

function store(): TaskStore {
  return new TaskStore(mkdtempSync(join(tmpdir(), "cai-tasks-")));
}

describe("TaskStore", () => {
  it("creates a task with a generated id, default priority, and pending status", async () => {
    const s = store();
    const task = await s.create({ text: "research profitable niches", createdBy: "discord:owner" });
    expect(task.id).toBeTruthy();
    expect(task.priority).toBe(50);
    expect(task.status).toBe("pending");
    expect(task.createdAt).toBeTruthy();
    expect(await s.get(task.id)).toEqual(task);
  });

  it("returns null for an id that doesn't exist", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await store().get("nope")).toBeNull();
      // A missing file is a legitimate answer, not something to shout about.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("logs, rather than silently swallowing, a task file that exists but won't parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-tasks-"));
    const s = new TaskStore(dir);
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    writeFileSync(join(dir, "tasks", `${task.id}.json`), "{ truncated");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Still null — callers have no better move — but a corrupt file quietly
      // vanishing from list()/nextPending() forever is exactly the silent loss
      // this project's fail-loud posture exists to prevent.
      expect(await s.get(task.id)).toBeNull();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain(task.id);
    } finally {
      errors.mockRestore();
    }
  });

  it("honours an explicit priority and parentId", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner", priority: 90, parentId: "parent-1" });
    expect(task.priority).toBe(90);
    expect(task.parentId).toBe("parent-1");
  });

  it("honours an explicit specialistAgent, and leaves it unset by default", async () => {
    const s = store();
    const routed = await s.create({ text: "x", createdBy: "agent:research", specialistAgent: "builder" });
    expect(routed.specialistAgent).toBe("builder");
    const unrouted = await s.create({ text: "y", createdBy: "agent:research" });
    expect(unrouted.specialistAgent).toBeUndefined();
  });

  it("honours wantsDetail, and leaves it unset by default", async () => {
    const s = store();
    const detailed = await s.create({ text: "x", createdBy: "discord:owner", wantsDetail: true });
    expect(detailed.wantsDetail).toBe(true);
    const plain = await s.create({ text: "y", createdBy: "discord:owner" });
    expect(plain.wantsDetail).toBeUndefined();
  });

  it("defaults category to exploitation, and honours an explicit one", async () => {
    const s = store();
    const defaulted = await s.create({ text: "x", createdBy: "discord:owner" });
    expect(defaulted.category).toBe("exploitation");
    const tagged = await s.create({ text: "y", createdBy: "discord:owner", category: "exploration" });
    expect(tagged.category).toBe("exploration");
  });

  it("findByPrefix matches on id prefix, and returns all matches when ambiguous", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    expect(await s.findByPrefix(task.id.slice(0, 8))).toEqual([task]);
    expect(await s.findByPrefix(task.id)).toEqual([task]);
    expect(await s.findByPrefix("not-a-real-prefix")).toEqual([]);
  });

  it("update merges a patch and persists it", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    const updated = await s.update(task.id, { status: "running", specialistAgent: "research" });
    expect(updated.status).toBe("running");
    expect(updated.specialistAgent).toBe("research");
    expect(updated.text).toBe("x");
    expect(await s.get(task.id)).toEqual(updated);
  });

  it("two concurrent updates to different fields on the same task both survive", async () => {
    // Regression guard for the read-then-write race update() used to have:
    // without serializing per id, both calls could read the same "before"
    // state and the later write would silently drop the earlier patch.
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await Promise.all([
      s.update(task.id, { status: "running" }),
      s.update(task.id, { priority: 90 }),
    ]);
    const final = await s.get(task.id);
    expect(final?.status).toBe("running");
    expect(final?.priority).toBe(90);
  });

  it("update throws a clear error for an unknown id", async () => {
    await expect(store().update("nope", { status: "done" })).rejects.toThrow(/nope/);
  });

  it("nextPending returns null when nothing is pending", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { status: "done" });
    expect(await s.nextPending()).toBeNull();
  });

  it("nextPending picks the highest priority, ties broken by creation order", async () => {
    const s = store();
    const low = await s.create({ text: "low", createdBy: "discord:owner", priority: 10 });
    const high = await s.create({ text: "high", createdBy: "discord:owner", priority: 90 });
    void low;
    expect((await s.nextPending())?.id).toBe(high.id);

    // The tie-break itself only exercises what it claims to when `first` and
    // `second` actually land in different milliseconds: nextPending's sort
    // falls back to createdAt.localeCompare, and on an exact tie a stable
    // sort just preserves list()'s own order -- which is readdir() order,
    // not creation order (see task-store.ts#list). Two back-to-back creates
    // with no delay can land in the same millisecond, especially on a fast
    // CI runner, making this assertion flip on readdir()'s arbitrary
    // ordering instead of testing the tie-break at all. Faking the clock and
    // advancing it between creates guarantees a real, distinct createdAt for
    // each -- the same fix already applied to this exact failure mode in
    // tests/sdk-runner-queue-task.test.ts's listMyTasks tests.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    let first: Task, second: Task;
    try {
      const s2 = store();
      first = await s2.create({ text: "first", createdBy: "discord:owner", priority: 50 });
      vi.advanceTimersByTime(1000);
      second = await s2.create({ text: "second", createdBy: "discord:owner", priority: 50 });
      void second;
      expect((await s2.nextPending())?.id).toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nextPending skips ids in the exclude set", async () => {
    const s = store();
    const low = await s.create({ text: "low", createdBy: "discord:owner", priority: 10 });
    const high = await s.create({ text: "high", createdBy: "discord:owner", priority: 90 });
    expect((await s.nextPending(new Set([high.id])))?.id).toBe(low.id);
    expect(await s.nextPending(new Set([high.id, low.id]))).toBeNull();
  });

  // "queued", not "running": a claim happens before routing and before this
  // task has any chance at a Governor concurrency slot. Calling it "running"
  // here was the whole bug — !tasks showed several claimed tasks as
  // "running" simultaneously when only maxConcurrent of them genuinely were.
  it("claimNextPending atomically picks the next pending task and marks it queued", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    const claimed = await s.claimNextPending(new Set(), "2026-08-28T00:00:00.000Z");
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("queued");
    expect(claimed?.startedAt).toBe("2026-08-28T00:00:00.000Z");
    expect((await s.get(task.id))?.status).toBe("queued");
  });

  it("claimNextPending returns null, and claims nothing, when everything is excluded", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    expect(await s.claimNextPending(new Set([task.id]), "2026-08-28T00:00:00.000Z")).toBeNull();
    expect((await s.get(task.id))?.status).toBe("pending");
  });

  it("two concurrent claimNextPending calls never claim the same task", async () => {
    const s = store();
    const a = await s.create({ text: "a", createdBy: "discord:owner" });
    const b = await s.create({ text: "b", createdBy: "discord:owner" });
    const [first, second] = await Promise.all([
      s.claimNextPending(new Set(), "2026-08-28T00:00:00.000Z"),
      s.claimNextPending(new Set(), "2026-08-28T00:00:00.000Z"),
    ]);
    const claimedIds = [first?.id, second?.id].sort();
    expect(claimedIds).toEqual([a.id, b.id].sort());
  });

  it("nextPending skips a task whose nextRetryAt is still in the future", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    expect(await s.nextPending(new Set(), new Date("2026-08-28T00:30:00.000Z"))).toBeNull();
  });

  it("nextPending picks up a task once its nextRetryAt has passed", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    expect((await s.nextPending(new Set(), new Date("2026-08-28T01:00:01.000Z")))?.id).toBe(task.id);
  });

  it("claimNextPending skips a task whose nextRetryAt is still in the future relative to startedAt", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    expect(await s.claimNextPending(new Set(), "2026-08-28T00:30:00.000Z")).toBeNull();
    expect((await s.get(task.id))?.status).toBe("pending");
  });

  it("claimNextPending claims a task once startedAt is past its nextRetryAt", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    const claimed = await s.claimNextPending(new Set(), "2026-08-28T01:00:01.000Z");
    expect(claimed?.id).toBe(task.id);
  });

  it("reconcile resets a running task back to pending and clears its specialistAgent", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { status: "running", specialistAgent: "research" });
    const { reset } = await s.reconcile();
    expect(reset).toHaveLength(1);
    const after = await s.get(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.specialistAgent).toBeUndefined();
  });

  // "queued" is in flight exactly like "running" is — claimed, with nothing
  // actually working it after a crash — so it needs the same recovery path,
  // not just "running"'s.
  it("reconcile resets a queued task back to pending too", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { status: "queued", specialistAgent: "research" });
    const { reset } = await s.reconcile();
    expect(reset).toHaveLength(1);
    const after = await s.get(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.specialistAgent).toBeUndefined();
  });

  it("reconcile leaves pending/done/failed tasks untouched", async () => {
    const s = store();
    const pending = await s.create({ text: "p", createdBy: "discord:owner" });
    const done = await s.create({ text: "d", createdBy: "discord:owner" });
    await s.update(done.id, { status: "done" });
    const { reset } = await s.reconcile();
    expect(reset).toEqual([]);
    expect((await s.get(pending.id))?.status).toBe("pending");
    expect((await s.get(done.id))?.status).toBe("done");
  });

  it("survives a simulated restart: a new TaskStore over the same directory sees prior tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-tasks-"));
    const first = new TaskStore(dir);
    const task = await first.create({ text: "x", createdBy: "discord:owner" });
    const second = new TaskStore(dir);
    expect(await second.get(task.id)).toEqual(task);
  });

  describe("exploration floor", () => {
    function iso(i: number): string {
      return `2026-08-28T00:00:${String(i).padStart(2, "0")}.000Z`;
    }

    it("claims a pending exploration task once the interval has elapsed without one", async () => {
      const s = store();
      const exploration = await s.create({ text: "explore", createdBy: "discord:owner", category: "exploration", priority: 1 });
      for (let i = 0; i < EXPLORATION_INTERVAL; i++) {
        await s.create({ text: `exploit ${i}`, createdBy: "discord:owner", priority: 90 });
      }
      const claimed: (Task | null)[] = [];
      for (let i = 0; i < EXPLORATION_INTERVAL; i++) {
        claimed.push(await s.claimNextPending(new Set(), iso(i)));
      }
      // The exploration task is always the lowest priority in the pool, so
      // priority order alone would never surface it — only the floor does.
      expect(claimed[EXPLORATION_INTERVAL - 1]?.id).toBe(exploration.id);
    });

    it("does not starve the queue when no exploration task is pending", async () => {
      const s = store();
      for (let i = 0; i < EXPLORATION_INTERVAL + 3; i++) {
        await s.create({ text: `exploit ${i}`, createdBy: "discord:owner", priority: 90 });
      }
      for (let i = 0; i < EXPLORATION_INTERVAL + 3; i++) {
        expect(await s.claimNextPending(new Set(), iso(i))).not.toBeNull();
      }
    });

    it("does not reset the counter when the interval elapses with no exploration pending, so a later one is promoted immediately", async () => {
      const s = store();
      for (let i = 0; i < EXPLORATION_INTERVAL + 2; i++) {
        await s.create({ text: `exploit ${i}`, createdBy: "discord:owner", priority: 90 });
      }
      // Run well past the interval with nothing to promote — if this wrongly
      // reset the counter, the exploration task below would have to wait
      // another EXPLORATION_INTERVAL claims instead of being promoted at once.
      for (let i = 0; i < EXPLORATION_INTERVAL + 2; i++) {
        await s.claimNextPending(new Set(), iso(i));
      }
      const exploration = await s.create({ text: "explore", createdBy: "discord:owner", category: "exploration", priority: 1 });
      await s.create({ text: "urgent exploit", createdBy: "discord:owner", priority: 99 });
      const claimed = await s.claimNextPending(new Set(), "2026-08-28T00:01:00.000Z");
      expect(claimed?.id).toBe(exploration.id);
    });

    it("persists the claim count across a new TaskStore instance over the same directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cai-tasks-"));
      const first = new TaskStore(dir);
      for (let i = 0; i < EXPLORATION_INTERVAL - 1; i++) {
        await first.create({ text: `exploit ${i}`, createdBy: "discord:owner", priority: 90 });
      }
      for (let i = 0; i < EXPLORATION_INTERVAL - 1; i++) {
        await first.claimNextPending(new Set(), iso(i));
      }
      const second = new TaskStore(dir);
      const exploration = await second.create({ text: "explore", createdBy: "discord:owner", category: "exploration", priority: 1 });
      await second.create({ text: "urgent exploit", createdBy: "discord:owner", priority: 99 });
      const claimed = await second.claimNextPending(new Set(), "2026-08-28T00:01:00.000Z");
      expect(claimed?.id).toBe(exploration.id);
    });
  });
});
