import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError, combineValidationErrors, formatZodError } from "../src/errors.js";

describe("ValidationError", () => {
  it("names its source and lists every line, prefixed and indented", () => {
    const error = new ValidationError("grants.yaml", ["missing field: tier", "bad shape: agents"]);
    expect(error.name).toBe("ValidationError");
    expect(error.source).toBe("grants.yaml");
    expect(error.lines).toEqual(["missing field: tier", "bad shape: agents"]);
    expect(error.message).toBe(
      "grants.yaml is not valid:\n  - missing field: tier\n  - bad shape: agents",
    );
  });

  it("is a real Error instance", () => {
    expect(new ValidationError("x", []) instanceof Error).toBe(true);
  });
});

describe("combineValidationErrors", () => {
  it("merges multiple errors' lines under a single combined source, each prefixed by its own source", () => {
    const a = new ValidationError("agents/foo.yaml", ["missing: name"]);
    const b = new ValidationError("agents/bar.yaml", ["missing: description", "bad: tier"]);

    const combined = combineValidationErrors("agents", [a, b]);

    expect(combined.source).toBe("agents");
    expect(combined.lines).toEqual([
      "agents/foo.yaml: missing: name",
      "agents/bar.yaml: missing: description",
      "agents/bar.yaml: bad: tier",
    ]);
  });

  it("produces an empty-lines error when given no errors to combine", () => {
    const combined = combineValidationErrors("nothing", []);
    expect(combined.lines).toEqual([]);
  });
});

describe("formatZodError", () => {
  it("formats a missing required field with its dotted path", () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);

    const error = formatZodError("config.yaml", result.error!);
    expect(error.source).toBe("config.yaml");
    expect(error.lines).toHaveLength(1);
    expect(error.lines[0]).toMatch(/^name: /);
  });

  it("uses (root) for an issue with no path", () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);

    const error = formatZodError("value", result.error!);
    expect(error.lines[0]).toMatch(/^\(root\): /);
  });

  it("appends legal values for an invalid enum", () => {
    const schema = z.object({ tier: z.enum(["low", "medium", "high"]) });
    const result = schema.safeParse({ tier: "extreme" });
    expect(result.success).toBe(false);

    const error = formatZodError("agent.yaml", result.error!);
    expect(error.lines[0]).toContain("tier:");
    expect(error.lines[0]).toContain("Legal values:");
    expect(error.lines[0]).toContain('"low"');
    expect(error.lines[0]).toContain('"medium"');
    expect(error.lines[0]).toContain('"high"');
  });

  it("appends the unrecognised key(s) hint for a strict-object violation", () => {
    const schema = z.strictObject({ name: z.string() });
    const result = schema.safeParse({ name: "x", extra: "y" });
    expect(result.success).toBe(false);

    const error = formatZodError("agent.yaml", result.error!);
    expect(error.lines[0]).toContain("Unrecognised key(s): extra");
  });

  it("joins the dotted path for a nested field", () => {
    const schema = z.object({ agent: z.object({ tier: z.string() }) });
    const result = schema.safeParse({ agent: { tier: 5 } });
    expect(result.success).toBe(false);

    const error = formatZodError("agent.yaml", result.error!);
    expect(error.lines[0]).toMatch(/^agent\.tier: /);
  });

  it("emits one line per issue when several fields fail at once", () => {
    const schema = z.object({ name: z.string(), tier: z.enum(["low", "high"]) });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);

    const error = formatZodError("agent.yaml", result.error!);
    expect(error.lines).toHaveLength(2);
  });
});
