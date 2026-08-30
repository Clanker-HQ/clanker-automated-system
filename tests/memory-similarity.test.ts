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
    expect(similarity({ subject: "x y z", key: "npm:a" }, { subject: "x y z" })).toBeLessThan(1);
  });
});
