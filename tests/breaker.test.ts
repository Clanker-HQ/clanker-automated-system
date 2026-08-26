import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BreakerStore } from "../src/state/breaker.js";

describe("BreakerStore", () => {
  it("is not tripped for an agent with no recorded history", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    expect(await breaker.isTripped("smoke")).toBe(false);
  });

  it("trips after 3 consecutive failures", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "timeout");
    expect(await breaker.isTripped("smoke")).toBe(false);
    await breaker.recordResult("smoke", "failed");
    expect(await breaker.isTripped("smoke")).toBe(true);
  });

  it("a success resets the counter", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "success");
    await breaker.recordResult("smoke", "failed");
    expect(await breaker.isTripped("smoke")).toBe(false);
  });

  it.each(["parked", "question", "denied", "budget-exceeded"] as const)(
    "%s does not count as a failure toward the breaker",
    async (status) => {
      const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
      await breaker.recordResult("smoke", "failed");
      await breaker.recordResult("smoke", "failed");
      await breaker.recordResult("smoke", status);
      expect(await breaker.isTripped("smoke")).toBe(false);
    },
  );

  it("tracks agents independently", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    expect(await breaker.isTripped("a")).toBe(true);
    expect(await breaker.isTripped("b")).toBe(false);
  });

  it("reset clears a tripped breaker", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    await breaker.reset("a");
    expect(await breaker.isTripped("a")).toBe(false);
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-breaker-"));
    await new BreakerStore(dir).recordResult("a", "failed");
    await new BreakerStore(dir).recordResult("a", "failed");
    await new BreakerStore(dir).recordResult("a", "failed");
    expect(await new BreakerStore(dir).isTripped("a")).toBe(true);
  });
});
