import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "./errors.js";

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

const TimeOfDay = z.string().superRefine((v, ctx) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be a 24-hour time such as "22:00"; received ${JSON.stringify(v)}`,
    });
  }
});

const IanaTimezone = z.string().superRefine((v, ctx) => {
  if (!isValidTimeZone(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be a canonical IANA zone name such as "Europe/Berlin" (or "UTC"); received ${JSON.stringify(v)}. Offsets ("+02:00") and abbreviations ("CEST", "PST") are rejected because they do not carry daylight-saving rules`,
    });
  }
});

export const QuietHoursSchema = z
  .object({
    from: TimeOfDay,
    to: TimeOfDay,
    timezone: IanaTimezone,
  })
  .strict();

export const DigestSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Daily at 08:00 by default — croner's standard 5-field cron syntax, same as an agent's own `trigger.schedule`.
    schedule: z.string().default("0 8 * * *"),
    timezone: IanaTimezone.default("UTC"),
    // A key into discord.channels/discord.botChannels, same as an agent's outbox.discord.
    channel: z.string().default("smoke"),
  })
  .strict();

export const RetentionSchema = z
  .object({
    enabled: z.boolean().default(true),
    days: z.number().int().positive().default(30),
    // Weekly, Sunday 04:00 by default — this is bulk deletion, not routine reporting; no need for daily.
    schedule: z.string().default("0 4 * * 0"),
    timezone: IanaTimezone.default("UTC"),
    channel: z.string().default("smoke"),
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
      .object({
        channels: z.record(z.string(), z.string()).default({}),
        botChannels: z.record(z.string(), z.string()).default({}).prefault({}),
      })
      .strict()
      .prefault({}),
    digest: DigestSchema.prefault({}),
    retention: RetentionSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type GovernorConfig = z.infer<typeof GovernorSchema>;
export type QuietHours = z.infer<typeof QuietHoursSchema>;
export type DigestConfig = z.infer<typeof DigestSchema>;
export type RetentionConfig = z.infer<typeof RetentionSchema>;

export function parseConfig(source: string, yamlText: string): Config {
  const result = ConfigSchema.safeParse(parseYaml(yamlText) ?? {});
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A fresh deploy that forgets to mount config.yaml hits this first. Left
    // unwrapped it surfaces as a raw ENOENT, bypassing the formatted boot
    // failure every other configuration problem gets.
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "the file does not exist"
        : `it could not be read (${code ?? (error as Error).message})`;
    throw new ValidationError(path, [
      `${reason}. Create it at that path (the config.yaml in the repository root is a working example), or mount it there in the container`,
    ]);
  }
  return parseConfig(path, text);
}
