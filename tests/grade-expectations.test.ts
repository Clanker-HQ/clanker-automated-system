import { describe, expect, it } from "vitest";
import { gradeExpectations } from "../src/world/grade-expectations.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");

describe("gradeExpectations", () => {
  it("marks a met revenue expectation", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 75 } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("met");
  });

  it("marks a missed revenue expectation", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 10 } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("missed");
  });

  it("does not grade an expectation that is not due yet", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-12-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 0 } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("not-yet-due");
  });

  // A revenue-read outage must never be scored as a miss — that would teach
  // the overseer that a working strategy failed. See Metrics.revenueUnavailable.
  it("marks a revenue expectation ungradeable when revenue could not be read", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 0, revenueUnavailable: true } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("ungradeable");
  });

  it("marks a met productRevenueUsd expectation graded from salesInWindow filtered by product", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "productRevenueUsd", product: "widget-pro", atLeast: 50 } }],
      metrics: null,
      salesInWindow: [
        { id: "s1", product: "widget-pro", timestampIso: "2026-09-20T00:00:00.000Z", amountUsd: 30 },
        { id: "s2", product: "widget-pro", timestampIso: "2026-09-21T00:00:00.000Z", amountUsd: 30 },
        { id: "s3", product: "other-thing", timestampIso: "2026-09-21T00:00:00.000Z", amountUsd: 1000 },
      ],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("met");
  });

  it("marks a met portfolioStatus expectation graded from portfolio", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "portfolioStatus", slug: "widget-pro", is: "live" } }],
      metrics: null,
      salesInWindow: [],
      portfolio: [
        {
          slug: "widget-pro",
          purpose: "test",
          status: "live",
          nextReviewAt: "2026-11-01",
          bar: "test",
          monthlyCostUsd: 0,
          notes: [],
        },
      ],
      now: NOW,
    });
    expect(v?.outcome).toBe("met");
  });
});
