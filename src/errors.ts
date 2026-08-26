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
