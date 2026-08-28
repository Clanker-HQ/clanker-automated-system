import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/control/task-store.js";

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

  it("honours wantsDetail, and leaves it unset by default", async () => {
    const s = store();
    const detailed = await s.create({ text: "x", createdBy: "discord:owner", wantsDetail: true });
    expect(detailed.wantsDetail).toBe(true);
    const plain = await s.create({ text: "y", createdBy: "discord:owner" });
    expect(plain.wantsDetail).toBeUndefined();
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

    const s2 = store();
    const first = await s2.create({ text: "first", createdBy: "discord:owner", priority: 50 });
    const second = await s2.create({ text: "second", createdBy: "discord:owner", priority: 50 });
    void second;
    expect((await s2.nextPending())?.id).toBe(first.id);
  });

  it("nextPending skips ids in the exclude set", async () => {
    const s = store();
    const low = await s.create({ text: "low", createdBy: "discord:owner", priority: 10 });
    const high = await s.create({ text: "high", createdBy: "discord:owner", priority: 90 });
    expect((await s.nextPending(new Set([high.id])))?.id).toBe(low.id);
    expect(await s.nextPending(new Set([high.id, low.id]))).toBeNull();
  });

  it("claimNextPending atomically picks the next pending task and marks it running", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    const claimed = await s.claimNextPending(new Set(), "2026-08-28T00:00:00.000Z");
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBe("2026-08-28T00:00:00.000Z");
    expect((await s.get(task.id))?.status).toBe("running");
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
});
