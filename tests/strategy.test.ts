import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StrategyStore, type Strategy } from "../src/world/strategy.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-strategy-"));
  return { dataDir, store: new StrategyStore(dataDir) };
}

function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    writtenAt: "2026-09-07T05:00:00.000Z",
    intent: "Push widget-api toward its first paying customer.",
    allocation: { research: 20, build: 60, maintain: 20 },
    expectations: [{ id: "e1", dueAt: "2026-09-14", check: { kind: "netIncomeUsd", atLeast: 50 } }],
    changeReason: "",
    ...overrides,
  };
}

describe("StrategyStore", () => {
  it("round-trips a strategy", async () => {
    const f = fixture();
    await f.store.write(strategy());
    expect(await f.store.latest()).toEqual(strategy());
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("latest() returns the newest by writtenAt", async () => {
    const f = fixture();
    await f.store.write(strategy({ writtenAt: "2026-09-07T05:00:00.000Z", intent: "first" }));
    await f.store.write(strategy({ writtenAt: "2026-09-14T05:00:00.000Z", intent: "second" }));
    expect((await f.store.latest())?.intent).toBe("second");
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("latest() is null before anything is written", async () => {
    const f = fixture();
    expect(await f.store.latest()).toBeNull();
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("all() is ordered oldest-first", async () => {
    const f = fixture();
    await f.store.write(strategy({ writtenAt: "2026-09-14T05:00:00.000Z", intent: "second" }));
    await f.store.write(strategy({ writtenAt: "2026-09-07T05:00:00.000Z", intent: "first" }));
    const all = await f.store.all();
    expect(all.map((s) => s.intent)).toEqual(["first", "second"]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  // A renormalised allocation is a decision nobody made, attributed to
  // something that will be graded on it later — reject it outright instead.
  it("rejects an allocation that does not sum to 100", async () => {
    const f = fixture();
    await expect(f.store.write(strategy({ allocation: { research: 20, build: 60, maintain: 30 } }))).rejects.toThrow(
      /allocation/i,
    );
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});
