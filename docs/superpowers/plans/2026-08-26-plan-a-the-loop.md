# Plan A — The Loop: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One scheduled agent runs unattended on the owner's Windows PC, authenticated by a Claude subscription, and posts its result to Discord.

**Architecture:** A single long-running TypeScript supervisor in one Docker container. It validates all configuration at boot, discovers agents from `agents/*/agent.yaml`, fires them on cron schedules, executes each through a `Runner` interface, streams every event to a transcript on disk, and reports to a Discord webhook. The `Runner` interface has two implementations — a real one wrapping the Claude Agent SDK, and a fake one that lets the entire pipeline be tested without consuming subscription quota.

**Tech Stack:** Node 24, TypeScript 7, ESM. `@anthropic-ai/claude-agent-sdk` (agent execution), `zod` 4 (validation and JSON Schema emission from one definition), `yaml`, `croner` (timezone-aware cron), `vitest`, Docker.

**Spec:** [`docs/superpowers/specs/2026-08-26-claude-agent-infrastructure-design.md`](../specs/2026-08-26-claude-agent-infrastructure-design.md)

**Scope boundary:** This plan delivers §5 (layout), §6 (agent definition), §7.1 (Runner), §7.5 (Outbox), §8.1 (normal lifecycle), and the parts of §9 reachable without the governor. The governor (§7.3), tiers and grants (§7.2), the Discord bot (§7.4), park/resume (§8.2), git deploy (§10), and provisioning (§7.6) are Plans B and C. Every field this plan cannot yet enforce is **rejected at boot with a message naming the plan that delivers it** — never silently accepted.

## Global Constraints

- Node `>=24`; `"type": "module"` throughout; ESM imports carry `.js` extensions.
- Model IDs are exact strings, never date-suffixed: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`.
- Dev, test, and smoke agents use `claude-haiku-4-5` to minimise subscription quota consumption.
- Timezones are always IANA zone names (`Europe/Berlin`). Offsets and abbreviations (`+02:00`, `CEST`) are rejected.
- No `ANTHROPIC_API_KEY` reaches the agent process unless `ALLOW_API_BILLING=true` is explicitly set. Subscription auth via `CLAUDE_CODE_OAUTH_TOKEN` is the default and only supported path.
- `.env` is never committed. It is already in `.gitignore`.
- Run IDs and all generated filenames must be valid on Windows: no `:` characters.
- Validation errors are written for a language model to self-correct: every message names the offending path, what was received, and the legal values or the fix.
- All configuration is validated at boot. A configuration error fails startup loudly; it never causes a silent per-trigger skip.

---

### Task 1: Project scaffold and configuration loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `config.yaml`
- Create: `src/errors.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ValidationError` (class, fields `source: string`, `lines: string[]`); `formatZodError(source: string, error: ZodError): ValidationError`; `parseConfig(source: string, yamlText: string): Config`; `loadConfig(path: string): Config`; `isValidTimeZone(tz: string): boolean`; types `Config`, `QuietHours`, `GovernorConfig`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-agent-infrastructure",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "schema": "tsx scripts/emit-schema.ts",
    "probe": "tsx scripts/probe-sdk.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.246",
    "@anthropic-ai/claude-code": "^2.1.246",
    "croner": "^10.0.1",
    "yaml": "^2.9.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.3.0",
    "tsx": "^4.23.12",
    "typescript": "^7.0.2",
    "vitest": "^4.1.11"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: completes without error; `node_modules/` created.

- [ ] **Step 4: Write the failing test**

Create `tests/config.test.ts`:

```ts
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
    expect(() => parseConfig("config.yaml", yaml)).toThrow(/quietHours\.from/);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const yaml = VALID + "\nunexpected: true\n";
    expect(() => parseConfig("config.yaml", yaml)).toThrow(/unexpected/);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js` and `../src/errors.js`.

- [ ] **Step 6: Write `src/errors.ts`**

The formatter reads issue properties defensively, so it does not break when zod's internal issue codes change between minor versions.

```ts
import type { ZodError } from "zod";

export class ValidationError extends Error {
  constructor(
    readonly source: string,
    readonly lines: string[],
  ) {
    super(`${source} is not valid:\n${lines.map((l) => `  - ${l}`).join("\n")}`);
    this.name = "ValidationError";
  }
}

/** Merge several ValidationErrors so a boot reports every problem at once. */
export function combineValidationErrors(
  source: string,
  errors: ValidationError[],
): ValidationError {
  const lines = errors.flatMap((e) => e.lines.map((l) => `${e.source}: ${l}`));
  return new ValidationError(source, lines);
}

export function formatZodError(source: string, error: ZodError): ValidationError {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
    return `${path}: ${issue.message}${hint(issue)}`;
  });
  return new ValidationError(source, lines);
}

function hint(issue: unknown): string {
  const values = (issue as { values?: readonly unknown[] }).values;
  if (Array.isArray(values) && values.length > 0) {
    return ` Legal values: ${values.map((v) => JSON.stringify(v)).join(", ")}.`;
  }
  const keys = (issue as { keys?: readonly string[] }).keys;
  if (Array.isArray(keys) && keys.length > 0) {
    return ` Unrecognised key(s): ${keys.join(", ")}. Check spelling, or remove them.`;
  }
  return "";
}
```

- [ ] **Step 7: Write `src/config.ts`**

```ts
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodError } from "./errors.js";

/**
 * True only for canonical IANA zone names.
 *
 * `new Intl.DateTimeFormat({ timeZone })` is NOT a sufficient check: it accepts
 * "+02:00", "PST", "EST", and "Etc/GMT-2", none of which carry daylight-saving
 * rules. The canonical list is the real test — but "UTC" is legitimately absent
 * from it, so it is allowed explicitly.
 */
const CANONICAL_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf("timeZone"),
  "UTC",
]);

export function isValidTimeZone(tz: string): boolean {
  return CANONICAL_ZONES.has(tz);
}

const TimeOfDay = z.string().refine((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), {
  error: (issue) =>
    `must be a 24-hour time such as "22:00"; received ${JSON.stringify(issue.input)}`,
});

export const QuietHoursSchema = z
  .object({
    from: TimeOfDay,
    to: TimeOfDay,
    timezone: z.string().refine(isValidTimeZone, {
      error: (issue) =>
        `must be a canonical IANA zone name such as "Europe/Berlin" (or "UTC"); received ${JSON.stringify(issue.input)}. Offsets ("+02:00") and abbreviations ("CEST", "PST") are rejected because they do not carry daylight-saving rules`,
    }),
  })
  .strict();

export const GovernorSchema = z
  .object({
    maxConcurrent: z.number().int().positive().default(2),
    dailyBudgetUsd: z.number().positive().default(10),
    pendingTimeoutHours: z.number().positive().default(24),
    quietHours: QuietHoursSchema.nullable().default(null),
  })
  .strict();

