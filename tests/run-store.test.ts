import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore, newRunId } from "../src/run-store.js";

describe("newRunId", () => {
  it("contains no characters illegal in a Windows filename", () => {
    const id = newRunId("smoke", new Date("2026-08-26T07:00:00.000Z"));
    expect(id).toBe("smoke-2026-08-26T07-00-00-000Z");
    expect(id).not.toContain(":");
  });
});

describe("RunStore", () => {
  it("writes each event as it arrives, before the run is closed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-runs-"));
    const store = new RunStore(dataDir);
    const runId = newRunId("smoke", new Date("2026-08-26T07:00:00.000Z"));
    const writer = await store.open(runId, "smoke");

    await writer.append({ type: "assistant", text: "working" });

    // The critical property: readable on disk mid-run, not only at the end.
    const path = join(dataDir, "runs", runId, "transcript.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).text).toBe("working");

    await writer.append({
      type: "usage",
      inputTokens: 10, outputTokens: 5, costUsd: 0.002, durationMs: 1200,
    });
    const result = await writer.close({ status: "success", summary: "done" });

    expect(result.status).toBe("success");
    expect(result.costUsd).toBeCloseTo(0.002);
    expect(result.inputTokens).toBe(10);
    expect(result.turns).toBe(0);

    const stored = await store.readResult(runId);
    expect(stored.runId).toBe(runId);
    expect(stored.agent).toBe("smoke");
  });

  it("counts tool calls as turns", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    const writer = await store.open(newRunId("a"), "a");
    await writer.append({ type: "tool_use", name: "Read" });
    await writer.append({ type: "tool_use", name: "Write" });
    const result = await writer.close({ status: "success", summary: "" });
    expect(result.turns).toBe(2);
  });

  it("returns the tail of the transcript for failure reporting", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    const writer = await store.open(newRunId("a"), "a");
    for (let i = 0; i < 30; i++) {
      await writer.append({ type: "assistant", text: `line ${i}` });
    }
    await writer.close({ status: "failed", summary: "", error: "boom" });
    const tail = await writer.tail(20);
    expect(tail).toHaveLength(20);
    expect(tail[19]).toContain("line 29");
  });

  it("lists recent runs newest first", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    for (const t of ["2026-08-26T01:00:00.000Z", "2026-08-26T02:00:00.000Z"]) {
      const writer = await store.open(newRunId("a", new Date(t)), "a");
      await writer.close({ status: "success", summary: "" });
    }
    const recent = await store.listRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.runId).toContain("02-00-00");
  });
});
