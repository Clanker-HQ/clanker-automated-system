import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCaddyfile, renderDeploymentsTsv, writeDeployArtifacts } from "../src/deploy/caddyfile.js";
import type { Deployment } from "../src/deploy/deploys-schema.js";

const A: Deployment = { slug: "status-page", repo: "Clanker-HQ/clanker-status-page", hostname: "status.example.com", port: 8080, env: [] };
const B: Deployment = { slug: "widget", repo: "AAS-Labs/widget", hostname: "widget.example.com", port: 3000, env: ["OPENAI_API_KEY"] };

describe("renderCaddyfile", () => {
  it("renders one site block per deployment, reverse-proxying to its container and port", () => {
    const text = renderCaddyfile([A, B]);
    expect(text).toContain("status.example.com {");
    expect(text).toContain("reverse_proxy status-page:8080");
    expect(text).toContain("widget.example.com {");
    expect(text).toContain("reverse_proxy widget:3000");
  });

  it("renders a valid file with no deployments rather than an empty one", () => {
    const text = renderCaddyfile([]);
    expect(text).toMatch(/^#/);
    expect(text).not.toContain("reverse_proxy");
  });

  it("is stable for the same input", () => {
    expect(renderCaddyfile([A, B])).toBe(renderCaddyfile([A, B]));
  });

  it("does not depend on entry order", () => {
    expect(renderCaddyfile([A, B])).toBe(renderCaddyfile([B, A]));
  });
});

describe("renderDeploymentsTsv", () => {
  it("emits one tab-separated line per deployment with no header", () => {
    expect(renderDeploymentsTsv([A])).toBe("status-page\tClanker-HQ/clanker-status-page\tstatus.example.com\t8080\t\n");
  });

  it("joins env names with commas so a line stays one record", () => {
    expect(renderDeploymentsTsv([B])).toContain("\tOPENAI_API_KEY\n");
  });

  it("emits nothing for no deployments", () => {
    expect(renderDeploymentsTsv([])).toBe("");
  });
});

describe("writeDeployArtifacts", () => {
  it("writes both files into the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caddy-"));
    await writeDeployArtifacts({ deployments: [A], dir });
    expect(await readFile(join(dir, "Caddyfile"), "utf8")).toContain("reverse_proxy status-page:8080");
    expect(await readFile(join(dir, "deployments.tsv"), "utf8")).toContain("status-page\t");
  });
});
