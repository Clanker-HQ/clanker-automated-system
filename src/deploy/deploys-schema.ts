import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "../errors.js";

/**
 * A bare hostname: no scheme, no port, no path. Caddy gets one site block per
 * hostname and the host probes `https://<hostname>/`, so anything else would
 * produce a malformed site block or a malformed probe URL rather than an error
 * anyone could read. Design §4.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The same charset `AgentSchema` enforces on an agent name, for the same
 * reason it does: a slug becomes a container name, a directory name on the
 * host, and a Caddy site block, so `.`, `..` and `/` must never be in one.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const DeploymentSchema = z
  .object({
    slug: z.string().regex(SLUG_RE, "must be lowercase letters, digits and hyphens, starting with a letter or digit"),
    repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be "owner/name"'),
    hostname: z.string().regex(HOSTNAME_RE, "must be a bare hostname — no scheme, no port, no path"),
    port: z.number().int().min(1).max(65535),
    /**
     * Names only. The values live in the host's product environment file and
     * never enter this container, so no agent can read a product's key even by
     * accident. A deployment may not introduce a name — that is D1b. Design §7.
     */
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE variable name")).default([]),
  })
  .strict();

export type Deployment = z.infer<typeof DeploymentSchema>;

const DeploysFileSchema = z.object({ deployments: z.array(DeploymentSchema).default([]) }).strict();

export interface DeploysCheckOptions {
  maxLiveDeployments: number;
  /** Names `config.yaml` declares the host provides. Design §3.1 explains why this is checked here and not in the self-build gate. */
  availableProductEnv: ReadonlySet<string>;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function parseFile(source: string, yamlText: string): Deployment[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (error) {
    throw new ValidationError(source, [`is not valid YAML: ${(error as Error).message}`]);
  }
  const result = DeploysFileSchema.safeParse(raw);
  if (!result.success) throw formatZodError(source, result.error);
  return result.data.deployments;
}

/** Checks needing nothing but the file itself. */
function shapeProblems(deployments: Deployment[]): string[] {
  const problems: string[] = [];

  const dupSlugs = duplicates(deployments.map((d) => d.slug));
  if (dupSlugs.length > 0) {
    problems.push(`duplicate slug(s): ${dupSlugs.join(", ")}. Every deployment needs a unique slug`);
  }

  const dupHostnames = duplicates(deployments.map((d) => d.hostname));
  if (dupHostnames.length > 0) {
    problems.push(`duplicate hostname(s): ${dupHostnames.join(", ")}. Two deployments cannot share one hostname`);
  }

  return problems;
}

/** Checks needing config.yaml — the two the self-build gate structurally cannot make. */
function configProblems(deployments: Deployment[], opts: DeploysCheckOptions): string[] {
  const problems: string[] = [];

  if (deployments.length > opts.maxLiveDeployments) {
    problems.push(
      `${deployments.length} deployments exceeds deploy.maxLiveDeployments (${opts.maxLiveDeployments}) — ` +
        `remove an entry, or raise the cap in config.yaml if the host really has the memory`,
    );
  }

  for (const d of deployments) {
    const missing = d.env.filter((name) => !opts.availableProductEnv.has(name));
    if (missing.length > 0) {
      problems.push(
        `deployment "${d.slug}" names environment variable(s) the host does not provide: ${missing.join(", ")}. ` +
          `A deployment may not introduce a credential; add the name to config.yaml's deploy.availableProductEnv first`,
      );
    }
  }

  return problems;
}

/**
 * Schema, duplicate slugs and duplicate hostnames — every check that needs
 * nothing but the file itself.
 *
 * Split out from `parseDeploys` because `evaluateSelfBuildChange` is a pure
 * function that is deliberately never given `config.yaml`, so this is exactly
 * the set of checks it can honestly make. Design §3.1 explains where the other
 * two run instead.
 */
export function parseDeploysShape(source: string, yamlText: string): Deployment[] {
  const deployments = parseFile(source, yamlText);
  const problems = shapeProblems(deployments);
  if (problems.length > 0) throw new ValidationError(source, problems);
  return deployments;
}

/**
 * Everything `parseDeploysShape` checks, plus the entry cap and the env
 * allowlist from `config.yaml`.
 *
 * Every problem is collected before throwing rather than reported one at a
 * time: this runs in CI against an agent-authored file, and an agent that has
 * to round-trip a PR per problem burns a run per problem.
 */
export function parseDeploys(source: string, yamlText: string, opts: DeploysCheckOptions): Deployment[] {
  const deployments = parseFile(source, yamlText);
  const problems = [...shapeProblems(deployments), ...configProblems(deployments, opts)];
  if (problems.length > 0) throw new ValidationError(source, problems);
  return deployments;
}

/**
 * A missing file reads as nothing deployed rather than throwing — the file is
 * agent-written, and a fresh clone legitimately has none. Same posture as
 * `WorldModel.readPortfolio` and `MetricsStore.listAll`.
 */
export function loadDeploys(path: string, opts: DeploysCheckOptions): Deployment[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseDeploys(path, text, opts);
}
