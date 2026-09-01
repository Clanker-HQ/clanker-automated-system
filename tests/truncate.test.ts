import { describe, expect, it } from "vitest";
import { truncateForPrompt } from "../src/truncate.js";

describe("truncateForPrompt", () => {
  it("returns short text unchanged", () => {
    expect(truncateForPrompt("a short conclusion", 200)).toBe("a short conclusion");
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(truncateForPrompt("one\n\n  two   three\n", 200)).toBe("one two three");
  });

  it("truncates long text and marks that it was cut", () => {
    const long = "word ".repeat(100).trim();
    const result = truncateForPrompt(long, 50);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(51);
  });

  it("cuts at a word boundary rather than mid-word", () => {
    const result = truncateForPrompt("alpha bravo charlie delta echo foxtrot", 20);
    expect(result).toBe("alpha bravo charlie…");
  });

  it("cuts mid-token when a word boundary would waste most of the budget", () => {
    const result = truncateForPrompt(`a ${"x".repeat(100)}`, 20);
    // A boundary exists at index 1, but honouring it would return "a…" and
    // throw away 95% of the budget, so the long token is cut instead.
    expect(result.length).toBe(21);
    expect(result.startsWith("a xxxx")).toBe(true);
  });

  it("never exceeds the budget by more than the ellipsis", () => {
    for (const max of [10, 40, 200]) {
      const result = truncateForPrompt("lorem ipsum dolor sit amet consectetur adipiscing elit sed do", max);
      expect(result.length).toBeLessThanOrEqual(max + 1);
    }
  });
});
