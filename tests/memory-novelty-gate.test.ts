import { describe, expect, it } from "vitest";
import { assessNovelty } from "../src/memory/novelty-gate.js";
import type { MemoryRecord } from "../src/memory/types.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const OPTS = { threshold: 0.75, stalenessDays: 30, now: NOW };

function record(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem_1", ts: NOW.toISOString(), domain: "research", kind: "outcome",
    subject: "research paid newsletter platforms", body: "", importance: 5,
    createdBy: "agent:research", chainDepth: 0, verdict: "achieved", ...over,
  };
}

describe("assessNovelty", () => {
  it("suppresses a fresh repeat of work already achieved", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({})],
      OPTS,
    );
    expect(verdict.kind).toBe("suppressed");
  });

  it("allows a repeat once the prior record is stale", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({ ts: "2026-01-01T00:00:00.000Z" })],
      OPTS,
    );
    expect(verdict.kind).toBe("retry");
  });

  it("allows a repeat of work that was graded not-achieved, carrying the reason", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({ verdict: "not-achieved", body: "the fetch kept timing out" })],
      OPTS,
    );
    expect(verdict.kind).toBe("retry");
    if (verdict.kind === "retry") expect(verdict.priorReason).toBe("the fetch kept timing out");
  });

  it("passes genuinely new work through as novel", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "fix the broken deployment runbook link" },
      [record({})],
      OPTS,
    );
    expect(verdict.kind).toBe("novel");
  });

  it("never compares across domains", () => {
    const verdict = assessNovelty(
      { domain: "deps", subject: "research paid newsletter platforms" },
      [record({ domain: "research" })],
      OPTS,
    );
    expect(verdict.kind).toBe("novel");
  });

  it("ignores proposals and reflections, comparing only against work that ran", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({ kind: "proposal" }), record({ id: "mem_2", kind: "reflection" })],
      OPTS,
    );
    expect(verdict.kind).toBe("novel");
  });

  it("is novel against an empty log", () => {
    expect(assessNovelty({ domain: "d", subject: "anything" }, [], OPTS).kind).toBe("novel");
  });
});
