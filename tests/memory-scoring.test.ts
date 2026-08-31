import { describe, expect, it } from "vitest";
import { priorityScore, recencyDecay, retrievalScore, toPriority } from "../src/memory/scoring.js";

const WEIGHTS = { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 };
const NOW = new Date("2026-08-30T00:00:00.000Z");

describe("recencyDecay", () => {
  it("is 1 for something that just happened", () => {
    expect(recencyDecay(NOW.toISOString(), NOW, 14)).toBeCloseTo(1);
  });

  it("is 0.5 after exactly one half-life", () => {
    expect(recencyDecay(new Date("2026-08-16T00:00:00.000Z").toISOString(), NOW, 14)).toBeCloseTo(0.5);
  });

  it("never goes negative for a future timestamp", () => {
    expect(recencyDecay(new Date("2027-01-01T00:00:00.000Z").toISOString(), NOW, 14)).toBeLessThanOrEqual(1);
    expect(recencyDecay(new Date("2027-01-01T00:00:00.000Z").toISOString(), NOW, 14)).toBeGreaterThanOrEqual(0);
  });
});

describe("priorityScore", () => {
  const base = { goalAlignment: 0.5, maxSimilarity: 0.5, importance: 5, proposedAt: NOW.toISOString() };

  it("ranks goal alignment above novelty", () => {
    const alignedButRepetitive = priorityScore({ ...base, goalAlignment: 1, maxSimilarity: 1 }, WEIGHTS, NOW);
    const novelButUnaligned = priorityScore({ ...base, goalAlignment: 0, maxSimilarity: 0 }, WEIGHTS, NOW);
    expect(alignedButRepetitive).toBeGreaterThan(novelButUnaligned);
  });

  it("penalises similarity to completed work", () => {
    const novel = priorityScore({ ...base, maxSimilarity: 0 }, WEIGHTS, NOW);
    const repeat = priorityScore({ ...base, maxSimilarity: 1 }, WEIGHTS, NOW);
    expect(novel).toBeGreaterThan(repeat);
  });

  it("rewards higher self-assessed importance", () => {
    expect(priorityScore({ ...base, importance: 10 }, WEIGHTS, NOW))
      .toBeGreaterThan(priorityScore({ ...base, importance: 1 }, WEIGHTS, NOW));
  });

  it("stays within 0..1", () => {
    const max = priorityScore({ goalAlignment: 1, maxSimilarity: 0, importance: 10, proposedAt: NOW.toISOString() }, WEIGHTS, NOW);
    const min = priorityScore({ goalAlignment: 0, maxSimilarity: 1, importance: 1, proposedAt: "2000-01-01T00:00:00.000Z" }, WEIGHTS, NOW);
    expect(max).toBeLessThanOrEqual(1);
    expect(min).toBeGreaterThanOrEqual(0);
  });
});

describe("toPriority", () => {
  it("never reaches the human-task default of 50", () => {
    expect(toPriority(1)).toBe(49);
    expect(toPriority(1.5)).toBe(49);
  });

  it("floors at 0 and returns an integer", () => {
    expect(toPriority(0)).toBe(0);
    expect(toPriority(-1)).toBe(0);
    expect(Number.isInteger(toPriority(0.37))).toBe(true);
  });
});

describe("retrievalScore", () => {
  it("treats similarity as a POSITIVE, unlike priorityScore", () => {
    const related = retrievalScore({ similarity: 1, importance: 5, ts: NOW.toISOString() }, NOW, 14);
    const unrelated = retrievalScore({ similarity: 0, importance: 5, ts: NOW.toISOString() }, NOW, 14);
    expect(related).toBeGreaterThan(unrelated);
  });
});
