import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RateLimitTracker } from "../src/state/rate-limit.js";

describe("RateLimitTracker", () => {
  it("returns null when nothing has been recorded yet (fails open, not closed)", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    expect(await tracker.read()).toBeNull();
  });

  it("records and reads back the latest snapshot, stamped with when it was recorded", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: 1787766600 });
    const snapshot = await tracker.read();
    expect(snapshot?.status).toBe("allowed_warning");
    expect(snapshot?.utilization).toBe(0.91);
    expect(snapshot?.recordedAt).toBeTruthy();
  });

  it("a later record overwrites an earlier one", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed", utilization: 0.1 });
    await tracker.record({ status: "rejected", utilization: 1.0 });
    expect((await tracker.read())?.status).toBe("rejected");
  });

  it("returns null rather than throwing when the file on disk is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-rl-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "rate-limit.json"), "not json");
    expect(await new RateLimitTracker(dir).read()).toBeNull();
  });
});
