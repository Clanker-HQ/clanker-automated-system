import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ValidationError } from "../src/errors.js";
import { loadRegistry } from "../src/registry.js";
import { parseAgent } from "../src/registry.js";

const CONFIG = parseConfig(
  "config.yaml",
  "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n",
);

const AGENT = `
name: smoke
trigger: { type: cron, schedule: "*/5 * * * *", timezone: Europe/Berlin }
run: { model: claude-haiku-4-5, maxTurns: 5, timeoutMinutes: 3, maxBudgetUsd: 0.10 }
permissions: { allowedTools: [Read, Write], disallowedTools: [Bash] }
outbox: { discord: smoke }
`;

function scaffold(agentYaml: string, name = "smoke") {
  const root = mkdtempSync(join(tmpdir(), "cai-"));
  const dir = join(root, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), agentYaml);
  writeFileSync(join(dir, "prompt.md"), "Say hello.");
  return { agentsDir: join(root, "agents"), dataDir: join(root, "data") };
}

function scaffoldMany(entries: { name: string; agentYaml: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "cai-"));
  for (const { name, agentYaml } of entries) {
    const dir = join(root, "agents", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), agentYaml);
    writeFileSync(join(dir, "prompt.md"), "Say hello.");
  }
  return { agentsDir: join(root, "agents"), dataDir: join(root, "data") };
}

const ENV = { DISCORD_WEBHOOK_SMOKE: "https://discord.test/hook" };

describe("parseAgent", () => {
  it("applies defaults", () => {
    const agent = parseAgent("agent.yaml", AGENT);
    expect(agent.enabled).toBe(true);
    expect(agent.tier).toBe("sandboxed");
    expect(agent.approval).toBe("notify");
    expect(agent.run.effort).toBe("medium");
  });

  it("rejects an unknown tool naming the legal values", () => {
    const yaml = AGENT.replace("[Read, Write]", "[Browser]");
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/allowedTools/);
    try {
      parseAgent("agent.yaml", yaml);
    } catch (e) {
      expect((e as Error).message).toContain("Legal values");
      expect((e as Error).message).toContain("Read");
    }
  });

  it("accepts tier: granted now that enforcement exists, still rejecting an unknown tier value", () => {
    const yaml = AGENT + "tier: granted\ngrantRefs: [test-echo]\napproval: approve\n";
    expect(() => parseAgent("agent.yaml", yaml)).not.toThrow();
    const agent = parseAgent("agent.yaml", yaml);
    expect(agent.tier).toBe("granted");
    expect(agent.approval).toBe("approve");
    expect(agent.grantRefs).toEqual(["test-echo"]);
    expect(() => parseAgent("agent.yaml", AGENT + "tier: bogus\n")).toThrow();
  });

  it("rejects browser capability, naming the plan", () => {
    const yaml = AGENT + "capabilities: { browser: { enabled: true } }\n";
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/Plan C/);
  });

  // tier: readonly is only meaningful if something enforces it. Nothing
  // downstream reads `tier` in this plan, so the schema is the only place a
  // readonly agent can be stopped from being handed a pre-approved shell.
  it("rejects a readonly agent that asks for a writing tool, naming the offender and the fix", () => {
    const yaml = AGENT + "tier: readonly\n";
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/readonly/);
    try {
      parseAgent("agent.yaml", yaml);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("Write");
      expect(message).toContain("Glob");
      expect(message).toContain("tier: sandboxed");
    }
  });

  it("rejects a readonly agent granted Bash", () => {
    const yaml =
      AGENT.replace("allowedTools: [Read, Write]", "allowedTools: [Read, Bash]").replace(
        "disallowedTools: [Bash]",
        "disallowedTools: [Write]",
      ) + "tier: readonly\n";
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/Bash/);
  });

  it("accepts a readonly agent whose tools are all read-only", () => {
    const yaml =
      AGENT.replace(
        "allowedTools: [Read, Write]",
        "allowedTools: [Read, Glob, Grep, WebSearch, WebFetch, TodoWrite]",
      ) + "tier: readonly\n";
    const agent = parseAgent("agent.yaml", yaml);
    expect(agent.tier).toBe("readonly");
  });

  it("leaves a sandboxed agent free to use writing tools", () => {
    const agent = parseAgent("agent.yaml", AGENT + "tier: sandboxed\n");
    expect(agent.permissions.allowedTools).toContain("Write");
  });

  it("rejects a tool listed as both allowed and disallowed", () => {
    const yaml = AGENT.replace("disallowedTools: [Bash]", "disallowedTools: [Read]");
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/exactly one/);
  });

  it.each(["+02:00", "PST", "Not/AZone"])(
    "rejects trigger.timezone %s as not a canonical IANA zone",
    (tz) => {
      const yaml = AGENT.replace("Europe/Berlin", tz);
      expect(() => parseAgent("agent.yaml", yaml)).toThrow(/trigger\.timezone/);
    },
  );

  it.each(["Europe/Berlin", "UTC"])("accepts trigger.timezone %s", (tz) => {
    const yaml = AGENT.replace("Europe/Berlin", tz);
    expect(parseAgent("agent.yaml", yaml).trigger.timezone).toBe(tz);
  });
});

