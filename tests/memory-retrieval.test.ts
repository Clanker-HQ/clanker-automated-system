import { describe, expect, it } from "vitest";
import { retrieveContext } from "../src/memory/retrieval.js";
import type { MemoryRecord } from "../src/memory/types.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const SUBJECT = "research paid newsletter platforms for developers";

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_1", ts: NOW.toISOString(), domain: "research", kind: "outcome",
    subject: SUBJECT, body: "details", importance: 5, createdBy: "agent:research",
    chainDepth: 0, ...over,
  };
}

describe("retrieveContext", () => {
  it("returns the most relevant records first", () => {
    // Exact-subject match scores 1.0; a partial match (missing "for
    // developers") scores lower but still clears the relevance floor —
    // both appear, in relevance order.
    const closelyRelated = record({ id: "mem_a", body: "closely related finding" });
    const lessRelated = record({ id: "mem_b", subject: "research paid newsletter platforms", body: "less related finding" });
    const text = retrieveContext(SUBJECT, "research", [lessRelated, closelyRelated], { limit: 5, halfLifeDays: 14, now: NOW });
    const closeIndex = text.indexOf("closely related finding");
    const lessIndex = text.indexOf("less related finding");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(lessIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(lessIndex);
  });

  it("returns an empty string when nothing is relevant", () => {
    const unrelated = record({ subject: "completely unrelated topic about gardening tools", body: "irrelevant" });
    const text = retrieveContext(SUBJECT, "research", [unrelated], { limit: 5, halfLifeDays: 14, now: NOW });
    expect(text).toBe("");
  });

  it("respects the limit", () => {
    const records = Array.from({ length: 10 }, (_, i) => record({ id: `mem_${i}`, body: `body ${i}` }));
    const text = retrieveContext(SUBJECT, "research", records, { limit: 3, halfLifeDays: 14, now: NOW });
    const lines = text.split("\n").filter((l) => l.startsWith("- ("));
    expect(lines).toHaveLength(3);
  });

  it("only draws from the same domain", () => {
    const otherDomain = record({ domain: "deps", body: "wrong domain finding" });
    const text = retrieveContext(SUBJECT, "research", [otherDomain], { limit: 5, halfLifeDays: 14, now: NOW });
    expect(text).toBe("");
  });

  it("includes reflections, unlike the novelty gate", () => {
    const reflection = record({ kind: "reflection", body: "a synthesised conclusion" });
    const text = retrieveContext(SUBJECT, "research", [reflection], { limit: 5, halfLifeDays: 14, now: NOW });
    expect(text).toContain("a synthesised conclusion");
  });

  it("includes a reflection even from another domain", () => {
    // A reflection is synthesised across every domain at once — the one it is
    // filed under says where it was drawn from, not who it applies to — so
    // the domain partition that (correctly) walls off raw records must not
    // wall off a conclusion.
    const reflection = record({ domain: "deps", kind: "reflection", body: "a cross-cutting conclusion" });
    const text = retrieveContext(SUBJECT, "research", [reflection], { limit: 5, halfLifeDays: 14, now: NOW });
    expect(text).toContain("a cross-cutting conclusion");
  });
});
