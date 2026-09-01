import { describe, expect, it } from "vitest";
import { canExtend, dueReviews, MAX_EXTENSIONS } from "../src/world/reviews.js";
import type { PortfolioEntry } from "../src/world/world-model.js";

const NOW = new Date("2026-09-08T05:00:00.000Z");

function entry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    slug: "widget-api",
    purpose: "Paid API for widget conversion",
    status: "live",
    nextReviewAt: "2026-09-01",
    bar: "at least one paying customer",
    monthlyCostUsd: 12,
    notes: [],
    extensionCount: 0,
    ...overrides,
  };
}

describe("dueReviews", () => {
  it("returns an entry whose nextReviewAt has passed", () => {
    const overdue = entry({ slug: "overdue", nextReviewAt: "2026-09-01" });
    expect(dueReviews([overdue], NOW)).toEqual([overdue]);
  });

  it("does not return an entry whose nextReviewAt is still in the future", () => {
    const future = entry({ slug: "future", nextReviewAt: "2026-12-01" });
    expect(dueReviews([future], NOW)).toEqual([]);
  });

  it("never returns a killed entry, however overdue its date", () => {
    const killed = entry({ slug: "killed-product", status: "killed", nextReviewAt: "2020-01-01" });
    expect(dueReviews([killed], NOW)).toEqual([]);
  });

  it("returns overdue entries most-overdue first", () => {
    const slightlyOverdue = entry({ slug: "slightly-overdue", nextReviewAt: "2026-09-05" });
    const veryOverdue = entry({ slug: "very-overdue", nextReviewAt: "2026-08-01" });
    const notDue = entry({ slug: "not-due", nextReviewAt: "2026-12-01" });

    expect(dueReviews([slightlyOverdue, veryOverdue, notDue], NOW)).toEqual([veryOverdue, slightlyOverdue]);
  });
});

describe("canExtend", () => {
  it("is true when extensionCount is below MAX_EXTENSIONS", () => {
    expect(canExtend(entry({ extensionCount: 0 }))).toBe(true);
    expect(canExtend(entry({ extensionCount: MAX_EXTENSIONS - 1 }))).toBe(true);
  });

  it("is false once extensionCount reaches MAX_EXTENSIONS", () => {
    expect(canExtend(entry({ extensionCount: MAX_EXTENSIONS }))).toBe(false);
  });

  // Entries persisted before extensionCount existed read back `undefined`,
  // not 0 (see world-model.ts) — treated the same as 0 here so a
  // pre-existing product is neither unkillable nor permanently
  // un-extendable on the overseer's first cycle after this shipped.
  it("treats a legacy entry with no extensionCount field the same as extensionCount: 0", () => {
    const legacy = { ...entry(), extensionCount: undefined } as unknown as PortfolioEntry;
    expect(canExtend(legacy)).toBe(true);
  });
});
