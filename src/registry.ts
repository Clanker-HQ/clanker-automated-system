import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentSchema, type AgentYaml } from "./agent-schema.js";
import { isValidCron, type Config } from "./config.js";
import { ValidationError, combineValidationErrors, formatZodError } from "./errors.js";

export type AgentDef = AgentYaml & {
  dir: string;
  promptPath: string;
  workspace: string;
};

export function parseAgent(source: string, yamlText: string): AgentYaml {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ValidationError(source, [
      `is not valid YAML: ${(error as Error).message}`,
    ]);
  }
  const result = AgentSchema.safeParse(raw ?? {});
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

    const yamlText = readFileSync(yamlPath, "utf8");

    // A schema problem (caught by parseAgent) and a semantic problem (bad
    // cron, unknown outbox channel, name/directory mismatch) can both be
    // present in the same file. If a schema error short-circuited the rest
    // of these checks, the model fixing it would only learn of the next
    // problem on its next round trip — so on failure we fall back to the
    // raw YAML to keep checking everything else, instead of bailing out.
    let agent: AgentYaml | undefined;
    let raw: Record<string, unknown> = {};
    try {
      agent = parseAgent(source, yamlText);
    } catch (error) {
      if (error instanceof ValidationError) {
        lines.push(...error.lines);
      } else {
        lines.push((error as Error).message);
      }
      // parseAgent already parsed this text once; a syntax error there would
      // throw again here, so this fallback parse must not be allowed to
      // escape uncaught — it would abandon every other agent in the
      // registry. On any failure, raw simply stays {} and the checks below
      // (all optional-field lookups) fall through with nothing extra to add.
      try {
        raw = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
      } catch {
        raw = {};
      }
    }

    const rawTrigger = raw["trigger"] as Record<string, unknown> | undefined;
    const rawOutbox = raw["outbox"] as Record<string, unknown> | undefined;
    const name = agent?.name ?? asString(raw["name"]);
    const triggerType = agent?.trigger.type ?? asString(rawTrigger?.["type"]);
    const schedule = agent?.trigger.type === "cron" ? agent.trigger.schedule : asString(rawTrigger?.["schedule"]);
    const timezone = agent?.trigger.type === "cron" ? agent.trigger.timezone : asString(rawTrigger?.["timezone"]);
    const discord = agent?.outbox.discord ?? asString(rawOutbox?.["discord"]);

    if (name !== undefined && name !== dirName) {
      lines.push(`name: "${name}" must match its directory "${dirName}"`);
    }
    if (!existsSync(promptPath)) {
      lines.push(`prompt.md is missing. Every agent needs its task in prompt.md`);
    }
    if (triggerType === "cron" && schedule !== undefined && timezone !== undefined && !isValidCron(schedule, timezone)) {
      lines.push(
        `trigger.schedule: "${schedule}" is not a valid cron expression. Use five or six fields (croner also accepts a leading seconds field), e.g. "0 7 * * *" for 07:00 daily`,
      );
    }
    if (discord !== undefined) {
      if (!known.includes(discord)) {
        lines.push(
          `outbox.discord: "${discord}" is not defined in config.yaml. Known channels: ${known.join(", ") || "(none)"}`,
        );
      } else {
        const varName = opts.config.discord.channels[discord]!;
        if (!env[varName]) {
          lines.push(
            `outbox.discord: channel "${discord}" maps to environment variable ${varName}, which is unset. Add it to .env`,
          );
        }
      }
    }

    if (lines.length > 0 || !agent) {
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
