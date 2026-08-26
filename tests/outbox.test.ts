import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { DiscordOutbox, formatRunMessage } from "../src/outbox/discord.js";
import type { RunResult } from "../src/run-store.js";

const CONFIG = parseConfig(
  "config.yaml",
  "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n",
);
const ENV = { DISCORD_WEBHOOK_SMOKE: "https://discord.test/hook" };

const RESULT: RunResult = {
  runId: "smoke-2026-08-26T07-00-00-000Z",
  agent: "smoke",
  status: "success",
  startedAt: "2026-08-26T07:00:00.000Z",
  endedAt: "2026-08-26T07:00:12.000Z",
  durationMs: 12000,
  costUsd: 0.0031,
  inputTokens: 900,
  outputTokens: 120,
  turns: 3,
  summary: "Wrote a note about tides.",
};

function outbox(fetchImpl: typeof fetch, dataDir = mkdtempSync(join(tmpdir(), "cai-out-"))) {
  return {
    dataDir,
    instance: new DiscordOutbox({
      config: CONFIG, dataDir, env: ENV, fetchImpl, sleep: async () => {},
    }),
  };
}

describe("formatRunMessage", () => {
  it("reports agent, status, cost and duration", () => {
    const text = formatRunMessage(RESULT);
    expect(text).toContain("smoke");
    expect(text).toContain("Wrote a note about tides.");
    expect(text).toContain("$0.0031");
    expect(text).toContain("12.0s");
  });

  it("includes the transcript tail on failure", () => {
    const failed = { ...RESULT, status: "failed" as const, summary: "" };
    const text = formatRunMessage(failed, [
      '{"type":"assistant","text":"UNIQUE_TAIL_MARKER"}',
    ]);
    expect(text).toContain("UNIQUE_TAIL_MARKER");
  });

  it("includes error details when provided", () => {
    const failed = { ...RESULT, status: "failed" as const, error: "boom" };
    const text = formatRunMessage(failed);
    expect(text).toContain("**Error:** boom");
  });

  it("does not include tail for successful runs", () => {
    const text = formatRunMessage(RESULT, [
      '{"type":"assistant","text":"SHOULD_NOT_APPEAR"}',
    ]);
    expect(text).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("stays within the Discord 2000-character limit", () => {
    const tail = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const text = formatRunMessage({ ...RESULT, status: "failed" }, tail);
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});

describe("DiscordOutbox", () => {
  it("delivers on the first attempt", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { instance } = outbox(fetchImpl);
    await expect(instance.post("smoke", RESULT)).resolves.toBe("delivered");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries three times before giving up", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const { instance } = outbox(fetchImpl);
    await expect(instance.post("smoke", RESULT)).resolves.toBe("undelivered");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("writes an undelivered file rather than losing the result", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const { instance, dataDir } = outbox(fetchImpl);
    await instance.post("smoke", RESULT);
    const dir = join(dataDir, "undelivered");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("throws for a channel key absent from config", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { instance } = outbox(fetchImpl);
    await expect(instance.post("nope", RESULT)).rejects.toThrow(/nope/);
  });
});
