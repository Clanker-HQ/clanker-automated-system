import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";
import { findOrphanedRuns, pruneOldData } from "../src/retention.js";

const OLD = new Date("2020-01-01T00:00:00.000Z");
const MID = new Date("2023-06-01T00:00:00.000Z");
const RECENT = new Date("2026-08-27T00:00:00.000Z");
const CUTOFF = new Date("2026-08-01T00:00:00.000Z");

async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cai-retention-"));
}

async function makeRun(dir: string, runId: string, result: unknown | null): Promise<void> {
  const runDir = join(dir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  if (result !== null) await writeFile(join(runDir, "result.json"), JSON.stringify(result));
}

async function makeWorkspaceFile(dir: string, agent: string, file: string, mtime: Date): Promise<void> {
  const agentDir = join(dir, "workspaces", agent);
  await mkdir(agentDir, { recursive: true });
  const filePath = join(agentDir, file);
  await writeFile(filePath, "content");
  await utimes(filePath, mtime, mtime);
}

describe("pruneOldData", () => {
  it("removes a run directory whose startedAt is older than the cutoff", async () => {
    const dir = await dataDir();
    await makeRun(dir, "old-run", { startedAt: OLD.toISOString() });
    const result = await pruneOldData({ dataDir: dir, olderThan: CUTOFF });
    expect(result.removedRuns).toEqual(["old-run"]);
    expect(existsSync(join(dir, "runs", "old-run"))).toBe(false);
  });

  it("keeps a run directory whose startedAt is within the cutoff", async () => {
    const dir = await dataDir();
    await makeRun(dir, "new-run", { startedAt: RECENT.toISOString() });
    const result = await pruneOldData({ dataDir: dir, olderThan: CUTOFF });
    expect(result.removedRuns).toEqual([]);
    expect(existsSync(join(dir, "runs", "new-run"))).toBe(true);
  });

  it("leaves a run with no result.json alone, rather than guessing from directory age", async () => {
    const dir = await dataDir();
    await makeRun(dir, "in-progress", null);
    const result = await pruneOldData({ dataDir: dir, olderThan: CUTOFF });
    expect(result.removedRuns).toEqual([]);
    expect(existsSync(join(dir, "runs", "in-progress"))).toBe(true);
  });

  it("leaves a run whose result.json won't parse alone", async () => {
    const dir = await dataDir();
    await mkdir(join(dir, "runs", "corrupt"), { recursive: true });
    await writeFile(join(dir, "runs", "corrupt", "result.json"), "{ not json");
    const result = await pruneOldData({ dataDir: dir, olderThan: CUTOFF });
    expect(result.removedRuns).toEqual([]);
    expect(existsSync(join(dir, "runs", "corrupt"))).toBe(true);
  });

  it("removes an old workspace file and keeps a recent one", async () => {
    const dir = await dataDir();
    await makeWorkspaceFile(dir, "research", "findings-old.md", OLD);
    await makeWorkspaceFile(dir, "research", "findings-new.md", RECENT);
    const result = await pruneOldData({ dataDir: dir, olderThan: CUTOFF });
    expect(result.removedWorkspaceFiles).toEqual([join("research", "findings-old.md")]);
    expect(existsSync(join(dir, "workspaces", "research", "findings-old.md"))).toBe(false);
    expect(existsSync(join(dir, "workspaces", "research", "findings-new.md"))).toBe(true);
  });

  it("does nothing, without throwing, when runs/ and workspaces/ don't exist yet", async () => {
    const dir = await dataDir();
    await expect(pruneOldData({ dataDir: dir, olderThan: CUTOFF })).resolves.toEqual({
      removedRuns: [], removedWorkspaceFiles: [], removedMemoryRecords: 0,
    });
  });

  it("prunes raw memory records older than the cutoff", async () => {
    const dir = await dataDir();
    const store = new MemoryStore(dir);
    await store.append({ domain: "test", kind: "finding", subject: "old finding", body: "b", importance: 5, createdBy: "test", ts: OLD.toISOString() });
    await store.append({ domain: "test", kind: "finding", subject: "fresh finding", body: "b", importance: 5, createdBy: "test", ts: RECENT.toISOString() });
    const result = await pruneOldData({
      dataDir: dir,
      olderThan: CUTOFF,
      memory: { store, olderThan: CUTOFF, reflectionsOlderThan: OLD },
    });
    expect(result.removedMemoryRecords).toBe(1);
    const remaining = await store.list();
    expect(remaining.map((r) => r.subject)).toEqual(["fresh finding"]);
  });

  it("keeps reflections past the raw-record cutoff", async () => {
    const dir = await dataDir();
    const store = new MemoryStore(dir);
    await store.append({ domain: "test", kind: "reflection", subject: "old reflection", body: "b", importance: 5, createdBy: "test", ts: MID.toISOString() });
    await store.append({ domain: "test", kind: "finding", subject: "old finding", body: "b", importance: 5, createdBy: "test", ts: MID.toISOString() });
    const result = await pruneOldData({
      dataDir: dir,
      olderThan: CUTOFF,
      memory: { store, olderThan: CUTOFF, reflectionsOlderThan: OLD },
    });
    expect(result.removedMemoryRecords).toBe(1);
    const remaining = await store.list();
    expect(remaining.map((r) => r.kind)).toEqual(["reflection"]);
  });

  it("leaves the log untouched when no memory option is supplied", async () => {
    const dir = await dataDir();
    const store = new MemoryStore(dir);
    await store.append({ domain: "test", kind: "finding", subject: "old finding", body: "b", importance: 5, createdBy: "test", ts: OLD.toISOString() });
    const result = await pruneOldData({ dataDir: dir, olderThan: CUTOFF });
    expect(result.removedMemoryRecords).toBe(0);
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
  });
});

async function makeTranscript(dir: string, runId: string, mtime: Date): Promise<void> {
  const runDir = join(dir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const transcriptPath = join(runDir, "transcript.jsonl");
  await writeFile(transcriptPath, "{}\n");
  await utimes(transcriptPath, mtime, mtime);
}

describe("findOrphanedRuns", () => {
  it("flags a run with no result.json whose transcript hasn't been touched since the cutoff", async () => {
    const dir = await dataDir();
    await makeTranscript(dir, "crashed-run", OLD);
    expect(await findOrphanedRuns({ dataDir: dir, olderThan: CUTOFF })).toEqual(["crashed-run"]);
  });

  it("does not flag a run whose transcript was written to recently — plausibly still in progress", async () => {
    const dir = await dataDir();
    await makeTranscript(dir, "live-run", RECENT);
    expect(await findOrphanedRuns({ dataDir: dir, olderThan: CUTOFF })).toEqual([]);
  });

  it("does not flag a run that has a result.json, no matter how stale its transcript is", async () => {
    const dir = await dataDir();
    await makeTranscript(dir, "finished-run", OLD);
    await writeFile(join(dir, "runs", "finished-run", "result.json"), JSON.stringify({ startedAt: OLD.toISOString() }));
    expect(await findOrphanedRuns({ dataDir: dir, olderThan: CUTOFF })).toEqual([]);
  });

  it("does not flag a run directory with no transcript.jsonl at all", async () => {
    const dir = await dataDir();
    await mkdir(join(dir, "runs", "empty-dir"), { recursive: true });
    expect(await findOrphanedRuns({ dataDir: dir, olderThan: CUTOFF })).toEqual([]);
  });

  it("returns an empty list, without throwing, when runs/ doesn't exist yet", async () => {
    const dir = await dataDir();
    await expect(findOrphanedRuns({ dataDir: dir, olderThan: CUTOFF })).resolves.toEqual([]);
  });
});
