import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGrants } from "../src/grants.js";
import { ValidationError } from "../src/errors.js";
import { parseAgent } from "../src/registry.js";

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

  it("parses a github-pr grant", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: [owner/repo]\n    secret: GITHUB_PR_TOKEN\n",
    );
    expect(grants[0]).toMatchObject({ kind: "github-pr", repos: ["owner/repo"] });
  });

  it("rejects a github-pr grant with an empty repos list", () => {
    const yaml = "grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: []\n    secret: GITHUB_PR_TOKEN\n";
    expect(() => parseGrants("grants.yaml", yaml)).toThrow();
  });

  it("parses a github-pr grant with a wildcard repos value", () => {
    const grants = parseGrants(
      "grants.yaml",
      'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: "*"\n    secret: GITHUB_PR_TOKEN\n',
    );
    expect(grants[0]).toMatchObject({ kind: "github-pr", repos: "*" });
  });

  it("rejects a github-pr grant whose repos is a non-wildcard string", () => {
    const yaml = 'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: "owner/repo"\n    secret: GITHUB_PR_TOKEN\n';
    expect(() => parseGrants("grants.yaml", yaml)).toThrow();
  });
});

import { decide, detectOutwardEffect, matchGrant, validateGrantRefs } from "../src/grants.js";

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
      kind: "git-push",
      description: "git push (git push github.com/me/site main)",
      target: "github.com/me/site",
    });
  });

  // Bare `git push` — pushing to the configured upstream — is the commonest
  // real-world form, and it used to match nothing at all: no captured
  // argument meant no detected effect, at every tier.
  it("recognises a bare `git push` with no remote argument, with a sentinel target", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push" });
    expect(effect).not.toBeNull();
    expect(effect!.kind).toBe("git-push");
    expect(effect!.target).toBeTruthy();
    expect(effect!.target.length).toBeGreaterThan(0);
  });

  it("denies a bare `git push` for a granted agent, because no grant can match the sentinel", () => {
    const result = decide(agent("granted", ["push-site"]), [PUSH_SITE], "Bash", { command: "git push" });
    expect(result.kind).toBe("deny");
  });

  it("does not flag a local git commit", () => {
    expect(detectOutwardEffect("Bash", { command: "git commit -m wip" })).toBeNull();
  });

  it("recognises curl to a non-local host but not to localhost", () => {
    expect(detectOutwardEffect("Bash", { command: "curl https://httpbin.org/post" })).not.toBeNull();
    expect(detectOutwardEffect("Bash", { command: "curl http://localhost:3000" })).toBeNull();
  });

  // The localhost exemption used to scan the WHOLE command string, so the
  // mere substring "localhost" anywhere in it — a query parameter, a header —
  // made a call to a real external host read as safe at every tier.
  it("does not exempt a call to a real host that merely mentions localhost elsewhere in the command", () => {
    const query = detectOutwardEffect("Bash", { command: "curl https://evil.example.com/?ref=localhost" });
    expect(query).not.toBeNull();
    expect(query!.kind).toBe("http");
    expect(query!.target).toBe("https://evil.example.com/?ref=localhost");

    const header = detectOutwardEffect("Bash", { command: 'curl -H "Origin: localhost" https://evil.example.com' });
    expect(header).not.toBeNull();
    expect(header!.target).toBe("https://evil.example.com");

    const loopbackish = detectOutwardEffect("Bash", { command: "curl https://127.0.0.1.evil.example.com/x" });
    expect(loopbackish).not.toBeNull();
  });

  it("still exempts genuinely local curls", () => {
    expect(detectOutwardEffect("Bash", { command: "curl http://localhost:3000/anything" })).toBeNull();
    expect(detectOutwardEffect("Bash", { command: "curl http://127.0.0.1:8080" })).toBeNull();
    expect(detectOutwardEffect("Bash", { command: "curl http://[::1]:8080/health" })).toBeNull();
    expect(detectOutwardEffect("Bash", { command: "wget http://localhost:9000/file" })).toBeNull();
  });

  it("fails closed when curl carries no parseable URL at all", () => {
    const effect = detectOutwardEffect("Bash", { command: "curl $TARGET_URL" });
    expect(effect).not.toBeNull();
    expect(effect!.kind).toBe("http");
  });

  it("treats a curl to several hosts as outward if any one of them is not local", () => {
    const effect = detectOutwardEffect("Bash", { command: "curl http://localhost:3000 https://evil.example.com" });
    expect(effect).not.toBeNull();
    expect(effect!.target).toBe("https://evil.example.com");
  });

  it("recognises WebFetch as always an outward effect, keyed by its url", () => {
    expect(detectOutwardEffect("WebFetch", { url: "https://httpbin.org/post" })).toEqual({
      kind: "http",
      description: "fetch https://httpbin.org/post",
      target: "https://httpbin.org/post",
    });
  });

  it("classifies npm publish and gh create as provision effects", () => {
    expect(detectOutwardEffect("Bash", { command: "npm publish" })!.kind).toBe("provision");
    expect(detectOutwardEffect("Bash", { command: "gh repo create me/thing" })!.kind).toBe("provision");
  });

  it("returns null for a tool with no outward-effect pattern, like Read", () => {
    expect(detectOutwardEffect("Read", { file_path: "notes.md" })).toBeNull();
  });
});

