import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { loadGoals, parseGoals } from "../src/goals.js";

const VALID = `
primary:
  id: revenue
  statement: Generate real, recurring income for the operator.

secondary:
  id: capability
  instrumental: true
  statement: Improve this system's own capability, reliability and reach.

means:
  - Legal in the operator's jurisdiction and in any market touched.
  - No violation of any service's terms of service.
`;

describe("parseGoals", () => {
  it("parses a valid goals document", () => {
    const goals = parseGoals("goals.yaml", VALID);
    expect(goals.primary).toEqual({ id: "revenue", statement: "Generate real, recurring income for the operator." });
    expect(goals.secondary.instrumental).toBe(true);
    expect(goals.means).toHaveLength(2);
  });

  it("rejects invalid YAML syntax", () => {
    expect(() => parseGoals("goals.yaml", "primary: [")).toThrow(ValidationError);
  });

  it("rejects a document missing primary", () => {
    const yaml = VALID.replace(/primary:[\s\S]*?statement: Generate real, recurring income for the operator\.\n\n/, "");
    expect(() => parseGoals("goals.yaml", yaml)).toThrow(ValidationError);
  });

  it("rejects secondary.instrumental: false", () => {
    const yaml = VALID.replace("instrumental: true", "instrumental: false");
    expect(() => parseGoals("goals.yaml", yaml)).toThrow(ValidationError);
  });

  it("rejects an empty means list", () => {
    const yaml = VALID.replace(/means:[\s\S]*/, "means: []\n");
    expect(() => parseGoals("goals.yaml", yaml)).toThrow(ValidationError);
  });

  it("rejects an unrecognised top-level key, naming it", () => {
    const yaml = VALID + "\nextra: field\n";
    try {
      parseGoals("goals.yaml", yaml);
      expect.fail("expected parseGoals to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).lines.join(" ")).toMatch(/extra/);
    }
  });
});

describe("loadGoals", () => {
  const dir = mkdtempSync(join(tmpdir(), "cai-goals-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    expect(loadGoals(join(dir, "does-not-exist.yaml"))).toBeNull();
  });

  it("returns the parsed goals when the file exists and is valid", () => {
    const path = join(dir, "present.yaml");
    writeFileSync(path, VALID);
    expect(loadGoals(path)?.primary.id).toBe("revenue");
  });

  it("throws (does not silently return null) when the file exists but is malformed", () => {
    const path = join(dir, "malformed.yaml");
    writeFileSync(path, "primary: [\n");
    expect(() => loadGoals(path)).toThrow(ValidationError);
  });
});