export const ConfigSchema = z
  .object({
    governor: GovernorSchema.prefault({}),
    discord: z
      .object({ channels: z.record(z.string(), z.string()).default({}) })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type GovernorConfig = z.infer<typeof GovernorSchema>;
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export function parseConfig(source: string, yamlText: string): Config {
  const result = ConfigSchema.safeParse(parseYaml(yamlText) ?? {});
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

export function loadConfig(path: string): Config {
  return parseConfig(path, readFileSync(path, "utf8"));
}
```

If `.prefault({})` is unavailable in the installed zod build, substitute `.default({} as never)` — the intent is that an absent block yields the schema's own defaults rather than a validation failure. The test in Step 4 (`applies defaults when the governor block is absent`) is what proves whichever form you use is correct.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Create `config.yaml` and `.env.example`**

`config.yaml`:

```yaml
governor:
  maxConcurrent: 2
  dailyBudgetUsd: 10
  pendingTimeoutHours: 24
  # Local development: agents run at almost any hour; the window is nominal.
  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }
  # Production (VPS): agents work overnight, standing down while the owner
  # is awake and using Claude interactively. Swap the two lines on deploy.
  # quietHours: { from: "10:00", to: "22:00", timezone: Europe/Berlin }

discord:
  channels:
    smoke: DISCORD_WEBHOOK_SMOKE
```

`.env.example`:

```bash
# Subscription authentication. Generate with:  claude setup-token
# This is the ONLY supported credential. Never commit the real .env.
CLAUDE_CODE_OAUTH_TOKEN=

# Discord incoming webhook URLs, one per channel key in config.yaml.
# Discord: Server Settings -> Integrations -> Webhooks -> New Webhook -> Copy URL
DISCORD_WEBHOOK_SMOKE=

# Set to "fake" to run the pipeline without consuming any subscription quota.
RUNNER=

# Opt-in to API billing instead of the subscription. Leave unset.
ALLOW_API_BILLING=
```

- [ ] **Step 10: Typecheck and commit**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass.

```bash
git add package.json package-lock.json tsconfig.json config.yaml .env.example src/errors.ts src/config.ts tests/config.test.ts
git commit -m "feat: project scaffold and validated configuration loading"
```

---

### Task 2: Agent registry and machine-readable schema

**Files:**
- Create: `src/agent-schema.ts`
- Create: `src/registry.ts`
- Create: `scripts/emit-schema.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `Config` and `ValidationError`/`formatZodError`/`combineValidationErrors` from Task 1.
- Produces: constants `TOOLS`, `TIERS`, `APPROVALS`, `MODELS`, `EFFORTS`; `AgentSchema` (zod); type `AgentYaml = z.infer<typeof AgentSchema>`; interface `AgentDef = AgentYaml & { dir: string; promptPath: string; workspace: string }`; `parseAgent(source: string, yamlText: string): AgentYaml`; `loadRegistry(opts: { agentsDir: string; dataDir: string; config: Config; env?: NodeJS.ProcessEnv }): AgentDef[]`.

- [ ] **Step 1: Write `src/agent-schema.ts`**

The `as const` arrays are the single source of truth for both runtime validation and the emitted machine-readable capability menu.

```ts
import { z } from "zod";
import { isValidTimeZone } from "./config.js";

export const TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "TodoWrite", "Task",
] as const;

export const TIERS = ["readonly", "sandboxed", "granted", "autonomous"] as const;
export const APPROVALS = ["auto", "notify", "approve"] as const;
export const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Tiers and features this plan cannot enforce yet, and the plan that delivers each. */
const NOT_YET: Record<string, string> = {
  granted: "Plan B (tiers and grant enforcement)",
  autonomous: "Plan B (tiers and grant enforcement)",
};

// `croner` silently accepts timezone "+02:00" and "PST" at construction AND at
// nextRun(), and defers a bogus zone's error to trigger time — so the schedule
// check below cannot be relied on to validate the zone. Reuse Task 1's check.
const CronTrigger = z
  .object({
    type: z.literal("cron"),
    schedule: z.string().min(1),
    timezone: z.string().superRefine((tz, ctx) => {
      if (!isValidTimeZone(tz)) {
        ctx.addIssue({
          code: "custom",
          message: `must be a canonical IANA zone name such as "Europe/Berlin" (or "UTC"); received ${JSON.stringify(tz)}. Offsets ("+02:00") and abbreviations ("PST") are rejected because they do not carry daylight-saving rules`,
        });
      }
    }),
  })
  .strict();

export const AgentSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case"),
    enabled: z.boolean().default(true),
    authoredBy: z.string().default("claude-local"),
    trigger: CronTrigger,
    run: z
      .object({
        model: z.enum(MODELS),
        effort: z.enum(EFFORTS).default("medium"),
        maxTurns: z.number().int().positive().max(200).default(40),
        timeoutMinutes: z.number().positive().max(180).default(15),
        maxBudgetUsd: z.number().positive().max(20).default(1),
      })
      .strict(),
    permissions: z
      .object({
        allowedTools: z.array(z.enum(TOOLS)).default([]),
        disallowedTools: z.array(z.enum(TOOLS)).default([]),
      })
      .strict()
      .prefault({}),
    tier: z.enum(TIERS).default("sandboxed"),
    approval: z.enum(APPROVALS).default("notify"),
    grantRefs: z.array(z.string()).default([]),
    capabilities: z
      .object({
        browser: z
          .object({
            enabled: z.boolean().default(false),
            blockedOrigins: z.array(z.string()).default([]),
            exclusiveSlot: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    outbox: z
      .object({
        discord: z.string().min(1),
        notifyOn: z
          .array(z.enum(["success", "failure", "parked"]))
          .default(["success", "failure"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    const unavailable = NOT_YET[agent.tier];
    if (unavailable) {
      ctx.addIssue({
        code: "custom",
        path: ["tier"],
        message: `tier "${agent.tier}" requires grant enforcement, which is delivered in ${unavailable}. Use "sandboxed" or "readonly" until then`,
      });
    }
    if (agent.approval !== "notify") {
      ctx.addIssue({
        code: "custom",
        path: ["approval"],
        message: `approval "${agent.approval}" requires the Discord control bot, delivered in Plan B (control channel). Use "notify" until then`,
      });
    }
    if (agent.grantRefs.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["grantRefs"],
        message: `grants are delivered in Plan B (tiers and grant enforcement). Use an empty list until then`,
      });
    }
    if (agent.capabilities.browser.enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "browser", "enabled"],
        message: `browser control is delivered in Plan C (browser capability). Set false until then`,
      });
    }
    const overlap = agent.permissions.allowedTools.filter((t) =>
      agent.permissions.disallowedTools.includes(t),
    );
    if (overlap.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: `tool(s) ${overlap.join(", ")} appear in both allowedTools and disallowedTools. List each tool in exactly one`,
      });
    }
  });

export type AgentYaml = z.infer<typeof AgentSchema>;
```

- [ ] **Step 2: Write the failing test**

Create `tests/registry.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
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

  it("rejects a tier whose enforcement is not yet built, naming the plan", () => {
    const yaml = AGENT + "tier: granted\n";
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/Plan B/);
  });

  it("rejects browser capability, naming the plan", () => {
    const yaml = AGENT + "capabilities: { browser: { enabled: true } }\n";
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/Plan C/);
  });

  it("rejects a tool listed as both allowed and disallowed", () => {
    const yaml = AGENT.replace("disallowedTools: [Bash]", "disallowedTools: [Read]");
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/exactly one/);
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 4: Write `src/registry.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { AgentSchema, type AgentYaml } from "./agent-schema.js";
import type { Config } from "./config.js";
import { ValidationError, combineValidationErrors, formatZodError } from "./errors.js";

export type AgentDef = AgentYaml & {
  dir: string;
  promptPath: string;
  workspace: string;
};

/** Always throws ValidationError — never a raw YAMLParseError, which has no `.lines`. */
export function parseAgent(source: string, yamlText: string): AgentYaml {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (error) {
    throw new ValidationError(source, [
      `is not valid YAML: ${(error as Error).message}`,
    ]);
  }
  const result = AgentSchema.safeParse(raw);
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

function isValidCron(expression: string, timezone: string): boolean {
  try {
    const probe = new Cron(expression, { timezone, paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

export function loadRegistry(opts: {
  agentsDir: string;
  dataDir: string;
  config: Config;
  env?: NodeJS.ProcessEnv;
}): AgentDef[] {
  const env = opts.env ?? process.env;
  const known = Object.keys(opts.config.discord.channels);
  const failures: ValidationError[] = [];
  const agents: AgentDef[] = [];

  const dirs = existsSync(opts.agentsDir)
    ? readdirSync(opts.agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

  for (const dirName of dirs) {
    const dir = join(opts.agentsDir, dirName);
    const source = join(dirName, "agent.yaml");
    const yamlPath = join(dir, "agent.yaml");
    const promptPath = join(dir, "prompt.md");
    const lines: string[] = [];

    if (!existsSync(yamlPath)) {
      failures.push(new ValidationError(source, ["file is missing"]));
      continue;
    }

    let agent: AgentYaml;
    try {
      agent = parseAgent(source, readFileSync(yamlPath, "utf8"));
    } catch (error) {
      failures.push(
        error instanceof ValidationError
          ? error
          : new ValidationError(source, [`could not be read: ${(error as Error).message}`]),
      );
      continue;
    }

    if (agent.name !== dirName) {
      lines.push(`name: "${agent.name}" must match its directory "${dirName}"`);
    }
    if (!existsSync(promptPath)) {
      lines.push(`prompt.md is missing. Every agent needs its task in prompt.md`);
    }
    if (!isValidCron(agent.trigger.schedule, agent.trigger.timezone)) {
      lines.push(
        `trigger.schedule: "${agent.trigger.schedule}" is not a valid cron expression. Use five fields, e.g. "0 7 * * *" for 07:00 daily`,
      );
    }
    if (!known.includes(agent.outbox.discord)) {
      lines.push(
        `outbox.discord: "${agent.outbox.discord}" is not defined in config.yaml. Known channels: ${known.join(", ") || "(none)"}`,
      );
    } else {
      const varName = opts.config.discord.channels[agent.outbox.discord]!;
      if (!env[varName]) {
        lines.push(
          `outbox.discord: channel "${agent.outbox.discord}" maps to environment variable ${varName}, which is unset. Add it to .env`,
        );
      }
    }

    if (lines.length > 0) {
      failures.push(new ValidationError(source, lines));
      continue;
    }

    agents.push({
      ...agent,
      dir,
      promptPath,
      workspace: join(opts.dataDir, "workspaces", agent.name),
    });
  }

  if (failures.length > 0) {
    throw combineValidationErrors("agent definitions", failures);
  }
  return agents;
}
```

> **Correction, applied during execution.** The `continue` above is a defect:
> an agent with both a schema fault (unknown tool) and a semantic fault (bad
> cron) reports only the first, which the test `reports every problem at once
> rather than only the first` requires it not to do. The shipped
> `src/registry.ts` falls back to the raw parsed YAML for the semantic checks
> when schema parsing fails, so both are reported in one pass. **The committed
> implementation is authoritative over this code block**; it was verified by
> review against a missing `trigger`, a non-string `schedule`, an absent
> `outbox`, and top-level YAML that is not an object.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/registry.test.ts`
Expected: PASS — every `it` block in the file above, including both `it.each`
groups expanded.

- [ ] **Step 6: Write `scripts/emit-schema.ts`**

This produces the artefacts an authoring agent reads before writing an `agent.yaml`, generated from the same definitions that validate at runtime, so the two cannot drift.

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  APPROVALS, EFFORTS, MODELS, TIERS, TOOLS, AgentSchema,
} from "../src/agent-schema.js";

mkdirSync("schema", { recursive: true });

writeFileSync(
  "schema/agent.schema.json",
  JSON.stringify(z.toJSONSchema(AgentSchema, { io: "input" }), null, 2) + "\n",
);

writeFileSync(
  "schema/capabilities.json",
  JSON.stringify(
    {
      description:
        "The complete menu of legal values for an agent.yaml. Read this before authoring one.",
      tools: TOOLS,
      tiers: TIERS,
      approvalModes: APPROVALS,
      models: MODELS,
      efforts: EFFORTS,
      triggerTypes: ["cron"],
      notYetAvailable: {
        "tier: granted / autonomous": "Plan B (tiers and grant enforcement)",
        "approval: auto / approve": "Plan B (control channel)",
        grantRefs: "Plan B (tiers and grant enforcement)",
        "capabilities.browser.enabled": "Plan C (browser capability)",
        "trigger.type: webhook": "Plan B (trigger adapters)",
      },
      neverPermitted: [
        "creating accounts or identities of any kind",
        "registering domains",
        "adding or using payment methods",
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log("wrote schema/agent.schema.json and schema/capabilities.json");
```

If `z.toJSONSchema` rejects the schema because of the `.superRefine` block, emit from the inner object schema instead: extract the `z.object({...}).strict()` into a named export `AgentObjectSchema` and apply `.superRefine` to a separate `AgentSchema` derived from it, then pass `AgentObjectSchema` here. JSON Schema cannot express cross-field refinements; the `notYetAvailable` map above is what communicates those rules to an authoring agent.

- [ ] **Step 7: Generate and inspect the schema**

Run: `npm run schema`
Expected: both files written. Open `schema/capabilities.json` and confirm the tool list matches `TOOLS`.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck && npm test`
Expected: all pass.

```bash
git add src/agent-schema.ts src/registry.ts scripts/emit-schema.ts schema tests/registry.test.ts
git commit -m "feat: agent registry with machine-readable schema and boot validation"
```

---

### Task 3: Run store — streaming transcripts and run records

**Files:**
- Create: `src/run-store.ts`
- Test: `tests/run-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: type `RunStatus = "success" | "failed" | "timeout" | "budget-exceeded" | "killed" | "interrupted"`; interface `RunResult`; `newRunId(agentName: string, now?: Date): string`; class `RunStore` with `open(runId: string, agentName: string): Promise<RunWriter>`, `readResult(runId: string): Promise<RunResult>`, `listRecent(limit: number): Promise<RunResult[]>`; interface `RunWriter` with `append(event: RunEvent): Promise<void>` and `close(partial): Promise<RunResult>`.

- [ ] **Step 1: Write the failing test**

Create `tests/run-store.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore, newRunId } from "../src/run-store.js";

describe("newRunId", () => {
  it("contains no characters illegal in a Windows filename", () => {
    const id = newRunId("smoke", new Date("2026-08-26T07:00:00.000Z"));
    expect(id).toBe("smoke-2026-08-26T07-00-00-000Z");
    expect(id).not.toContain(":");
  });
});

describe("RunStore", () => {
  it("writes each event as it arrives, before the run is closed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-runs-"));
    const store = new RunStore(dataDir);
    const runId = newRunId("smoke", new Date("2026-08-26T07:00:00.000Z"));
    const writer = await store.open(runId, "smoke");

    await writer.append({ type: "assistant", text: "working" });

    // The critical property: readable on disk mid-run, not only at the end.
    const path = join(dataDir, "runs", runId, "transcript.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).text).toBe("working");

    await writer.append({
      type: "usage",
      inputTokens: 10, outputTokens: 5, costUsd: 0.002, durationMs: 1200,
    });
    const result = await writer.close({ status: "success", summary: "done" });

    expect(result.status).toBe("success");
    expect(result.costUsd).toBeCloseTo(0.002);
    expect(result.inputTokens).toBe(10);
    expect(result.turns).toBe(0);

    const stored = await store.readResult(runId);
    expect(stored.runId).toBe(runId);
    expect(stored.agent).toBe("smoke");
  });

  it("counts tool calls as turns", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    const writer = await store.open(newRunId("a"), "a");
    await writer.append({ type: "tool_use", name: "Read" });
    await writer.append({ type: "tool_use", name: "Write" });
    const result = await writer.close({ status: "success", summary: "" });
    expect(result.turns).toBe(2);
  });

  it("returns the tail of the transcript for failure reporting", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    const writer = await store.open(newRunId("a"), "a");
    for (let i = 0; i < 30; i++) {
      await writer.append({ type: "assistant", text: `line ${i}` });
    }
    await writer.close({ status: "failed", summary: "", error: "boom" });
    const tail = await writer.tail(20);
    expect(tail).toHaveLength(20);
    expect(tail[19]).toContain("line 29");
  });

  it("lists recent runs newest first", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    for (const t of ["2026-08-26T01:00:00.000Z", "2026-08-26T02:00:00.000Z"]) {
      const writer = await store.open(newRunId("a", new Date(t)), "a");
      await writer.close({ status: "success", summary: "" });
    }
    const recent = await store.listRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.runId).toContain("02-00-00");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/run-store.test.ts`
Expected: FAIL — cannot resolve `../src/run-store.js`.

- [ ] **Step 3: Write `src/run-store.ts`**

```ts
import { mkdir, appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "./runner/types.js";

export type RunStatus =
  | "success" | "failed" | "timeout" | "budget-exceeded" | "killed" | "interrupted";

export interface RunResult {
  runId: string;
  agent: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  summary: string;
  error?: string;
}

/** Filesystem-safe on Windows: no colons. */
export function newRunId(agentName: string, now: Date = new Date()): string {
  return `${agentName}-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export interface RunWriter {
  readonly runId: string;
  append(event: RunEvent): Promise<void>;
  tail(lines: number): Promise<string[]>;
  close(partial: {
    status: RunStatus;
    summary: string;
    error?: string;
  }): Promise<RunResult>;
}

export class RunStore {
  constructor(private readonly dataDir: string) {}

  private runDir(runId: string): string {
    return join(this.dataDir, "runs", runId);
  }

  async open(runId: string, agentName: string): Promise<RunWriter> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const transcript = join(dir, "transcript.jsonl");
    const startedAt = new Date();

    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    let lastText = "";

    const writer: RunWriter = {
      runId,
      async append(event: RunEvent): Promise<void> {
        if (event.type === "usage") {
          costUsd += event.costUsd;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        }
        if (event.type === "tool_use") turns += 1;
        if (event.type === "assistant" && event.text.trim()) lastText = event.text.trim();
        await appendFile(transcript, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
      },
      async tail(lines: number): Promise<string[]> {
        const raw = await readFile(transcript, "utf8").catch(() => "");
        return raw.trim().split("\n").filter(Boolean).slice(-lines);
      },
      async close(partial): Promise<RunResult> {
        const endedAt = new Date();
        const result: RunResult = {
          runId,
          agent: agentName,
          status: partial.status,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
          costUsd,
          inputTokens,
          outputTokens,
          turns,
          summary: partial.summary || lastText,
          ...(partial.error ? { error: partial.error } : {}),
        };
        await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
        return result;
      },
    };
    return writer;
  }

  async readResult(runId: string): Promise<RunResult> {
    const raw = await readFile(join(this.runDir(runId), "result.json"), "utf8");
    return JSON.parse(raw) as RunResult;
  }

  async listRecent(limit: number): Promise<RunResult[]> {
    const root = join(this.dataDir, "runs");
    const dirs = await readdir(root).catch(() => [] as string[]);
    const results: RunResult[] = [];
    for (const runId of dirs.sort().reverse().slice(0, limit)) {
      const result = await this.readResult(runId).catch(() => null);
      if (result) results.push(result);
    }
    return results;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/run-store.test.ts`
Expected: FAIL initially — `./runner/types.js` does not exist yet. Create it now as part of this task (it is a pure type module with no behaviour of its own):

```ts
// src/runner/types.ts
import type { AgentDef } from "../registry.js";

export type RunEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }
  | { type: "error"; message: string };

export interface RunContext {
  runId: string;
  workspace: string;
  prompt: string;
}

export interface Runner {
  execute(agent: AgentDef, ctx: RunContext, signal: AbortSignal): AsyncIterable<RunEvent>;
}
```

Re-run: `npm test -- tests/run-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/run-store.ts src/runner/types.ts tests/run-store.test.ts
git commit -m "feat: run store with streamed transcripts and run records"
```

---

### Task 4: FakeRunner

**Files:**
- Create: `src/runner/fake-runner.ts`
- Test: `tests/fake-runner.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunEvent`, `RunContext` from `src/runner/types.ts`; `AgentDef` from Task 2.
- Produces: class `FakeRunner implements Runner`, constructed as `new FakeRunner(script: FakeScript)` where `FakeScript = { events: RunEvent[]; throwAfter?: number; hangForever?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `tests/fake-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";

const AGENT = { name: "smoke" } as AgentDef;
const CTX = { runId: "smoke-1", workspace: "/tmp/ws", prompt: "hi" };

async function drain(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("FakeRunner", () => {
  it("replays its scripted events in order", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "assistant", text: "thinking" },
        { type: "tool_use", name: "Write" },
        { type: "usage", inputTokens: 1, outputTokens: 2, costUsd: 0.01, durationMs: 5 },
      ],
    });
    const events = await drain(runner.execute(AGENT, CTX, new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(["assistant", "tool_use", "usage"]);
  });

  it("throws after the configured number of events", async () => {
    const runner = new FakeRunner({
      events: [{ type: "assistant", text: "a" }, { type: "assistant", text: "b" }],
      throwAfter: 1,
    });
    await expect(drain(runner.execute(AGENT, CTX, new AbortController().signal)))
      .rejects.toThrow(/scripted failure/);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const runner = new FakeRunner({ events: [], hangForever: true });
    const promise = drain(runner.execute(AGENT, CTX, controller.signal));
    controller.abort();
    await expect(promise).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/fake-runner.test.ts`
Expected: FAIL — cannot resolve `../src/runner/fake-runner.js`.

- [ ] **Step 3: Write `src/runner/fake-runner.ts`**

```ts
import type { AgentDef } from "../registry.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

export interface FakeScript {
  events: RunEvent[];
  /** Throw once this many events have been yielded. */
  throwAfter?: number;
  /** Yield nothing and wait until aborted — for exercising timeout handling. */
  hangForever?: boolean;
}

export class FakeRunner implements Runner {
  constructor(private readonly script: FakeScript) {}

  async *execute(
    _agent: AgentDef,
    _ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    if (this.script.hangForever) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    let yielded = 0;
    for (const event of this.script.events) {
      if (signal.aborted) return;
      if (this.script.throwAfter !== undefined && yielded >= this.script.throwAfter) {
        throw new Error("scripted failure");
      }
      yield event;
      yielded += 1;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/fake-runner.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runner/fake-runner.ts tests/fake-runner.test.ts
git commit -m "test: FakeRunner for exercising the pipeline without quota"
```

---

### Task 5: Discord outbox with retry and undelivered fallback

**Files:**
- Create: `src/outbox/discord.ts`
- Test: `tests/outbox.test.ts`

**Interfaces:**
- Consumes: `RunResult`, `RunStatus` from Task 3; `Config` from Task 1.
- Produces: `formatRunMessage(result: RunResult, tail?: string[]): string`; class `DiscordOutbox` constructed as `new DiscordOutbox(opts: { config: Config; dataDir: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> })` with `post(channelKey: string, result: RunResult, tail?: string[]): Promise<"delivered" | "undelivered">`.

- [ ] **Step 1: Write the failing test**

Create `tests/outbox.test.ts`:

```ts
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
    const failed = { ...RESULT, status: "failed" as const, error: "boom" };
    const text = formatRunMessage(failed, ['{"type":"error","message":"boom"}']);
    expect(text).toContain("boom");
  });

  it("stays within the Discord 2000-character limit", () => {
    const tail = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const text = formatRunMessage({ ...RESULT, status: "failed" }, tail);
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});

describe("DiscordOutbox", () => {
  it("delivers on the first attempt", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 204 })) as unknown as typeof fetch;
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/outbox.test.ts`
Expected: FAIL — cannot resolve `../src/outbox/discord.js`.

- [ ] **Step 3: Write `src/outbox/discord.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { RunResult } from "../run-store.js";

const DISCORD_LIMIT = 2000;

const ICON: Record<string, string> = {
  success: "✅", failed: "❌", timeout: "⏱️",
  "budget-exceeded": "💸", killed: "🛑", interrupted: "⚠️",
};

export function formatRunMessage(result: RunResult, tail?: string[]): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const header =
    `${ICON[result.status] ?? "•"} **${result.agent}** — ${result.status}\n` +
    `\`${result.runId}\`\n` +
    `${result.turns} turns · ${seconds}s · $${result.costUsd.toFixed(4)} · ` +
    `${result.inputTokens}in/${result.outputTokens}out\n`;

  const body = result.summary ? `\n${result.summary}\n` : "";
  const failureDetail = result.error ? `\n**Error:** ${result.error}\n` : "";

  let message = header + body + failureDetail;

  if (tail && tail.length > 0 && result.status !== "success") {
    const budget = DISCORD_LIMIT - message.length - 20;
    let block = "";
    for (const line of tail.slice(-20)) {
      if (block.length + line.length + 1 > budget) break;
      block += line + "\n";
    }
    if (block) message += "```\n" + block + "```";
  }

  return message.length > DISCORD_LIMIT
    ? message.slice(0, DISCORD_LIMIT - 3) + "..."
    : message;
}

export class DiscordOutbox {
  private readonly config: Config;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    config: Config;
    dataDir: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.config = opts.config;
    this.dataDir = opts.dataDir;
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private webhookFor(channelKey: string): string {
    const varName = this.config.discord.channels[channelKey];
    if (!varName) {
      throw new Error(
        `Discord channel "${channelKey}" is not defined in config.yaml. ` +
          `Known channels: ${Object.keys(this.config.discord.channels).join(", ") || "(none)"}`,
      );
    }
    const url = this.env[varName];
    if (!url) {
      throw new Error(`Environment variable ${varName} is unset. Add it to .env`);
    }
    return url;
  }

  async post(
    channelKey: string,
    result: RunResult,
    tail?: string[],
  ): Promise<"delivered" | "undelivered"> {
    const url = this.webhookFor(channelKey);
    const content = formatRunMessage(result, tail);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (response.ok) return "delivered";
      } catch {
        // fall through to retry
      }
      if (attempt < 3) await this.sleep(attempt * 1000);
    }

    const dir = join(this.dataDir, "undelivered");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${result.runId}.json`),
      JSON.stringify({ channelKey, content, result }, null, 2) + "\n",
    );
    return "undelivered";
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/outbox.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/outbox/discord.ts tests/outbox.test.ts
git commit -m "feat: Discord outbox with retry and undelivered fallback"
```

---

### Task 6: Orchestrator, cron trigger, and end-to-end wiring

**Files:**
- Create: `src/orchestrator.ts`
- Create: `src/triggers/cron.ts`
- Create: `src/index.ts`
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `AgentDef` (Task 2), `RunStore`/`newRunId`/`RunStatus`/`RunResult` (Task 3), `Runner`/`RunEvent` (Task 3), `FakeRunner` (Task 4), `DiscordOutbox` (Task 5).
- Produces: class `Orchestrator` constructed as `new Orchestrator(opts: { runner: Runner; store: RunStore; outbox: DiscordOutbox; dataDir: string })` with `executeRun(agent: AgentDef, now?: Date): Promise<RunResult>`; `startCron(agents: AgentDef[], orchestrator: Orchestrator): Cron[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator.test.ts`:

```ts
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { DiscordOutbox } from "../src/outbox/discord.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { FakeScript } from "../src/runner/fake-runner.js";

const CONFIG = parseConfig(
  "config.yaml",
  "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n",
);
const ENV = { DISCORD_WEBHOOK_SMOKE: "https://discord.test/hook" };

function harness(script: FakeScript, agentOverrides: Partial<AgentDef> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-orch-"));
  const promptPath = join(dataDir, "prompt.md");
  writeFileSync(promptPath, "Do the thing.");

  const agent = {
    name: "smoke",
    enabled: true,
    dir: dataDir,
    promptPath,
    workspace: join(dataDir, "workspaces", "smoke"),
    run: { model: "claude-haiku-4-5", effort: "medium", maxTurns: 5,
           timeoutMinutes: 0.001, maxBudgetUsd: 0.1 },
    outbox: { discord: "smoke", notifyOn: ["success", "failure"] },
    ...agentOverrides,
  } as unknown as AgentDef;

  const fetchImpl = vi.fn(async () => new Response("", { status: 204 })) as unknown as typeof fetch;
  const orchestrator = new Orchestrator({
    runner: new FakeRunner(script),
    store: new RunStore(dataDir),
    outbox: new DiscordOutbox({ config: CONFIG, dataDir, env: ENV, fetchImpl, sleep: async () => {} }),
    dataDir,
  });
  return { agent, orchestrator, dataDir, fetchImpl };
}

describe("Orchestrator.executeRun", () => {
  it("runs, records a transcript and result, and reports", async () => {
    const { agent, orchestrator, dataDir, fetchImpl } = harness({
      events: [
        { type: "assistant", text: "Done: wrote notes." },
        { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.001, durationMs: 900 },
      ],
    });

    const result = await orchestrator.executeRun(agent);

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Done: wrote notes.");
    expect(existsSync(join(dataDir, "runs", result.runId, "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "runs", result.runId, "result.json"))).toBe(true);
    expect(existsSync(agent.workspace)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records a failure and still reports it", async () => {
    const { agent, orchestrator, fetchImpl } = harness({
      events: [{ type: "assistant", text: "starting" }],
      throwAfter: 1,
    });
    const result = await orchestrator.executeRun(agent);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("scripted failure");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts a run that exceeds its timeout", async () => {
    const { agent, orchestrator } = harness({ events: [], hangForever: true });
    const result = await orchestrator.executeRun(agent);
    expect(result.status).toBe("timeout");
  });

  it("suppresses reporting when the status is not in notifyOn", async () => {
    const { agent, orchestrator, fetchImpl } = harness(
      { events: [{ type: "assistant", text: "ok" }] },
      { outbox: { discord: "smoke", notifyOn: ["failure"] } } as Partial<AgentDef>,
    );
    await orchestrator.executeRun(agent);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("halts when the STOP file is present", async () => {
    const { agent, orchestrator, dataDir } = harness({
      events: [{ type: "assistant", text: "ok" }],
    });
    writeFileSync(join(dataDir, "STOP"), "");
    const result = await orchestrator.executeRun(agent);
    expect(result.status).toBe("killed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator.js`.

- [ ] **Step 3: Write `src/orchestrator.ts`**

```ts
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscordOutbox } from "./outbox/discord.js";
import type { AgentDef } from "./registry.js";
import { RunStore, newRunId, type RunResult, type RunStatus } from "./run-store.js";
import type { Runner } from "./runner/types.js";

export class Orchestrator {
  private readonly runner: Runner;
  private readonly store: RunStore;
  private readonly outbox: DiscordOutbox;
  private readonly dataDir: string;

  constructor(opts: {
    runner: Runner;
    store: RunStore;
    outbox: DiscordOutbox;
    dataDir: string;
  }) {
    this.runner = opts.runner;
    this.store = opts.store;
    this.outbox = opts.outbox;
    this.dataDir = opts.dataDir;
  }

  private stopRequested(): boolean {
    return existsSync(join(this.dataDir, "STOP"));
  }

  async executeRun(agent: AgentDef, now: Date = new Date()): Promise<RunResult> {
    const runId = newRunId(agent.name, now);
    const writer = await this.store.open(runId, agent.name);

    if (this.stopRequested()) {
      await writer.append({ type: "error", message: "STOP file present; run refused" });
      const result = await writer.close({
        status: "killed", summary: "Refused: STOP file present",
      });
      await this.report(agent, result, writer);
      return result;
    }

    await mkdir(agent.workspace, { recursive: true });
    const prompt = await readFile(agent.promptPath, "utf8");

    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.round(agent.run.timeoutMinutes * 60_000));
    let status: RunStatus = "success";
    let error: string | undefined;

    const timer = setTimeout(() => {
      status = "timeout";
      controller.abort();
    }, timeoutMs);

    try {
      const stream = this.runner.execute(
        agent,
        { runId, workspace: agent.workspace, prompt },
        controller.signal,
      );
      for await (const event of stream) {
        await writer.append(event);
        if (event.type === "error") {
          status = "failed";
          error = event.message;
        }
      }
    } catch (thrown) {
      if (status !== "timeout") {
        status = "failed";
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      await writer.append({ type: "error", message: error ?? "aborted" });
    } finally {
      clearTimeout(timer);
    }

    if (status === "timeout") {
      error = `Run exceeded its ${agent.run.timeoutMinutes} minute limit and was aborted`;
    }

    const result = await writer.close({ status, summary: "", ...(error ? { error } : {}) });
    await this.report(agent, result, writer);
    return result;
  }

  private async report(
    agent: AgentDef,
    result: RunResult,
    writer: { tail(n: number): Promise<string[]> },
  ): Promise<void> {
    const category = result.status === "success" ? "success" : "failure";
    if (!agent.outbox.notifyOn.includes(category as "success" | "failure")) return;
    const tail = result.status === "success" ? undefined : await writer.tail(20);
    await this.outbox.post(agent.outbox.discord, result, tail);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write `src/triggers/cron.ts`**

```ts
import { Cron } from "croner";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";

export function startCron(agents: AgentDef[], orchestrator: Orchestrator): Cron[] {
  const jobs: Cron[] = [];
  for (const agent of agents) {
    if (!agent.enabled) {
      console.log(`[cron] ${agent.name} is disabled; not scheduled`);
      continue;
    }
    const job = new Cron(
      agent.trigger.schedule,
      { timezone: agent.trigger.timezone, protect: true },
      () => {
        void orchestrator.executeRun(agent).catch((error: unknown) => {
          console.error(`[cron] ${agent.name} run failed to complete`, error);
        });
      },
    );
    console.log(
      `[cron] ${agent.name} scheduled "${agent.trigger.schedule}" (${agent.trigger.timezone}); ` +
        `next run ${job.nextRun()?.toISOString() ?? "never"}`,
    );
    jobs.push(job);
  }
  return jobs;
}
```

`protect: true` prevents a second run starting while the previous one is still in flight — a per-agent overlap guard until the full governor arrives in Plan B.

- [ ] **Step 6: Write `src/index.ts`**

```ts
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ValidationError } from "./errors.js";
import { Orchestrator } from "./orchestrator.js";
import { DiscordOutbox } from "./outbox/discord.js";
import { loadRegistry } from "./registry.js";
import { RunStore } from "./run-store.js";
import { FakeRunner } from "./runner/fake-runner.js";
import { SdkRunner } from "./runner/sdk-runner.js";
import type { Runner } from "./runner/types.js";

const ROOT = process.env.APP_ROOT ?? process.cwd();
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");

function buildRunner(): Runner {
  if (process.env.RUNNER === "fake") {
    console.log("[boot] RUNNER=fake — no subscription quota will be consumed");
    return new FakeRunner({
      events: [
        { type: "assistant", text: "Fake run: the pipeline is working." },
        { type: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 },
      ],
    });
  }
  return new SdkRunner();
}

function main(): void {
  let config, agents;
  try {
    config = loadConfig(join(ROOT, "config.yaml"));
    agents = loadRegistry({ agentsDir: join(ROOT, "agents"), dataDir: DATA_DIR, config });
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`\n[boot] Configuration is invalid. Nothing was started.\n`);
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  console.log(`[boot] ${agents.length} agent(s) loaded: ${agents.map((a) => a.name).join(", ")}`);

  const orchestrator = new Orchestrator({
    runner: buildRunner(),
    store: new RunStore(DATA_DIR),
    outbox: new DiscordOutbox({ config, dataDir: DATA_DIR }),
    dataDir: DATA_DIR,
  });

  // Imported lazily so a boot failure above never starts a schedule.
  void import("./triggers/cron.js").then(({ startCron }) => {
    startCron(agents, orchestrator);
    console.log("[boot] supervisor running");
  });
}

main();
```

- [ ] **Step 7: Verify the boot path with the fake runner**

Run: `RUNNER=fake DISCORD_WEBHOOK_SMOKE=https://example.invalid/hook npm start`
(PowerShell: `$env:RUNNER="fake"; $env:DISCORD_WEBHOOK_SMOKE="https://example.invalid/hook"; npm start`)

Expected: boot fails with a clear message that `agents/` contains no agents, or — once Task 8 adds the smoke agent — prints the schedule and its next run time. It must not crash with a stack trace. Note `src/runner/sdk-runner.ts` does not exist yet, so this step will fail to import until Task 7; if you are running tasks in order, verify with `npm run typecheck` instead and return to this step after Task 7.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts src/triggers/cron.ts src/index.ts tests/orchestrator.test.ts
git commit -m "feat: orchestrator, cron trigger, and supervisor entrypoint"
```

---

### Task 7: SdkRunner and credential resolution

**Files:**
- Create: `src/runner/credentials.ts`
- Create: `scripts/probe-sdk.ts`
- Create: `src/runner/sdk-runner.ts`
- Test: `tests/credentials.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunEvent`, `RunContext` (Task 3); `AgentDef` (Task 2).
- Produces: type `CredentialMode = "subscription" | "api-key"`; `resolveCredentials(env?: NodeJS.ProcessEnv): { mode: CredentialMode; childEnv: Record<string, string> }`; class `SdkRunner implements Runner`.

- [ ] **Step 1: Write the failing credentials test**

Create `tests/credentials.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveCredentials } from "../src/runner/credentials.js";

describe("resolveCredentials", () => {
  it("uses the subscription token when present", () => {
    const { mode, childEnv } = resolveCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(mode).toBe("subscription");
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("strips an API key so a stray variable can never cause API billing", () => {
    const { mode, childEnv } = resolveCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "sk-should-be-removed",
    });
    expect(mode).toBe("subscription");
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("refuses an API key unless billing is explicitly opted into", () => {
    expect(() => resolveCredentials({ ANTHROPIC_API_KEY: "sk-x" })).toThrow(
      /ALLOW_API_BILLING/,
    );
  });

  it("permits API billing when explicitly opted into", () => {
    const { mode } = resolveCredentials({
      ANTHROPIC_API_KEY: "sk-x", ALLOW_API_BILLING: "true",
    });
    expect(mode).toBe("api-key");
  });

  it("explains how to obtain a token when no credential is present", () => {
    expect(() => resolveCredentials({})).toThrow(/claude setup-token/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/credentials.test.ts`
Expected: FAIL — cannot resolve `../src/runner/credentials.js`.

- [ ] **Step 3: Write `src/runner/credentials.ts`**

```ts
export type CredentialMode = "subscription" | "api-key";

/**
 * Resolves the credential the agent process will use.
 *
 * Subscription authentication is the only supported default. An API key is
 * accepted solely when ALLOW_API_BILLING=true, and in subscription mode the
 * key is actively stripped from the child environment so a stray variable can
 * never silently move spending onto API billing.
 */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): {
  mode: CredentialMode;
  childEnv: Record<string, string>;
} {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }

  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    return { mode: "subscription", childEnv };
  }

  if (env.ANTHROPIC_API_KEY) {
    if (env.ALLOW_API_BILLING !== "true") {
      throw new Error(
        "ANTHROPIC_API_KEY is set but CLAUDE_CODE_OAUTH_TOKEN is not. This platform " +
          "runs on a Claude subscription; using the key would bill the API instead. " +
          "Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or set " +
          "ALLOW_API_BILLING=true if API billing is genuinely intended.",
      );
    }
    return { mode: "api-key", childEnv };
  }

  throw new Error(
    "No Claude credential found. Run `claude setup-token` on a machine where you " +
      "are logged in, then set CLAUDE_CODE_OAUTH_TOKEN in .env",
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/credentials.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write and run the SDK probe**

The exact discriminators on the SDK's message union vary by version. Rather than guessing, observe them once and write the mapper against what actually arrives.

Create `scripts/probe-sdk.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../src/runner/credentials.js";

const { mode, childEnv } = resolveCredentials();
console.log(`credential mode: ${mode}\n`);

for await (const message of query({
  prompt: "Reply with exactly the word: ready",
  options: {
    model: "claude-haiku-4-5",
    maxTurns: 1,
    allowedTools: [],
    env: childEnv,
    permissionMode: "default",
    settingSources: [],
  },
})) {
  const record = message as Record<string, unknown>;
  console.log(record.type, "→", Object.keys(record).join(", "));
  console.log(JSON.stringify(message).slice(0, 400));
  console.log("---");
}
```

Run: `npm run probe`
Expected: a short sequence of messages ending in one carrying token counts and a cost estimate. **Record the exact `type` values and field names you see** — the next step's mapper must match them.

This is also the first proof that subscription authentication works end to end. If it fails with an authentication error, `claude setup-token` has not been run or `CLAUDE_CODE_OAUTH_TOKEN` is not set.

- [ ] **Step 6: Write `src/runner/sdk-runner.ts`**

Adjust the `case` labels and field reads in `toRunEvent` to match what Step 5 printed. The defensive shape below tolerates unknown message types by ignoring them, so an SDK upgrade degrades reporting rather than crashing a run.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDef } from "../registry.js";
import { resolveCredentials } from "./credentials.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

function textOf(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content
    ?? message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Maps one SDK message to a RunEvent, or null for messages we do not record. */
export function toRunEvent(message: unknown): RunEvent | null {
  const m = message as Record<string, unknown>;
  switch (m.type) {
    case "assistant": {
      const text = textOf(m);
      return text.trim() ? { type: "assistant", text } : null;
    }
    case "tool_use":
      return { type: "tool_use", name: String(m.name ?? "unknown") };
    case "tool_result":
      return { type: "tool_result", name: String(m.name ?? "unknown"), ok: m.is_error !== true };
    case "usage":
    case "result": {
      const usage = (m.usage as Record<string, unknown> | undefined) ?? m;
      return {
        type: "usage",
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        costUsd: num(m.total_cost_usd ?? usage.total_cost_usd),
        durationMs: num(m.session_duration_ms ?? m.duration_ms),
      };
    }
    default:
      return null;
  }
}

export class SdkRunner implements Runner {
  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), { once: true });

    const stream = query({
      prompt: ctx.prompt,
      options: {
        model: agent.run.model,
        effort: agent.run.effort,
        maxTurns: agent.run.maxTurns,
        maxBudgetUsd: agent.run.maxBudgetUsd,
        cwd: ctx.workspace,
        allowedTools: agent.permissions.allowedTools,
        disallowedTools: agent.permissions.disallowedTools,
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: controller,
      },
    });

    for await (const message of stream) {
      if (signal.aborted) return;
      const event = toRunEvent(message);
      if (event) yield event;
    }
  }
}
```

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/runner/credentials.ts src/runner/sdk-runner.ts scripts/probe-sdk.ts tests/credentials.test.ts
git commit -m "feat: SDK runner with subscription-first credential resolution"
```

---

### Task 8: Docker, the smoke agent, and the milestone

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`
- Create: `agents/smoke/agent.yaml`, `agents/smoke/prompt.md`
- Create: `README.md`
- Modify: `config.yaml` (already contains the `smoke` channel from Task 1)

**Interfaces:**
- Consumes: everything above.
- Produces: a running container; no code interfaces.

Plan C swaps the base image to `mcr.microsoft.com/playwright:v1.x-noble` when the browser capability arrives. Until then a slim Node image keeps the first build to seconds rather than minutes.

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV APP_ROOT=/app
ENV DATA_DIR=/app/data

CMD ["npx", "tsx", "src/index.ts"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
data
.git
.env
docs
tests
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  supervisor:
    build: .
    env_file: .env
    volumes:
      - agent-data:/app/data
      - ./agents:/app/agents:ro
      - ./config.yaml:/app/config.yaml:ro
    restart: unless-stopped

volumes:
  agent-data:
```

`agents/` and `config.yaml` are mounted read-only: the supervisor reads its own definitions but cannot rewrite them, which is the first physical expression of the privilege boundary in spec §3.

- [ ] **Step 4: Create the smoke agent**

`agents/smoke/agent.yaml` — deliberately Haiku, tiny budget, few turns:

```yaml
name: smoke
enabled: true
authoredBy: claude-local

trigger:
  type: cron
  schedule: "*/5 * * * *"
  timezone: Europe/Berlin

run:
  model: claude-haiku-4-5
  effort: low
  maxTurns: 6
  timeoutMinutes: 3
  maxBudgetUsd: 0.10

permissions:
  allowedTools: [Read, Write]
  disallowedTools: [Bash]

tier: sandboxed
approval: notify
grantRefs: []

outbox:
  discord: smoke
  notifyOn: [success, failure]
```

`agents/smoke/prompt.md`:

```markdown
You are a smoke-test agent. Your only job is to prove the platform works.

1. Read `notes.md` in your working directory if it exists.
2. Append one line: today's date, and a single interesting sentence about
   any topic you like. Do not repeat a topic already in the file.
3. Reply with just that sentence, and nothing else.

Keep the whole run under five turns.
```

- [ ] **Step 5: Verify the pipeline with the fake runner — no quota consumed**

Create `.env` from `.env.example`, filling in `DISCORD_WEBHOOK_SMOKE` with a real webhook URL and leaving `CLAUDE_CODE_OAUTH_TOKEN` empty for now. Add `RUNNER=fake`.

Run: `docker compose up --build`

Expected:
- Boot prints `[boot] 1 agent(s) loaded: smoke`.
- Boot prints the cron schedule and the next run time.
- Within five minutes, a message appears in your Discord channel.
- No Claude quota is consumed.

If boot fails, the error names the exact file, path, and fix. Correct it and re-run.

- [ ] **Step 6: Mint the subscription token**

Run on the host (not in the container): `claude setup-token`

Copy the token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, and **remove `RUNNER=fake`**.

- [ ] **Step 7: Verify the real run — THE MILESTONE**

Run: `docker compose up --build`

Expected within five minutes:
- A Discord message from `smoke` with status `success`, a real sentence, a turn count, a duration, and a cost estimate.
- `docker compose exec supervisor cat /app/data/workspaces/smoke/notes.md` shows the appended line.
- `docker compose exec supervisor sh -c 'ls /app/data/runs'` shows one run directory containing `transcript.jsonl` and `result.json`.

**This is the milestone:** an agent ran unattended, on a schedule, authenticated by a Claude subscription with no API key involved, and reported to Discord. Everything in Plans B and C adds layers to a loop that already closes.

- [ ] **Step 8: Verify the kill switch**

Run: `docker compose exec supervisor touch /app/data/STOP`

Expected: the next scheduled run reports status `killed` and does nothing. Then:

Run: `docker compose exec supervisor rm /app/data/STOP`

Expected: runs resume on the following tick.

- [ ] **Step 9: Move the smoke agent off its five-minute schedule**

Edit `agents/smoke/agent.yaml` and change the schedule to `"0 6 * * *"` so it runs once a day rather than 288 times.

- [ ] **Step 10: Write `README.md`**

```markdown
# Claude Agent Infrastructure

Runs Claude agents unattended on a schedule, authenticated by a Claude
subscription rather than the API. Results are reported to Discord.

Design: `docs/superpowers/specs/2026-08-26-claude-agent-infrastructure-design.md`

## Setup

1. `cp .env.example .env`
2. `claude setup-token` — paste the result into `CLAUDE_CODE_OAUTH_TOKEN`
3. Create a Discord incoming webhook (Server Settings → Integrations →
   Webhooks → New Webhook → Copy URL) and paste it into `DISCORD_WEBHOOK_SMOKE`
4. `docker compose up --build`

## Adding an agent

Create `agents/<name>/agent.yaml` and `agents/<name>/prompt.md`. Legal values
for every field are in `schema/capabilities.json`; the JSON Schema is in
`schema/agent.schema.json`. Regenerate both with `npm run schema`.
Restart the supervisor to pick up changes.

## Operating

- Test without consuming quota: set `RUNNER=fake` in `.env`
- Stop everything: `docker compose exec supervisor touch /app/data/STOP`
- Resume: `docker compose exec supervisor rm /app/data/STOP`
- Run history: `docker compose exec supervisor sh -c 'ls /app/data/runs'`

## Development

- `npm test` — full suite, no quota consumed
- `npm run typecheck`
- `npm run probe` — one real Haiku call, proves authentication works
```

- [ ] **Step 11: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml agents README.md config.yaml
git commit -m "feat: containerise the supervisor and add the smoke agent"
```

---

## Self-Review

**Spec coverage for Plan A's declared scope:**

| Spec section | Task |
|---|---|
| §5 repository layout | 1, 2, 3, 8 |
| §6 agent definition, machine-first schema, boot validation, model choice | 2 |
| §7.1 Runner seam, FakeRunner, SDK option mapping | 4, 7 |
| §7.5 Outbox, retry, undelivered | 5 |
| §8.1 normal lifecycle, streamed transcripts | 3, 6 |
| §8.3 agent error, timeout, Discord unreachable, supervisor restart | 5, 6, 8 |
| §9 registry, outbox, end-to-end, smoke rows | 2, 5, 6, 8 |
| §10 phase 1 local deployment | 8 |
| Success criteria 1, 3, 5 (partial), 7 | 8, 7, 6, 4 |

**Deferred with explicit boot-time rejection, not silence:** §7.2 tiers and grants, §7.3 governor, §7.4 control bot, §7.6 provisioning, §8.2 park/resume, §3 locks 1 and 2. Success criteria 2, 4 and 6 belong to Plans B and C. Lock 3 (secrets never in a workspace) is partially honoured already: no grant credentials exist yet, and `resolveCredentials` is the only path that touches credentials.

**Known deviations from the spec, deliberate:**
1. Base image is `node:24-bookworm-slim` rather than the Playwright image; Plan C swaps it when the browser capability lands. Rationale: a 2 GB pull before the first milestone is a poor trade.
2. `approval` is restricted to `notify` and `tier` to `readonly`/`sandboxed`, because the machinery enforcing the others does not exist yet. The spec's default of `approve` is restored in Plan B.

**Type consistency:** `RunEvent`, `RunContext`, and `Runner` are defined once in `src/runner/types.ts` (created in Task 3, consumed in Tasks 4, 6, 7). `RunResult`/`RunStatus` are defined in Task 3 and consumed in Tasks 5 and 6. `AgentDef` is defined in Task 2 and consumed in Tasks 4, 6, 7. `formatRunMessage` and `DiscordOutbox.post` signatures match their call sites in `Orchestrator.report`.

**One acknowledged uncertainty:** the SDK message union's exact discriminators. Task 7 Step 5 resolves it by observation before the mapper is written, rather than by guessing — and `toRunEvent` ignores unknown message types so a future SDK upgrade degrades reporting instead of breaking runs.
