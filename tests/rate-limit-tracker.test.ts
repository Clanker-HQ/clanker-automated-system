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

  it("readWindows returns an empty object when nothing typed has ever been recorded", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    expect(await tracker.readWindows()).toEqual({});
  });

  it("keeps a separate latest reading per rate-limit type, so one window's event can't clobber another's", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1787766600 });
    await tracker.record({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8 });
    const windows = await tracker.readWindows();
    expect(windows.five_hour?.utilization).toBe(0.4);
    expect(windows.five_hour?.resetsAt).toBe(1787766600);
    expect(windows.seven_day?.utilization).toBe(0.8);
  });

  it("a later reading for one type overwrites only that type's window", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed", rateLimitType: "five_hour", utilization: 0.4 });
    await tracker.record({ status: "allowed", rateLimitType: "seven_day", utilization: 0.5 });
    await tracker.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 });
    const windows = await tracker.readWindows();
    expect(windows.five_hour?.utilization).toBe(0.9);
    expect(windows.seven_day?.utilization).toBe(0.5);
  });

  it("does not add a window entry for a reading recorded without a rateLimitType", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "rejected" });
    expect(await tracker.readWindows()).toEqual({});
  });

  it("recordWindows writes multiple windows at once, without touching the single latest snapshot admit() gates on", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.recordWindows({
      five_hour: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 },
      seven_day: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.97 },
    });
    const windows = await tracker.readWindows();
    expect(windows.five_hour?.utilization).toBe(0.4);
    expect(windows.seven_day?.utilization).toBe(0.97);
    // The single "latest" snapshot admit() reads from must stay untouched —
    // this proactive, multi-window source must never itself gate admission.
    expect(await tracker.read()).toBeNull();
  });

  it("recordWindows merges into existing windows rather than replacing the whole map", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2 });
    await tracker.recordWindows({ seven_day: { status: "allowed", rateLimitType: "seven_day", utilization: 0.1 } });
    const windows = await tracker.readWindows();
    expect(windows.five_hour?.utilization).toBe(0.2);
    expect(windows.seven_day?.utilization).toBe(0.1);
  });
});