describe("loadRegistry", () => {
  it("loads a valid agent and resolves its paths", () => {
    const { agentsDir, dataDir } = scaffold(AGENT);
    const agents = loadRegistry({ agentsDir, dataDir, config: CONFIG, env: ENV });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("smoke");
    expect(agents[0]!.workspace).toBe(join(dataDir, "workspaces", "smoke"));
  });

  it("rejects a name that does not match its directory", () => {
    const { agentsDir, dataDir } = scaffold(AGENT.replace("name: smoke", "name: other"));
    expect(() => loadRegistry({ agentsDir, dataDir, config: CONFIG, env: ENV })).toThrow(
      /must match its directory/,
    );
  });

  it("rejects an invalid cron expression", () => {
    const { agentsDir, dataDir } = scaffold(AGENT.replace('"*/5 * * * *"', '"not a cron"'));
    expect(() => loadRegistry({ agentsDir, dataDir, config: CONFIG, env: ENV })).toThrow(
      /trigger\.schedule/,
    );
  });

  it("rejects an outbox channel absent from config", () => {
    const { agentsDir, dataDir } = scaffold(AGENT.replace("discord: smoke", "discord: nope"));
    expect(() => loadRegistry({ agentsDir, dataDir, config: CONFIG, env: ENV })).toThrow(
      /Known channels: smoke/,
    );
  });

  it("rejects a channel whose environment variable is unset", () => {
    const { agentsDir, dataDir } = scaffold(AGENT);
    expect(() => loadRegistry({ agentsDir, dataDir, config: CONFIG, env: {} })).toThrow(
      /DISCORD_WEBHOOK_SMOKE/,
    );
  });

  it("reports every problem at once rather than only the first", () => {
    const broken = AGENT.replace("[Read, Write]", "[Browser]").replace(
      '"*/5 * * * *"',
      '"not a cron"',
    );
    const { agentsDir, dataDir } = scaffold(broken);
    try {
      loadRegistry({ agentsDir, dataDir, config: CONFIG, env: ENV });
      throw new Error("expected a failure");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("allowedTools");
      expect(message).toContain("trigger.schedule");
    }
  });

  it("reports a YAML syntax error without abandoning validation of other agents", () => {
    const { agentsDir, dataDir } = scaffoldMany([
      { name: "smoke", agentYaml: "name: [unclosed" },
      {
        name: "other",
        agentYaml: AGENT.replace("name: smoke", "name: other").replace(
          "[Read, Write]",
          "[Browser]",
        ),
      },
    ]);

    let error: unknown;
    try {
      loadRegistry({ agentsDir, dataDir, config: CONFIG, env: ENV });
    } catch (e) {
      error = e;
    }

    // A raw YAMLParseError (no .lines) must not escape uncaught — it must
    // be reported as a ValidationError like every other problem, and the
    // "other" agent's own (unrelated) problem must still be checked and
    // reported in the same pass rather than the loop being abandoned.
    expect(error).toBeInstanceOf(ValidationError);
    const message = (error as Error).message;
    expect(message).toContain("smoke");
    expect(message).toContain("not valid YAML");
    expect(message).toContain("other");
    expect(message).toContain("allowedTools");
  });
});
