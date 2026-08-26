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
