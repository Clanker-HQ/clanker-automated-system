import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_FIX_ATTEMPTS_PER_PR, PrFixAttemptStore } from "../src/state/pr-fix-attempts.js";

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

  it("listExhausted is empty when nothing has reached the cap", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    await store.increment("AAS-Labs/pilot-01#5");
    expect(await store.listExhausted()).toEqual([]);
  });

  it("listExhausted names a PR once it reaches MAX_FIX_ATTEMPTS_PER_PR, and not before", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    for (let i = 0; i < MAX_FIX_ATTEMPTS_PER_PR - 1; i++) await store.increment("AAS-Labs/pilot-01#5");
    expect(await store.listExhausted()).toEqual([]);

    await store.increment("AAS-Labs/pilot-01#5");
    expect(await store.listExhausted()).toEqual(["AAS-Labs/pilot-01#5"]);
  });

  it("listExhausted reports every exhausted PR independently, ignoring ones still under the cap", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    for (let i = 0; i < MAX_FIX_ATTEMPTS_PER_PR; i++) await store.increment("AAS-Labs/pilot-01#5");
    await store.increment("AAS-Labs/book-pipeline#1");
    for (let i = 0; i < MAX_FIX_ATTEMPTS_PER_PR; i++) await store.increment("AAS-Labs/book-pipeline#2");

    expect(await store.listExhausted()).toEqual(["AAS-Labs/pilot-01#5", "AAS-Labs/book-pipeline#2"]);
  });

  it("reset removes a PR from listExhausted", async () => {
    const store = new PrFixAttemptStore(mkdtempSync(join(tmpdir(), "cai-fixattempts-")));
    for (let i = 0; i < MAX_FIX_ATTEMPTS_PER_PR; i++) await store.increment("AAS-Labs/pilot-01#5");
    await store.reset("AAS-Labs/pilot-01#5");
    expect(await store.listExhausted()).toEqual([]);
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-fixattempts-"));
    await new PrFixAttemptStore(dir).increment("AAS-Labs/pilot-01#5");
    await new PrFixAttemptStore(dir).increment("AAS-Labs/pilot-01#5");
    expect(await new PrFixAttemptStore(dir).get("AAS-Labs/pilot-01#5")).toBe(2);
  });
});
