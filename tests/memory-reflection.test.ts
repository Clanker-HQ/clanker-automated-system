import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";
import { runReflection } from "../src/memory/reflection.js";
import type { RunResult } from "../src/run-store.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");

function memoryStore(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), "cai-reflection-")));
}

async function seedOutcome(memory: MemoryStore): Promise<void> {
  await memory.append({
    domain: "research", kind: "outcome", subject: "x", body: "done",
    importance: 5, createdBy: "agent:research", verdict: "achieved",
  });
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "r1", agent: "builder", status: "success",
    startedAt: NOW.toISOString(), endedAt: NOW.toISOString(),
    durationMs: 1000, costUsd: 0.01, inputTokens: 1, outputTokens: 1,
    turns: 1, summary: "tried something", ...overrides,
  };
}

describe("runReflection", () => {
  it("appends one reflection record per synthesised conclusion", async () => {
    const memory = memoryStore();
    await seedOutcome(memory);
    const synthesise = async () => [
      { domain: "research", subject: "pattern A", body: "conclusion A", importance: 6 },
      { domain: "research", subject: "pattern B", body: "conclusion B", importance: 4 },
    ];
    const written = await runReflection({ memory, runs: [], synthesise, now: NOW });
    expect(written).toHaveLength(2);
    expect(written.every((r) => r.kind === "reflection")).toBe(true);
    expect((await memory.list()).filter((r) => r.kind === "reflection")).toHaveLength(2);
  });

  it("supersedes by recency rather than rewriting an existing reflection", async () => {
    const memory = memoryStore();
    await seedOutcome(memory);
    const oldReflection = await memory.append({
      domain: "research", kind: "reflection", subject: "recurring pattern",
      body: "old conclusion", importance: 5, createdBy: "system:reflection",
    });
    const synthesise = async () => [
      { domain: "research", subject: "recurring pattern", body: "new conclusion", importance: 7 },
    ];
    await runReflection({ memory, runs: [], synthesise, now: NOW });
    const reflections = (await memory.list()).filter((r) => r.kind === "reflection");
    // Never rewritten in place: the old record survives unchanged, and the
    // new one is appended alongside it — a later reader supersedes by
    // recency, not by mutation.
    expect(reflections).toHaveLength(2);
    expect(reflections.find((r) => r.id === oldReflection.id)?.body).toBe("old conclusion");
    expect(reflections.some((r) => r.body === "new conclusion")).toBe(true);
  });

  it("passes both outcome records and run verdicts to the synthesiser", async () => {
    const memory = memoryStore();
    let capturedDigest = "";
    const synthesise = async (digestText: string) => {
      capturedDigest = digestText;
      return [];
    };
    const badRun = run({ verifiedOutcome: { verdict: "not-achieved", reason: "missed the mark" } });
    await runReflection({ memory, runs: [badRun], synthesise, now: NOW });
    expect(capturedDigest).toContain("not-achieved");
    expect(capturedDigest).toContain("missed the mark");
  });

  it("returns an empty array and writes nothing when there is no history", async () => {
    const memory = memoryStore();
    const synthesise = vi.fn(async () => [{ domain: "x", subject: "y", body: "z", importance: 5 }]);
    const written = await runReflection({ memory, runs: [], synthesise, now: NOW });
    expect(written).toEqual([]);
    expect(synthesise).not.toHaveBeenCalled();
    expect(await memory.list()).toEqual([]);
  });

  it("never throws when the synthesiser rejects", async () => {
    const memory = memoryStore();
    await seedOutcome(memory);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const synthesise = async () => {
        throw new Error("model unavailable");
      };
      const written = await runReflection({ memory, runs: [], synthesise, now: NOW });
      expect(written).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
