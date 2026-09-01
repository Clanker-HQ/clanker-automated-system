import { describe, expect, it } from "vitest";
import { parseDeploys } from "../src/deploy/deploys-schema.js";

const OPTS = { maxLiveDeployments: 5, availableProductEnv: new Set<string>() };

function yaml(body: string): string {
  return `deployments:\n${body}`;
}

const ONE = `  - slug: status-page
    repo: Clanker-HQ/clanker-status-page
    hostname: status.203-0-113-5.sslip.io
    port: 8080
`;

describe("parseDeploys", () => {
  it("parses a well-formed entry and defaults env to empty", () => {
    const result = parseDeploys("deploys.yaml", yaml(ONE), OPTS);
    expect(result).toEqual([
      {
        slug: "status-page",
        repo: "Clanker-HQ/clanker-status-page",
        hostname: "status.203-0-113-5.sslip.io",
        port: 8080,
        env: [],
      },
    ]);
  });

  it("reads a missing deployments key as nothing deployed", () => {
    expect(parseDeploys("deploys.yaml", "", OPTS)).toEqual([]);
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(() => parseDeploys("deploys.yaml", yaml(ONE + "    replicas: 3\n"), OPTS)).toThrow(/replicas/);
  });

  it("rejects a hostname carrying a scheme, port or path", () => {
    for (const bad of ["https://status.example.com", "status.example.com:8080", "status.example.com/health"]) {
      expect(() => parseDeploys("deploys.yaml", yaml(ONE.replace("status.203-0-113-5.sslip.io", bad)), OPTS)).toThrow(/bare hostname/);
    }
  });

  it("rejects a repo that is not owner/name", () => {
    expect(() => parseDeploys("deploys.yaml", yaml(ONE.replace("Clanker-HQ/clanker-status-page", "clanker-status-page")), OPTS)).toThrow(/owner\/name/);
  });

  it("rejects duplicate slugs", () => {
    expect(() => parseDeploys("deploys.yaml", yaml(ONE + ONE.replace("status.203", "other.203")), OPTS)).toThrow(/duplicate slug/);
  });

  it("rejects two entries sharing one hostname", () => {
    expect(() => parseDeploys("deploys.yaml", yaml(ONE + ONE.replace("status-page", "other-page")), OPTS)).toThrow(/duplicate hostname/);
  });

  it("rejects more entries than maxLiveDeployments", () => {
    const three = [0, 1, 2].map((i) => ONE.replace("status-page", `p${i}`).replace("status.203", `p${i}.203`)).join("");
    expect(() => parseDeploys("deploys.yaml", yaml(three), { ...OPTS, maxLiveDeployments: 2 })).toThrow(/maxLiveDeployments/);
  });

  it("rejects an env name the host does not provide", () => {
    const withEnv = ONE + "    env: [OPENAI_API_KEY]\n";
    expect(() => parseDeploys("deploys.yaml", yaml(withEnv), OPTS)).toThrow(/OPENAI_API_KEY/);
  });

  it("accepts an env name the host does provide", () => {
    const withEnv = ONE + "    env: [OPENAI_API_KEY]\n";
    const opts = { maxLiveDeployments: 5, availableProductEnv: new Set(["OPENAI_API_KEY"]) };
    expect(parseDeploys("deploys.yaml", yaml(withEnv), opts)[0]!.env).toEqual(["OPENAI_API_KEY"]);
  });

  it("reports every problem at once rather than the first", () => {
    const two = ONE + ONE;
    try {
      parseDeploys("deploys.yaml", yaml(two), { ...OPTS, maxLiveDeployments: 1 });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/duplicate slug/);
      expect(message).toMatch(/maxLiveDeployments/);
    }
  });

  it("wraps invalid YAML rather than letting the parser error escape", () => {
    expect(() => parseDeploys("deploys.yaml", "deployments: [oh: no", OPTS)).toThrow(/not valid YAML/);
  });
});
