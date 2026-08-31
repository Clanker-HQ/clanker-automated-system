import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Metrics } from "../src/state/metrics-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";

function makeStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-metrics-store-"));
  return { dataDir, store: new MetricsStore(dataDir) };
}

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    computedAt: "2026-09-07T04:00:00.000Z",
    windowDays: 7,
    netIncomeUsd: 42,
    notAchievedRate: 0.1,
    notAchievedByAgent: [],
    costPerCompletedTaskUsd: 1.5,
    noveltySharePercent: 90,
    suppressedProposalCount: 1,
    queueStarvationHours: 2,
    ...overrides,
  };
}

describe("MetricsStore", () => {
  it("round-trips a written snapshot", async () => {
    const { dataDir, store } = makeStore();
    const m = metrics();
    await store.write(m);
    expect(await store.listAll()).toEqual([m]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been written yet", async () => {
    const { dataDir, store } = makeStore();
    expect(await store.listAll()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists multiple snapshots oldest first, regardless of write order", async () => {
    const { dataDir, store } = makeStore();
    const later = metrics({ computedAt: "2026-09-14T04:00:00.000Z", netIncomeUsd: 100 });
    const earlier = metrics({ computedAt: "2026-09-07T04:00:00.000Z", netIncomeUsd: 42 });
    await store.write(later);
    await store.write(earlier);
    expect((await store.listAll()).map((m) => m.computedAt)).toEqual([earlier.computedAt, later.computedAt]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overwrites rather than duplicates when two snapshots share the same date", async () => {
    const { dataDir, store } = makeStore();
    await store.write(metrics({ computedAt: "2026-09-07T04:00:00.000Z", netIncomeUsd: 1 }));
    await store.write(metrics({ computedAt: "2026-09-07T09:00:00.000Z", netIncomeUsd: 2 }));
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.netIncomeUsd).toBe(2);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("latestTwo returns nulls when nothing has been written", async () => {
    const { dataDir, store } = makeStore();
    expect(await store.latestTwo()).toEqual({ latest: null, previous: null });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("latestTwo returns a null previous when only one snapshot exists", async () => {
    const { dataDir, store } = makeStore();
    const only = metrics({ computedAt: "2026-09-07T04:00:00.000Z" });
    await store.write(only);
    expect(await store.latestTwo()).toEqual({ latest: only, previous: null });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("latestTwo returns the two most recent snapshots when three or more exist", async () => {
    const { dataDir, store } = makeStore();
    const first = metrics({ computedAt: "2026-08-24T04:00:00.000Z", netIncomeUsd: 1 });
    const second = metrics({ computedAt: "2026-08-31T04:00:00.000Z", netIncomeUsd: 2 });
    const third = metrics({ computedAt: "2026-09-07T04:00:00.000Z", netIncomeUsd: 3 });
    await store.write(first);
    await store.write(second);
    await store.write(third);
    expect(await store.latestTwo()).toEqual({ latest: third, previous: second });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
