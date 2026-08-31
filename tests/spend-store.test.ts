import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpendStore } from "../src/state/spend-store.js";

function makeStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-spend-store-"));
  return { dataDir, store: new SpendStore(dataDir) };
}

describe("SpendStore", () => {
  it("returns a zero-balance, no-commitments default when nothing has been written yet", async () => {
    const { dataDir, store } = makeStore();
    expect(await store.read()).toEqual({ balanceUsd: 0, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a written state", async () => {
    const { dataDir, store } = makeStore();
    const state = {
      balanceUsd: 42.5,
      commitments: [{ id: "spend_a", amountUsd: 5, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    await store.write(state);
    expect(await store.read()).toEqual(state);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overwrites the previous state rather than merging", async () => {
    const { dataDir, store } = makeStore();
    await store.write({ balanceUsd: 10, commitments: [] });
    await store.write({ balanceUsd: 20, commitments: [] });
    expect(await store.read()).toEqual({ balanceUsd: 20, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates the state directory if it does not exist yet", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-spend-store-"));
    const store = new SpendStore(join(dataDir, "nested", "deeper"));
    await store.write({ balanceUsd: 1, commitments: [] });
    expect(await store.read()).toEqual({ balanceUsd: 1, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("treats a malformed (unparseable) file the same as missing, without throwing", async () => {
    const { dataDir, store } = makeStore();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dataDir, "state"), { recursive: true });
    await writeFile(join(dataDir, "state", "spend.json"), "{ not valid json");

    expect(await store.read()).toEqual({ balanceUsd: 0, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
