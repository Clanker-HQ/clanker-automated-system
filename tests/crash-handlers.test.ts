import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logFatal } from "../src/crash-handlers.js";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "cai-crash-"));
}

describe("logFatal", () => {
  it("appends the error to data/state/crash.log, creating the directory if needed", async () => {
    const dir = dataDir();
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) };
    await logFatal({ dataDir: dir, outbox, channel: "smoke" }, "uncaughtException", new Error("boom"));
    const logPath = join(dir, "state", "crash.log");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("uncaughtException");
    expect(contents).toContain("boom");
  });

  it("appends a second crash rather than overwriting the first", async () => {
    const dir = dataDir();
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) };
    await logFatal({ dataDir: dir, outbox, channel: "smoke" }, "uncaughtException", new Error("first"));
    await logFatal({ dataDir: dir, outbox, channel: "smoke" }, "unhandledRejection", new Error("second"));
    const contents = readFileSync(join(dir, "state", "crash.log"), "utf8");
    expect(contents).toContain("first");
    expect(contents).toContain("second");
  });

  it("stringifies a non-Error rejection reason instead of throwing", async () => {
    const dir = dataDir();
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) };
    await expect(logFatal({ dataDir: dir, outbox, channel: "smoke" }, "unhandledRejection", "just a string reason")).resolves.toBeUndefined();
    expect(readFileSync(join(dir, "state", "crash.log"), "utf8")).toContain("just a string reason");
  });

  it("posts a best-effort Discord alert naming the kind and the error", async () => {
    const dir = dataDir();
    const outbox = { postAlert: vi.fn().mockResolvedValue("delivered" as const) };
    await logFatal({ dataDir: dir, outbox, channel: "ops" }, "uncaughtException", new Error("boom"));
    expect(outbox.postAlert).toHaveBeenCalledTimes(1);
    const [channel, text] = outbox.postAlert.mock.calls[0]!;
    expect(channel).toBe("ops");
    expect(text).toContain("uncaughtException");
    expect(text).toContain("boom");
  });

  it("never throws when the alert itself fails — logging the crash must not become a second one", async () => {
    const dir = dataDir();
    const outbox = { postAlert: vi.fn().mockRejectedValue(new Error("DISCORD_WEBHOOK_SMOKE is unset")) };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(logFatal({ dataDir: dir, outbox, channel: "smoke" }, "uncaughtException", new Error("boom"))).resolves.toBeUndefined();
      // Still logged to disk despite the alert failing.
      expect(readFileSync(join(dir, "state", "crash.log"), "utf8")).toContain("boom");
    } finally {
      errors.mockRestore();
    }
  });
});