describe("matchGrant", () => {
  it("matches a wildcard github-pr grant against any repo", () => {
    const wildcard = parseGrants(
      "grants.yaml",
      'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: "*"\n    secret: X\n',
    )[0]!;
    const effect = detectOutwardEffect("mergePR", { repo: "owner/some-new-repo" })!;
    expect(effect.kind).toBe("github-pr");
    expect(matchGrant([wildcard], effect)).toBe(wildcard);
  });

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

  // Target equality is not authority: the pair (kind, target) is. A git-push
  // grant whose remote happens to be written as a URL must not authorise an
  // HTTP call to that URL, and vice versa.
  it("does not let a git-push grant authorise an http effect with the same target string", () => {
    const pushByUrl = parseGrants(
      "grants.yaml",
      'grants:\n  - id: push-url\n    kind: git-push\n    remote: "https://httpbin.org/post"\n    branches: [main]\n    secret: X\n',
    )[0]!;
    const httpEffect = detectOutwardEffect("WebFetch", { url: "https://httpbin.org/post" })!;
    expect(httpEffect.kind).toBe("http");
    expect(matchGrant([pushByUrl], httpEffect)).toBeNull();
  });

  it("does not let an http grant authorise a git-push effect with the same target string", () => {
    const httpToRemote = parseGrants(
      "grants.yaml",
      'grants:\n  - id: http-remote\n    kind: http\n    method: POST\n    urlPattern: "github.com/me/site"\n    secret: X\n',
    )[0]!;
    const pushEffect = detectOutwardEffect("Bash", { command: "git push github.com/me/site main" })!;
    expect(pushEffect.kind).toBe("git-push");
    expect(matchGrant([httpToRemote], pushEffect)).toBeNull();
    // ...and the right-kind grant still matches, so the check isn't blanket-denying.
    expect(matchGrant([PUSH_SITE], pushEffect)).toBe(PUSH_SITE);
  });

  it("does not let a provision grant authorise an http effect with a matching scope", () => {
    const provision = parseGrants(
      "grants.yaml",
      'grants:\n  - id: new-repo\n    kind: provision\n    resource: github-repo\n    scope: "https://httpbin.org/post"\n    limit: { perDay: 3 }\n    secret: X\n',
    )[0]!;
    const httpEffect = detectOutwardEffect("WebFetch", { url: "https://httpbin.org/post" })!;
    expect(matchGrant([provision], httpEffect)).toBeNull();
  });
});

describe("validateGrantRefs", () => {
  it("accepts refs that name a real grant", () => {
    expect(() =>
      validateGrantRefs([{ name: "smoke", grantRefs: ["test-echo"] }], [TEST_ECHO]),
    ).not.toThrow();
  });

  it("accepts an agent with no grantRefs at all", () => {
    expect(() => validateGrantRefs([{ name: "smoke", grantRefs: [] }], [])).not.toThrow();
  });

  // A typo boots cleanly today and then silently denies every effect the agent
  // was configured to be allowed, because decide() cannot tell "no grant" from
  // "a grant whose name was mistyped".
  it("rejects an unknown ref, naming the agent, the ref, and the known ids", () => {
    expect(() =>
      validateGrantRefs([{ name: "smoke", grantRefs: ["test-eco"] }], [TEST_ECHO]),
    ).toThrow(ValidationError);

    try {
      validateGrantRefs([{ name: "smoke", grantRefs: ["test-eco"] }], [TEST_ECHO]);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("smoke");
      expect(message).toContain("test-eco");
      expect(message).toContain("test-echo");
    }
  });

  it("reports every unknown ref across every agent at once", () => {
    try {
      validateGrantRefs(
        [
          { name: "a", grantRefs: ["nope-1"] },
          { name: "b", grantRefs: ["test-echo", "nope-2"] },
        ],
        [TEST_ECHO],
      );
      throw new Error("expected a ValidationError");
    } catch (e) {
      expect((e as ValidationError).lines).toHaveLength(2);
      expect((e as Error).message).toContain("nope-1");
      expect((e as Error).message).toContain("nope-2");
    }
  });

  it("says '(none)' rather than an empty list when grants.yaml has no grants", () => {
    try {
      validateGrantRefs([{ name: "smoke", grantRefs: ["anything"] }], []);
      throw new Error("expected a ValidationError");
    } catch (e) {
      expect((e as Error).message).toContain("(none)");
    }
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

/**
 * These run decide() against the REAL shipped agent definition and grants file,
 * not a hand-built fixture. The whole point: `tier: granted` + `approval: auto`
 * reads like it auto-allows and does not — it parks — and every dispatcher/bot
 * test uses a fake orchestrator that never reaches canUseTool, so nothing else
 * in this suite would notice the agent parking on its first WebFetch of every run.
 */
describe("the shipped research agent's tier and grant, checked against decide()", () => {
  const agent = parseAgent("agents/research/agent.yaml", readFileSync("agents/research/agent.yaml", "utf8"));
  const grants = parseGrants("grants.yaml", readFileSync("grants.yaml", "utf8"));

  it("auto-allows a WebFetch of an arbitrary public page, without parking for a human", () => {
    expect(decide(agent, grants, "WebFetch", { url: "https://example.com/some/article" })).toEqual({ kind: "allow" });
  });

  it("still denies an effect outside its granted family, e.g. a git push", () => {
    const result = decide(agent, grants, "Bash", { command: "git push origin main" });
    expect(result.kind).toBe("deny");
  });

  it("has no Read tool: local file access plus a urlPattern:'*' fetch grant would be an exfiltration path", () => {
    expect(agent.permissions.allowedTools).not.toContain("Read");
  });
});
