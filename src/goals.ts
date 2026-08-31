import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "./errors.js";

const GoalsSchema = z
  .object({
    primary: z.object({ id: z.string().min(1), statement: z.string().min(1) }).strict(),
    secondary: z
      .object({ id: z.string().min(1), instrumental: z.literal(true), statement: z.string().min(1) })
      .strict(),
    means: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Goals = z.infer<typeof GoalsSchema>;

export function parseGoals(source: string, yamlText: string): Goals {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (error) {
    throw new ValidationError(source, [`is not valid YAML: ${(error as Error).message}`]);
  }

  const result = GoalsSchema.safeParse(raw);
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

/**
 * Returns null when the file does not exist yet. Unlike config.yaml,
 * goals.yaml is legitimately absent until the operator completes the
 * one-time bootstrap step in docs/superpowers/specs/2026-08-30-self-evaluation-design.md
 * ("Operator bootstrap: Write goals.yaml"). A file that exists but is
 * malformed still throws — only genuine absence is a valid, quiet state.
 */
export function loadGoals(path: string): Goals | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ValidationError(path, [
      `it could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`,
    ]);
  }
  return parseGoals(path, text);
}
