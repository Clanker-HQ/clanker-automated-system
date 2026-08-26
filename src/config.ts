import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodError } from "./errors.js";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour time such as "22:00"');

export const QuietHoursSchema = z
  .object({
    from: TimeOfDay,
    to: TimeOfDay,
    timezone: z.string().refine(isValidTimeZone, {
      message:
        'must be an IANA zone name such as "Europe/Berlin". Offsets ("+02:00") and abbreviations ("CEST") are rejected because they do not carry daylight-saving rules',
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
