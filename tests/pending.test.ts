import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PendingStore } from "../src/control/pending.js";

function store() {
  return new PendingStore(mkdtempSync(join(tmpdir(), "cai-pending-")));
}

describe("PendingStore", () => {
  it("creates an entry with a generated id and timestamp, and reads it back", async () => {
    const s = store();
    const entry = await s.create({
      runId: "smoke-1", agentName: "smoke", sessionId: "sess-1",
      kind: "approval", effect: "fetch https://httpbin.org/post", grantRef: "test-echo",
    });
    expect(entry.id).toBeTruthy();
    expect(entry.askedAt).toBeTruthy();
    const fetched = await s.get(entry.id);
    expect(fetched).toEqual(entry);
  });

  it("returns null for an id that doesn't exist", async () => {
    expect(await store().get("nope")).toBeNull();
  });

  it("lists every open entry", async () => {
    const s = store();
    await s.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "which one?" });
    await s.create({ runId: "b", agentName: "b", sessionId: "s2", kind: "approval", effect: "x", grantRef: "g" });
    expect(await s.list()).toHaveLength(2);
  });

  it("resolve deletes the entry", async () => {
    const s = store();
    const entry = await s.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" });
    await s.resolve(entry.id);
    expect(await s.get(entry.id)).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it("reconciles: entries within the timeout are active, older ones are expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-pending-"));
    const s = new PendingStore(dir);
    const fresh = await s.create(
      { runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" },
    );
    const stale = await s.create(
      { runId: "b", agentName: "b", sessionId: "s2", kind: "question", question: "?" },
    );
    // Simulate an old entry by re-writing its file with a backdated askedAt —
    // PendingStore itself always stamps "now", so backdating happens directly
    // on disk, the way a real restart-days-later scenario would look.
    const path = join(dir, "pending", `${stale.id}.json`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.askedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(parsed));

    const result = await s.reconcile({ timeoutHours: 24 });
    expect(result.active.map((e) => e.id)).toEqual([fresh.id]);
    expect(result.expired.map((e) => e.id)).toEqual([stale.id]);
  });

  it("reconcile deletes the expired entry's file so it isn't re-reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-pending-"));
    const s = new PendingStore(dir);
    await s.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" });
    const path = join(dir, "pending", `${(await s.list())[0]!.id}.json`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.askedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(parsed));

    await s.reconcile({ timeoutHours: 24 });
    expect(readdirSync(join(dir, "pending"))).toHaveLength(0);
  });

  it("survives a simulated restart: a new PendingStore over the same directory sees prior entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-pending-"));
    const first = new PendingStore(dir);
    const entry = await first.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" });
    const second = new PendingStore(dir);
    expect(await second.get(entry.id)).toEqual(entry);
  });
});
