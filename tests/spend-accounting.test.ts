import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";
import { availableToSpendUsd, recordSpend, wouldExhaustBeforeRenewal } from "../src/spend/spend-accounting.js";
import { SpendStore, type SpendState } from "../src/state/spend-store.js";

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

function fixtures() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-record-spend-"));
  return { dataDir, store: new SpendStore(dataDir), memory: new MemoryStore(dataDir) };
}

describe("recordSpend", () => {
  it("records a one-off spend within the available balance, reducing it", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 30,
      recurring: false,
      nextRenewalAt: null,
      description: "domain registration",
      rationale: "needed for HTTPS on the first product",
      importance: 5,
    });

    expect(result).toEqual({ recorded: true, state: { balanceUsd: 70, commitments: [] } });
    expect(await store.read()).toEqual({ balanceUsd: 70, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a one-off spend that exceeds the available balance, without touching state", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 10, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 30,
      recurring: false,
      nextRenewalAt: null,
      description: "domain registration",
      rationale: "needed for HTTPS",
      importance: 5,
    });

    expect(result.recorded).toBe(false);
    expect(await store.read()).toEqual({ balanceUsd: 10, commitments: [] });
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("records a recurring spend that fits, adding a commitment without reducing the balance", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 15,
      recurring: true,
      nextRenewalAt: "2026-10-01T00:00:00.000Z",
      description: "hosting API credit",
      rationale: "backs the first product's usage-metered API calls",
      importance: 6,
    });

    expect(result.recorded).toBe(true);
    const state = await store.read();
    expect(state.balanceUsd).toBe(100);
    expect(state.commitments).toHaveLength(1);
    expect(state.commitments[0]).toMatchObject({ amountUsd: 15, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a recurring spend that would exhaust the balance, adding no commitment", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({
      balanceUsd: 100,
      commitments: [{ id: "existing", amountUsd: 90, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    });

    const result = await recordSpend(store, memory, {
      amountUsd: 20,
      recurring: true,
      nextRenewalAt: "2026-10-01T00:00:00.000Z",
      description: "another subscription",
      rationale: "not affordable alongside the existing commitment",
      importance: 4,
    });

    expect(result.recorded).toBe(false);
    const state = await store.read();
    expect(state.commitments).toHaveLength(1);
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("appends a memory-log record with the spend's rationale on success", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    await recordSpend(store, memory, {
      amountUsd: 12,
      recurring: false,
      nextRenewalAt: null,
      description: "npm package publish fee",
      rationale: "one-time cost to ship the first library",
      importance: 3,
    });

    const records = await memory.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      domain: "spend",
      kind: "outcome",
      subject: "npm package publish fee",
      body: "one-time cost to ship the first library",
      importance: 3,
      createdBy: "system:spend-accounting",
    });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a negative amountUsd, leaving state and memory untouched", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: -50,
      recurring: false,
      nextRenewalAt: null,
      description: "refund gone wrong",
      rationale: "should never be accepted",
      importance: 5,
    });

    expect(result.recorded).toBe(false);
    expect(await store.read()).toEqual({ balanceUsd: 100, commitments: [] });
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a NaN amountUsd, leaving state and memory untouched", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: NaN,
      recurring: false,
      nextRenewalAt: null,
      description: "malformed request",
      rationale: "should never be accepted",
      importance: 5,
    });

    expect(result.recorded).toBe(false);
    expect(await store.read()).toEqual({ balanceUsd: 100, commitments: [] });
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a recurring spend with nextRenewalAt: null", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 10,
      recurring: true,
      nextRenewalAt: null,
      description: "malformed recurring request",
      rationale: "should never be accepted",
      importance: 5,
    });

    expect(result.recorded).toBe(false);
    const state = await store.read();
    expect(state.commitments).toHaveLength(0);
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
