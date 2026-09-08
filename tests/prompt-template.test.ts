import { describe, expect, it } from "vitest";
import { renderPrompt, unknownPlaceholders } from "../src/prompt-template.js";

const REPO_ROOT = "C:\\Users\\someone\\claude-agent-infrastructure";

describe("renderPrompt", () => {
  it("substitutes {{repoRoot}} with the supervisor's actual repo root", () => {
    expect(renderPrompt("Read {{repoRoot}}/README.md", { repoRoot: REPO_ROOT })).toBe(
      `Read ${REPO_ROOT}/README.md`,
    );
  });

  it("substitutes every occurrence, not just the first", () => {
    const rendered = renderPrompt("{{repoRoot}}/src and {{repoRoot}}/tests", { repoRoot: "/root" });
    expect(rendered).toBe("/root/src and /root/tests");
  });

  it("leaves a prompt with no placeholder byte-for-byte unchanged", () => {
    // The guard that write-capable agents (builder, repair) never learn the
    // path of the supervisor's own checkout: they don't use the placeholder,
    // so nothing is appended to their prompt.
    const plain = "Clone the repo into your workspace and work there.";
    expect(renderPrompt(plain, { repoRoot: REPO_ROOT })).toBe(plain);
  });

  it("treats a $ in the repo root as a literal, not a replacement pattern", () => {
    // String.replaceAll expands $&, $', $` and $1 inside the REPLACEMENT.
    // A path is data, so any such sequence must survive verbatim.
    const rooted = renderPrompt("at {{repoRoot}}", { repoRoot: "/srv/$&/x" });
    expect(rooted).toBe("at /srv/$&/x");
  });
});

describe("unknownPlaceholders", () => {
  it("reports a placeholder nothing will ever substitute", () => {
    expect(unknownPlaceholders("Read {{appRoot}}/README.md")).toEqual(["appRoot"]);
  });

  it("accepts the placeholders renderPrompt actually knows about", () => {
    expect(unknownPlaceholders("Read {{repoRoot}}/README.md")).toEqual([]);
  });

  it("reports each unknown name once, however often it appears", () => {
    expect(unknownPlaceholders("{{nope}} and {{nope}} and {{alsoNope}}")).toEqual([
      "nope",
      "alsoNope",
    ]);
  });

  it("ignores prose that merely contains braces", () => {
    expect(unknownPlaceholders("Use `interface {}` and JSON like { \"a\": 1 }")).toEqual([]);
  });
});
