import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigOverridesStore, resolveGovernorSettings } from "../src/config-overrides.js";
import { parseConfig } from "../src/config.js";

const CONFIG = parseConfig(
  "config.yaml",
  'governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\n  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }\ndiscord:\n  channels: {}\n',
);

describe("ConfigOverridesStore", () => {
  it("reads an empty object when nothing has been set", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    expect(await store.read()).toEqual({});
  });

  it("set then read round-trips a value", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    await store.set("dailyBudgetUsd", 25, "discord:owner");
    expect(await store.read()).toEqual({ dailyBudgetUsd: 25 });
  });

  it("set merges with existing overrides rather than replacing them", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    await store.set("dailyBudgetUsd", 25, "discord:owner");
    await store.set("maxConcurrent", 3, "discord:owner");
    expect(await store.read()).toEqual({ dailyBudgetUsd: 25, maxConcurrent: 3 });
  });

  it("setting quietHours to null explicitly disables it, distinct from never having been set", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    await store.set("quietHours", null, "discord:owner");
    expect(await store.read()).toEqual({ quietHours: null });
  });

  it("appends an audit log line naming the key, the new value, and who set it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-overrides-"));
    const store = new ConfigOverridesStore(dir);
    await store.set("dailyBudgetUsd", 25, "discord:owner");
    const log = readFileSync(join(dir, "state", "audit.log"), "utf8");
    expect(log).toContain("dailyBudgetUsd");
    expect(log).toContain("25");
    expect(log).toContain("discord:owner");
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-overrides-"));
    await new ConfigOverridesStore(dir).set("maxConcurrent", 5, "discord:owner");
    expect(await new ConfigOverridesStore(dir).read()).toEqual({ maxConcurrent: 5 });
  });
});

describe("resolveGovernorSettings", () => {
  it("falls back to config.yaml when no override is set", () => {
    const resolved = resolveGovernorSettings(CONFIG, {});
    expect(resolved.dailyBudgetUsd).toBe(10);
    expect(resolved.maxConcurrent).toBe(2);
    expect(resolved.quietHours?.timezone).toBe("Europe/Berlin");
  });

  it("an override takes precedence over config.yaml", () => {
    const resolved = resolveGovernorSettings(CONFIG, { dailyBudgetUsd: 25 });
    expect(resolved.dailyBudgetUsd).toBe(25);
    expect(resolved.maxConcurrent).toBe(2);
  });

  it("an explicit null override disables quiet hours even though config.yaml has one", () => {
    const resolved = resolveGovernorSettings(CONFIG, { quietHours: null });
    expect(resolved.quietHours).toBeNull();
  });
});
