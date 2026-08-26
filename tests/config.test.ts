import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { ValidationError } from "../src/errors.js";

const VALID = `
governor:
  maxConcurrent: 2
  dailyBudgetUsd: 10
  pendingTimeoutHours: 24
  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }
discord:
  channels:
    research: DISCORD_WEBHOOK_RESEARCH
`;

describe("parseConfig", () => {
  it("parses a valid configuration", () => {
    const config = parseConfig("config.yaml", VALID);
    expect(config.governor.maxConcurrent).toBe(2);
    expect(config.governor.quietHours?.timezone).toBe("Europe/Berlin");
    expect(config.discord.channels.research).toBe("DISCORD_WEBHOOK_RESEARCH");
  });

  it("applies defaults when the governor block is absent", () => {
    const config = parseConfig("config.yaml", "discord:\n  channels: {}\n");
    expect(config.governor.maxConcurrent).toBe(2);
    expect(config.governor.quietHours).toBeNull();
  });

  it("defaults discord.botChannels to {} when absent", () => {
    const config = parseConfig("config.yaml", VALID);
    expect(config.discord.botChannels).toEqual({});
  });

  it.each(["CEST", "PST", "EST", "+02:00", "Etc/GMT-2", "nonsense"])(
    "rejects the non-canonical timezone %s",
    (tz) => {
      const yaml = VALID.replace("Europe/Berlin", tz);
      expect(() => parseConfig("config.yaml", yaml)).toThrow(ValidationError);
    },
  );

  it.each(["Europe/Berlin", "UTC", "America/New_York"])(
    "accepts the canonical timezone %s",
    (tz) => {
      const yaml = VALID.replace("Europe/Berlin", tz);
      expect(parseConfig("config.yaml", yaml).governor.quietHours?.timezone).toBe(tz);
    },
  );

  it("names the path, the received value, and the fix", () => {
    const yaml = VALID.replace("Europe/Berlin", "PST");
    try {
      parseConfig("config.yaml", yaml);
      throw new Error("expected a failure");
    } catch (error) {
      const message = (error as ValidationError).message;
      expect(message).toContain("governor.quietHours.timezone");
      expect(message).toContain("IANA");
      expect(message).toContain("Europe/Berlin");
      expect(message).toContain("PST"); // the received value, echoed back
    }
  });

  it("rejects a malformed time", () => {
    const yaml = VALID.replace('"02:00"', '"2am"');
    try {
      parseConfig("config.yaml", yaml);
      throw new Error("expected a failure");
    } catch (error) {
      const message = (error as ValidationError).message;
      expect(message).toContain("quietHours.from");
      expect(message).toContain("2am"); // the received value, echoed back
    }
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const yaml = VALID + "\nunexpected: true\n";
    expect(() => parseConfig("config.yaml", yaml)).toThrow(/unexpected/);
  });
});

describe("loadConfig", () => {
  // A fresh deploy that forgets to mount config.yaml hits this first. A raw
  // ENOENT would bypass index.ts's formatted boot path and reach the owner as
  // a stack trace.
  it("reports a missing file as a ValidationError naming the path and the fix", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "cai-config-")), "config.yaml");
    expect(() => loadConfig(missing)).toThrow(ValidationError);
    try {
      loadConfig(missing);
    } catch (error) {
      const message = (error as ValidationError).message;
      expect(message).toContain(missing);
      expect(message).toContain("does not exist");
    }
  });

  it("loads a valid file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, VALID);
    expect(loadConfig(path).governor.maxConcurrent).toBe(2);
  });
});
