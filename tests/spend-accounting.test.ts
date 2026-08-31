import { describe, expect, it } from "vitest";
import { availableToSpendUsd, wouldExhaustBeforeRenewal } from "../src/spend/spend-accounting.js";
import type { SpendState } from "../src/state/spend-store.js";

describe("availableToSpendUsd", () => {
  it("equals the full balance when there are no commitments", () => {
    expect(availableToSpendUsd({ balanceUsd: 100, commitments: [] })).toBe(100);
  });

  it("subtracts a single recurring commitment", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 30, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    expect(availableToSpendUsd(state)).toBe(70);
  });

  it("sums multiple recurring commitments", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [
        { id: "a", amountUsd: 30, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" },
        { id: "b", amountUsd: 25, recurring: true, nextRenewalAt: "2026-10-15T00:00:00.000Z" },
      ],
    };
    expect(availableToSpendUsd(state)).toBe(45);
  });

  it("ignores non-recurring commitments (a one-off already reduced the balance directly)", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 30, recurring: false, nextRenewalAt: null }],
    };
    expect(availableToSpendUsd(state)).toBe(100);
  });
});

describe("wouldExhaustBeforeRenewal", () => {
  it("refuses a new recurring commitment that pushes total committed spend past the balance", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 90, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    const candidate = { id: "b", amountUsd: 20, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" };
    expect(wouldExhaustBeforeRenewal(state, candidate)).toBe(true);
  });

  it("allows a new recurring commitment that still fits", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 50, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    const candidate = { id: "b", amountUsd: 20, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" };
    expect(wouldExhaustBeforeRenewal(state, candidate)).toBe(false);
  });

  it("allows a commitment that lands exactly on the balance (boundary, not negative)", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 80, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    const candidate = { id: "b", amountUsd: 20, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" };
    expect(wouldExhaustBeforeRenewal(state, candidate)).toBe(false);
  });
});
