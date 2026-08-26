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

  it("lists recent runs across agents, ordered by time not name", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    // Create runs in opposite alphabetical order to their timestamps
    const zebra1 = await store.open(newRunId("zebra", new Date("2026-08-26T01:00:00.000Z")), "zebra");
    await zebra1.close({ status: "success", summary: "" });

    const apple5 = await store.open(newRunId("apple", new Date("2026-08-26T05:00:00.000Z")), "apple");
    await apple5.close({ status: "success", summary: "" });

    // Recent(1) must return the most recent by time (apple at 05:00), not by name
    const recent = await store.listRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.agent).toBe("apple");
    expect(recent[0]!.runId).toContain("05-00-00");
  });

  it("accumulates cost/tokens/turns across a park-then-resume, instead of losing the pre-park segment", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    const runId = newRunId("smoke", new Date("2026-08-26T07:00:00.000Z"));

    // Segment 1: runs, accrues usage and a tool call, then parks.
    const first = await store.open(runId, "smoke");
    await first.append({ type: "tool_use", name: "Bash" });
    await first.append({ type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.01, durationMs: 500 });
    const firstResult = await first.close({ status: "parked", summary: "" });

    // A real wall-clock gap between the park and the resume (e.g. a human
    // approving after midnight, possibly a whole day later) — long enough
    // that a re-seeded `startedAt` and an unseeded `new Date()` are
    // observably different ISO timestamps.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Segment 2: the SAME runId is reopened (as resumeRun does) and accrues
    // more usage before closing for good.
    const second = await store.open(runId, "smoke");
    await second.append({ type: "tool_use", name: "Read" });
    await second.append({ type: "usage", inputTokens: 40, outputTokens: 10, costUsd: 0.005, durationMs: 300 });
    const result = await second.close({ status: "success", summary: "done" });

    // The final result must be the SUM of both segments, not just segment 2.
    expect(result.costUsd).toBeCloseTo(0.015);
    expect(result.inputTokens).toBe(140);
    expect(result.outputTokens).toBe(30);
    expect(result.turns).toBe(2);

    // startedAt must be the ORIGINAL (segment 1) start time, not the resumed
    // segment's — otherwise the Governor's daily-budget bucketing (keyed off
    // startedAt's day) would attribute this run's summed cost to whatever
    // day the resume happened on instead of the day it actually started.
    expect(result.startedAt).toBe(firstResult.startedAt);
    // durationMs must reflect the TRUE elapsed time across both segments
    // (endedAt - the original startedAt), not just the resumed segment's.
    expect(result.durationMs).toBe(new Date(result.endedAt).getTime() - new Date(result.startedAt).getTime());
    expect(result.durationMs).toBeGreaterThan(0);

    const stored = await store.readResult(runId);
    expect(stored.startedAt).toBe(firstResult.startedAt);
    expect(stored.costUsd).toBeCloseTo(0.015);
    expect(stored.inputTokens).toBe(140);
    expect(stored.turns).toBe(2);
  });
});
