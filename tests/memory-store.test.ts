import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";

function store(): { s: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cai-memory-"));
  return { s: new MemoryStore(dir), dir };
}

describe("MemoryStore", () => {
  it("appends a record with a generated id and timestamp", async () => {
    const { s } = store();
    const rec = await s.append({
      domain: "research", kind: "finding", subject: "npm audit tooling",
      body: "details", importance: 5, createdBy: "agent:research",
    });
    expect(rec.id).toMatch(/^mem_/);
    expect(rec.id).not.toContain(":");
    expect(rec.ts).toBeTruthy();
    expect(rec.chainDepth).toBe(0);
    expect(await s.list()).toEqual([rec]);
  });

  it("appends without rewriting earlier records", async () => {
    const { s, dir } = store();
    await s.append({ domain: "d", kind: "finding", subject: "a", body: "", importance: 1, createdBy: "x" });
    await s.append({ domain: "d", kind: "finding", subject: "b", body: "", importance: 1, createdBy: "x" });
    const lines = readFileSync(join(dir, "memory", "log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((await s.list()).map((r) => r.subject)).toEqual(["a", "b"]);
  });

  it("logs and skips a corrupt line rather than losing the whole log", async () => {
    const { s, dir } = store();
    await s.append({ domain: "d", kind: "finding", subject: "good", body: "", importance: 1, createdBy: "x" });
    writeFileSync(join(dir, "memory", "log.jsonl"), '{ truncated\n' + readFileSync(join(dir, "memory", "log.jsonl"), "utf8"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await s.list()).map((r) => r.subject)).toEqual(["good"]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("returns an empty list when no log exists yet", async () => {
    expect(await store().s.list()).toEqual([]);
  });

  it("prunes old records but keeps protected kinds", async () => {
    const { s } = store();
    const old = new Date("2020-01-01T00:00:00.000Z");
    await s.append({ domain: "d", kind: "finding", subject: "old", body: "", importance: 1, createdBy: "x", ts: old.toISOString() });
    await s.append({ domain: "d", kind: "reflection", subject: "old reflection", body: "", importance: 1, createdBy: "x", ts: old.toISOString() });
    await s.append({ domain: "d", kind: "finding", subject: "fresh", body: "", importance: 1, createdBy: "x" });
    const removed = await s.prune({ olderThan: new Date("2021-01-01T00:00:00.000Z"), keepKinds: ["reflection"] });
    expect(removed).toBe(1);
    expect((await s.list()).map((r) => r.subject).sort()).toEqual(["fresh", "old reflection"]);
  });
});
