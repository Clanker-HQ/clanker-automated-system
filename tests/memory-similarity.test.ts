import { describe, expect, it } from "vitest";
import { similarity } from "../src/memory/similarity.js";

describe("similarity", () => {
  it("returns 1 for a matching natural key regardless of wording", () => {
    expect(similarity(
      { subject: "bump lodash to 4.17.21", key: "npm:lodash" },
      { subject: "upgrade the lodash package", key: "NPM:LODASH" },
    )).toBe(1);
  });

  it("returns a high score for near-identical subjects", () => {
    expect(similarity(
      { subject: "research paid newsletter platforms for developers" },
      { subject: "research paid newsletter platforms for developer audiences" },
    )).toBeGreaterThan(0.75);
  });

  it("returns a low score for unrelated subjects", () => {
    expect(similarity(
      { subject: "research paid newsletter platforms" },
      { subject: "fix the broken link in the deployment runbook" },
    )).toBeLessThan(0.3);
  });

  it("is unaffected by case, punctuation and stop words", () => {
    expect(similarity(
      { subject: "Audit the NPM dependencies!" },
      { subject: "audit npm dependencies" },
    )).toBeGreaterThan(0.9);
  });

  it("is symmetric and self-identical", () => {
    const a = { subject: "one two three" };
    const b = { subject: "two three four" };
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a));
    expect(similarity(a, a)).toBe(1);
  });

  it("scores two empty subjects as 0 rather than dividing by zero", () => {
    expect(similarity({ subject: "" }, { subject: "" })).toBe(0);
  });

  it("does not match on key when only one side has one", () => {
    // A lone key must never change the result at all — the code's guard
    // requires BOTH sides to carry a key before the exact-match fast path
    // fires, so this checks equality against the keyless baseline rather
    // than asserting some specific score. (The original version of this
    // test used two IDENTICAL subjects and asserted <1, which was wrong:
    // identical lexical content legitimately scores 1.0 on its own,
    // independent of any key, and demanding otherwise forced an arbitrary
    // special case with no real invariant behind it.)
    const withoutKey = similarity({ subject: "quarterly revenue report draft" }, { subject: "quarterly revenue report final" });
    const withOneKey = similarity({ subject: "quarterly revenue report draft", key: "npm:a" }, { subject: "quarterly revenue report final" });
    expect(withOneKey).toBe(withoutKey);
  });
});
