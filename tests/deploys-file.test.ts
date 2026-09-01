import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadDeploys } from "../src/deploy/deploys-schema.js";

const ROOT = join(import.meta.dirname, "..");

describe("the repo's committed deploys.yaml", () => {
  it("validates against the repo's committed config.yaml", () => {
    const config = loadConfig(join(ROOT, "config.yaml"));
    expect(() =>
      loadDeploys(join(ROOT, "deploys.yaml"), {
        maxLiveDeployments: config.deploy.maxLiveDeployments,
        availableProductEnv: new Set(config.deploy.availableProductEnv),
      }),
    ).not.toThrow();
  });
});
