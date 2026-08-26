import { describe, expect, it } from "vitest";
import { parseGrants } from "../src/grants.js";
import { ValidationError } from "../src/errors.js";

const VALID = `
grants:
  - id: test-echo
    kind: http
    method: POST
    urlPattern: "https://httpbin.org/post"
    secret: TEST_ECHO_TOKEN
`;

describe("parseGrants", () => {
  it("parses a valid http grant", () => {
    const grants = parseGrants("grants.yaml", VALID);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toEqual({
      id: "test-echo", kind: "http", method: "POST",
      urlPattern: "https://httpbin.org/post", secret: "TEST_ECHO_TOKEN",
    });
  });

  it("parses a git-push grant", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: push-site\n    kind: git-push\n    remote: github.com/me/site\n    branches: [main]\n    secret: GH_TOKEN\n",
    );
    expect(grants[0]).toMatchObject({ kind: "git-push", remote: "github.com/me/site", branches: ["main"] });
  });

  it("parses a provision grant", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: new-repo\n    kind: provision\n    resource: github-repo\n    scope: github.com/me\n    limit: { perDay: 3 }\n    secret: GH_TOKEN\n",
    );
    expect(grants[0]).toMatchObject({ kind: "provision", resource: "github-repo", limit: { perDay: 3 } });
  });

  it("defaults to an empty list when the grants key is absent", () => {
    expect(parseGrants("grants.yaml", "")).toEqual([]);
  });

  it("rejects an unknown kind, naming the legal values", () => {
    const yaml = VALID.replace("kind: http", "kind: ftp");
    expect(() => parseGrants("grants.yaml", yaml)).toThrow(ValidationError);
    try {
      parseGrants("grants.yaml", yaml);
    } catch (e) {
      expect((e as Error).message).toContain("Legal values");
    }
  });

  it("rejects two grants sharing an id", () => {
    const yaml = `
grants:
  - id: test-echo
    kind: http
    method: POST
    urlPattern: "https://httpbin.org/post"
    secret: TEST_ECHO_TOKEN
  - id: test-echo
    kind: http
    method: POST
    urlPattern: "https://example.com/other"
    secret: OTHER_TOKEN
`;
    expect(() => parseGrants("grants.yaml", yaml)).toThrow(/duplicate/i);
  });

  it("rejects a grant missing a field its kind requires", () => {
    const yaml = "grants:\n  - id: bad\n    kind: http\n    method: POST\n    secret: X\n";
    expect(() => parseGrants("grants.yaml", yaml)).toThrow(/urlPattern/);
  });
});

import { decide, detectOutwardEffect, matchGrant } from "../src/grants.js";

const TEST_ECHO = parseGrants(
  "grants.yaml",
  'grants:\n  - id: test-echo\n    kind: http\n    method: POST\n    urlPattern: "https://httpbin.org/post"\n    secret: X\n',
)[0]!;

const PUSH_SITE = parseGrants(
  "grants.yaml",
  "grants:\n  - id: push-site\n    kind: git-push\n    remote: \"github.com/me/site\"\n    branches: [main]\n    secret: X\n",
)[0]!;

describe("detectOutwardEffect", () => {
  it("recognises git push inside a Bash command", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/me/site main" });
    expect(effect).toEqual({
      description: "git push (git push github.com/me/site main)",
      target: "github.com/me/site",
    });
  });

  it("does not flag a local git commit", () => {
    expect(detectOutwardEffect("Bash", { command: "git commit -m wip" })).toBeNull();
  });

  it("recognises curl to a non-local host but not to localhost", () => {
    expect(detectOutwardEffect("Bash", { command: "curl https://httpbin.org/post" })).not.toBeNull();
    expect(detectOutwardEffect("Bash", { command: "curl http://localhost:3000" })).toBeNull();
  });

  it("recognises WebFetch as always an outward effect, keyed by its url", () => {
    expect(detectOutwardEffect("WebFetch", { url: "https://httpbin.org/post" })).toEqual({
      description: "fetch https://httpbin.org/post",
      target: "https://httpbin.org/post",
    });
  });

  it("returns null for a tool with no outward-effect pattern, like Read", () => {
    expect(detectOutwardEffect("Read", { file_path: "notes.md" })).toBeNull();
  });
});

describe("matchGrant", () => {
  it("matches a git-push grant by remote, ignoring branch detail in the target", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/me/site main" })!;
    expect(matchGrant([PUSH_SITE], effect)).toBe(PUSH_SITE);
  });

  it("returns null when no grant's target matches", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/someone-else/repo main" })!;
    expect(matchGrant([PUSH_SITE], effect)).toBeNull();
  });

  it("does not match a target that merely contains an exact-pattern grant's text as a substring", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/me/site-backdoor main" })!;
    expect(matchGrant([PUSH_SITE], effect)).toBeNull();
  });
});

function agent(tier: string, grantRefs: string[] = [], approval = "notify") {
  return { tier, grantRefs, approval } as never;
}

describe("decide", () => {
  it("allows a call with no outward effect regardless of tier", () => {
    expect(decide(agent("readonly"), [], "Read", { file_path: "x" })).toEqual({ kind: "allow" });
  });

  it("denies an outward effect from a readonly agent", () => {
    const result = decide(agent("readonly"), [], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result.kind).toBe("deny");
  });

  it("denies an outward effect from a sandboxed agent even with no grantRefs", () => {
    const result = decide(agent("sandboxed"), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result.kind).toBe("deny");
  });

  it("parks a granted agent's effect that matches one of its grantRefs", () => {
    const result = decide(agent("granted", ["test-echo"]), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result).toEqual({ kind: "park", grantRef: "test-echo", effect: "fetch https://httpbin.org/post" });
  });

  it("denies a granted agent's effect that matches no grantRef", () => {
    const result = decide(agent("granted", ["test-echo"]), [TEST_ECHO], "Bash", { command: "git push github.com/x/y main" });
    expect(result.kind).toBe("deny");
  });

  it("allows an autonomous agent's matching effect without parking", () => {
    const result = decide(agent("autonomous", ["test-echo"], "auto"), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result).toEqual({ kind: "allow" });
  });

  it("still parks an autonomous-tier agent whose approval mode isn't auto", () => {
    const result = decide(agent("autonomous", ["test-echo"], "notify"), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result.kind).toBe("park");
  });
});
