import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { Deployment } from "./deploys-schema.js";

const HEADER = [
  "# Generated from deploys.yaml by the supervisor at boot. Do not edit by hand:",
  "# the next boot overwrites it. Change deploys.yaml instead.",
  "#",
  "# One site block per deployment. Caddy obtains and renews a real Let's",
  "# Encrypt certificate per hostname on its own — see the deploy-path design §4.",
  "",
].join("\n");

/** Sorted by slug so the same desired state always renders byte-identically, which is what makes "did the routing change" a diff rather than a guess. */
function ordered(deployments: Deployment[]): Deployment[] {
  return [...deployments].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function renderCaddyfile(deployments: Deployment[]): string {
  const blocks = ordered(deployments).map((d) =>
    [
      `${d.hostname} {`,
      // The container is reachable by its service name on the compose network,
      // so the proxy target never needs an IP and survives a container restart.
      `\treverse_proxy ${d.slug}:${d.port}`,
      "}",
      "",
    ].join("\n"),
  );
  return HEADER + blocks.join("\n");
}

/**
 * The host's own view of the desired state, in a format bash can read with a
 * single `while IFS=$'\t' read` loop. Deliberately not YAML and deliberately
 * not JSON: scripts/deploy-products.sh must parse this with no interpreter and
 * no dependency, so the deploy path has one less thing that can break at 3am.
 */
export function renderDeploymentsTsv(deployments: Deployment[]): string {
  return ordered(deployments)
    .map((d) => `${d.slug}\t${d.repo}\t${d.hostname}\t${d.port}\t${d.env.join(",")}\n`)
    .join("");
}

export async function writeDeployArtifacts(opts: { deployments: Deployment[]; dir: string }): Promise<void> {
  await mkdir(opts.dir, { recursive: true });
  await writeFileAtomic(join(opts.dir, "Caddyfile"), renderCaddyfile(opts.deployments));
  await writeFileAtomic(join(opts.dir, "deployments.tsv"), renderDeploymentsTsv(opts.deployments));
}
