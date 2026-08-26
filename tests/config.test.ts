import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
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
