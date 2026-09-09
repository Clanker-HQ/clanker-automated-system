import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrFixAttemptStore } from "../src/state/pr-fix-attempts.js";

describe("PrFixAttemptStore", () => {
  it("is 0 for a PR with no recorded attempts", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    expect(await store.get("AAS-Labs/pilot-01#5")).toBe(0);
  });

  it("increments and returns the new count", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    expect(await store.increment("AAS-Labs/pilot-01#5")).toBe(1);
    expect(await store.increment("AAS-Labs/pilot-01#5")).toBe(2);
    expect(await store.get("AAS-Labs/pilot-01#5")).toBe(2);
  });

  it("tracks PRs independently", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    await store.increment("AAS-Labs/pilot-01#5");
    await store.increment("AAS-Labs/pilot-01#5");
    await store.increment("AAS-Labs/book-pipeline#1");
    expect(await store.get("AAS-Labs/pilot-01#5")).toBe(2);
    expect(await store.get("AAS-Labs/book-pipeline#1")).toBe(1);
  });

  it("reset clears the count back to 0", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    await store.increment("AAS-Labs/pilot-01#5");
    await store.increment("AAS-Labs/pilot-01#5");
    await store.reset("AAS-Labs/pilot-01#5");
    expect(await store.get("AAS-Labs/pilot-01#5")).toBe(0);
  });

  it("reset on a key with no recorded attempts is a harmless no-op", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    await store.reset("AAS-Labs/pilot-01#5");
    expect(await store.get("AAS-Labs/pilot-01#5")).toBe(0);
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-fixattempts-"));
    await new PrFixAttemptStore(dir).increment("AAS-Labs/pilot-01#5");
    await new PrFixAttemptStore(dir).increment("AAS-Labs/pilot-01#5");
    expect(await new PrFixAttemptStore(dir).get("AAS-Labs/pilot-01#5")).toBe(2);
  });
});
