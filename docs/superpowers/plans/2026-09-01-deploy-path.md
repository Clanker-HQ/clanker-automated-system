# Deploy Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merged repo becomes a running, publicly reachable service, and the system learns whether it stays up.

**Architecture:** Desired deploy state is a committed file (`deploys.yaml`), so putting something live is an ordinary pull request that inherits CI, `pr-reviewer`, `mergePR`'s gates and the excluded-path lock. The host script that already deploys this system every five minutes reads that file and deploys products too. The deploy gate is an external HTTP probe the host owns, never a product's own agent-authored `HEALTHCHECK`. A periodic prober writes liveness into `data/state/probes.json`, consumed by the overseer's prompt and the daily digest.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, croner, Vitest, Docker Compose, Caddy, bash.

**Spec:** [`docs/superpowers/specs/2026-09-01-deploy-path-design.md`](../specs/2026-09-01-deploy-path-design.md)

## Global Constraints

- **TDD, without exception.** Write the failing test, run it, watch it fail for the right reason, then implement. This is the project standard, not this plan's preference.
- **`npm run typecheck && npx vitest run` must pass before every commit.** Baseline entering this plan: **907 tests passing across 73 files.**
- **Relative imports end in `.js`**, even from `.ts` files. NodeNext resolution.
- **One task per session.** Each task self-merges into `autonomy-integration`. Never merge to `master`, never push, unless explicitly asked.
- **`EXCLUDED_PATHS` files are operator-editable, pipeline-forbidden.** This plan touches `src/index.ts`, `config.yaml`, `src/control/excluded-paths.ts`, `src/control/self-build-gate.ts` and `agents/builder/prompt.md`. An operator-directed session edits them normally; the autonomous self-build pipeline may not. **Never widen a grant, a budget, a concurrency limit or an exclusion while wiring.** Every exclusion change in this plan narrows.
- **`.env` is gitignored and must never be committed.** No task here adds a credential, and no product secret value ever enters the supervisor's container — only names, from `config.yaml`.
- **New directory `src/deploy/`.** Separate from `src/state/` (which is this system's own state) and from `src/world/` (which is agent-written). These files are machine-written and about services this system deploys.

---

## File Structure

```
Create:
  deploys.yaml                          desired state; agent-writable, schema-gated
  src/deploy/deploys-schema.ts          Zod schema, parseDeploys, loadDeploys
  src/deploy/caddyfile.ts               renderCaddyfile + renderDeploymentsTsv
  src/deploy/probe-store.ts             ProbeResult, ProbeStore over data/state/probes.json
  src/deploy/probe.ts                   UrlProbe, httpProbe, runProbePass
  src/deploy/probe-warnings.ts          pure; mirrors src/state/liveness.ts
  src/triggers/probe.ts                 startProbe cron trigger
  scripts/deploy-products.sh            host-side: clone, build, route, probe, roll back
  tests/deploys-schema.test.ts
  tests/deploys-file.test.ts            validates the repo's own committed deploys.yaml
  tests/caddyfile.test.ts
  tests/probe-store.test.ts
  tests/probe.test.ts
  tests/probe-warnings.test.ts
  tests/probe-trigger.test.ts

Modify:
  src/config.ts                         DeploySchema, ConfigSchema.deploy, DeployConfig
  config.yaml                           deploy.maxLiveDeployments, deploy.availableProductEnv
  src/control/self-build-gate.ts        deploys.yaml as a third admitted shape
  src/control/excluded-paths.ts         protect scripts/ and self-build-gate.ts
  src/triggers/overseer.ts              ## Product liveness in buildPromptContext
  src/digest.ts                         probeWarnings into the warning lines
  src/triggers/digest.ts                pass the probe store through
  src/index.ts                          boot: validate deploys.yaml, render caddy/, start the prober
  docker-compose.yml                    bind-mount ./caddy; add the caddy service
  scripts/auto-deploy.sh                call deploy-products.sh after its own deploy
  agents/builder/prompt.md              how to put something live; never a subscription token in a product
  docs/decisions.md                     record §7's resolution of the billing contradiction
  README.md                             the deploy path and the per-product domain step
  tests/self-build-gate.test.ts
  tests/digest.test.ts
  tests/overseer-trigger.test.ts
  tests/excluded-paths.test.ts
```

Five tasks. Task boundaries are drawn where a reviewer could reject one and approve its neighbour: the schema stands alone; the gate change is a separate trust decision; rendering is separate from probing; the producer and both its consumers are deliberately **one** task, because splitting them is precisely how this codebase produced five "computed by something, consumed by nothing" defects; the host scripts are the only bash and the only part not unit-testable.

---

### Task 1: `deploys.yaml`, its schema and its loader

**Why:** Everything downstream reads this file. It is agent-writable, so its schema is the primary algorithmic safety check — per the standing preference that safety lives in scoping and code-level checks rather than a human approval click.

**Files:**
- Create: `src/deploy/deploys-schema.ts`
- Create: `deploys.yaml`
- Create: `tests/deploys-schema.test.ts`, `tests/deploys-file.test.ts`
- Modify: `src/config.ts` (after `RevenueSchema`, ~line 218), `config.yaml`, `src/index.ts`

**Interfaces:**
- Consumes: `ValidationError` and `formatZodError` from `src/errors.js`; `parse as parseYaml` from `yaml`; `z` from `zod`. Mirror `src/grants.ts`'s `parseGrants(source, yamlText)` / `loadGrants(path)` pair exactly — same argument order, same `ValidationError` shape, `.strict()` schemas.
- Produces: `Deployment { slug, repo, hostname, port, env }`, `parseDeploysShape(source, yamlText)`, `parseDeploys(source, yamlText, opts)`, `loadDeploys(path, opts)`, `DeployConfig { maxLiveDeployments, availableProductEnv }`, and `config.deploy`. Task 2 calls `parseDeploysShape`; boot calls `loadDeploys`.

- [ ] **Step 1: Write the failing schema tests**

Create `tests/deploys-schema.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/deploys-schema.test.ts`
Expected: FAIL — cannot resolve `../src/deploy/deploys-schema.js`.

- [ ] **Step 3: Write the schema and loader**

Create `src/deploy/deploys-schema.ts`:

```ts
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
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/deploys-schema.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add `deploy` to the config schema**

In `src/config.ts`, after `RevenueSchema` (~line 218):

```ts
export const DeploySchema = z
  .object({
    /**
     * Products share the VPS with the supervisor, so this is a memory guard
     * rather than a policy: sized for the planned 8 GB host (design §8). A
     * file over the cap fails at boot and in CI instead of exhausting the box
     * at 3am.
     */
    maxLiveDeployments: z.number().int().min(0).default(5),
    /**
     * Environment variable NAMES a deployment may list in its `env`. The
     * values live only in the host's product environment file. This lives in
     * config.yaml — which is on EXCLUDED_PATHS — specifically so an agent
     * cannot extend it through the self-build pipeline.
     */
    availableProductEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  })
  .strict();
```

Add `deploy: DeploySchema.prefault({}),` to `ConfigSchema` and `export type DeployConfig = z.infer<typeof DeploySchema>;` beside the other type exports.

- [ ] **Step 6: Add the config block and the file itself**

In `config.yaml`:

```yaml
deploy:
  maxLiveDeployments: 5
  # Names only — values live in the host's product env file and never enter
  # the supervisor's container. Extending this list is an operator edit by
  # construction: config.yaml is on EXCLUDED_PATHS.
  availableProductEnv: []
```

Create `deploys.yaml`:

```yaml
# What should be running. An agent puts something live by opening a PR that
# adds an entry here; see docs/superpowers/specs/2026-09-01-deploy-path-design.md.
#
# slug      container and host directory name; lowercase, digits, hyphens
# repo      owner/name on GitHub
# hostname  bare hostname Caddy will serve and the host will probe over HTTPS
# port      the port the container listens on inside the container
# env       variable NAMES the container needs; must already be listed in
#           config.yaml's deploy.availableProductEnv
#
# Products get a real domain. The free <name>.<ip-with-dashes>.sslip.io form is
# for this system's own services only — see design §4.
deployments: []
```

- [ ] **Step 7: Make CI validate the committed file**

Create `tests/deploys-file.test.ts`. This is the check that makes a bad entry a CI failure rather than a 3am rollback — see design §3.1.

```ts
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
```

- [ ] **Step 8: Validate at boot**

In `src/index.ts`, beside the existing `loadGrants` call, add the equivalent `loadDeploys` call so a malformed file is a boot failure formatted like every other configuration problem:

```ts
const deployments = loadDeploys(join(ROOT, "deploys.yaml"), {
  maxLiveDeployments: config.deploy.maxLiveDeployments,
  availableProductEnv: new Set(config.deploy.availableProductEnv),
});
console.log(`[boot] ${deployments.length} deployment(s) declared`);
```

`src/index.ts` is on `EXCLUDED_PATHS`; this is an operator-directed edit, which is permitted. Keep `deployments` in scope — Tasks 3 and 4 both use it.

- [ ] **Step 9: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/deploy/deploys-schema.ts deploys.yaml tests/deploys-schema.test.ts tests/deploys-file.test.ts src/config.ts config.yaml src/index.ts
git commit -m "feat: a schema-gated deploys.yaml describing what should be running"
```

---

### Task 2: Let an agent write `deploys.yaml`, and protect the gates

**Why:** `isSelfBuildChange` admits exactly `grants.yaml` or `agents/<name>/{agent.yaml,prompt.md}`. Everything else is refused unconditionally, so **without this task an agent can never put anything live** and Task 1's file is operator-only. Separately, `excluded-paths.ts` states its own principle — *"A pipeline able to merge changes to its own gates is a pipeline with no gates"* — while two files that are gates by that definition are missing from its list.

**Files:**
- Modify: `src/control/self-build-gate.ts`, `src/control/excluded-paths.ts`
- Modify: `tests/self-build-gate.test.ts`, `tests/excluded-paths.test.ts`
- Modify: `agents/builder/prompt.md`

**Interfaces:**
- Consumes: `isSelfBuildChange(changedFiles)`, `SelfBuildInput`, `SelfBuildVerdict`, `evaluateSelfBuildChange` — read the whole file first, including its rule-3 comments.
- Produces: `deploys.yaml` admitted as a third shape; `SelfBuildInput` gains `baseDeploysYaml: string` and `headDeploysYaml?: string`; `SelfBuildVerdict`'s `rule` gains `4`.

**Read before starting.** The gate is a **pure function** — no I/O, no network, no LLM. Its own comments explain that `config.yaml` is deliberately not among its inputs, which is exactly why the `env` check lives in Task 1's loader instead. Do not add a config read here to "complete" the rules; design §3.1 settles this and the existing `outbox.discord` comment is the precedent.

**The supervisor's own hostname is not in `deploys.yaml`.** Rule 4c below compares against the hostnames the supervisor serves, which are the entries themselves plus nothing else today — the webhook receiver is reached by IP and port, not through Caddy. Implement 4c as "no entry may claim a hostname another entry already claims", which duplicate-hostname detection in Task 1 already covers for the resulting file, plus the in-place-edit refusal in 4b. **Do not invent a config field for the supervisor's hostname**; there isn't one, and adding one to `config.yaml` to satisfy a rule nothing enforces would be the same "computed by something, consumed by nothing" defect this plan has closed five times.

- [ ] **Step 1: Write the failing gate tests**

Add to `tests/self-build-gate.test.ts`. Mirror the existing fixtures in that file for `baseAgentFiles`/`agentNamesWithPromptMd`; only the new fields are shown.

```ts
describe("deploys.yaml as a self-build shape", () => {
  const ENTRY = `deployments:
  - slug: status-page
    repo: Clanker-HQ/clanker-status-page
    hostname: status.203-0-113-5.sslip.io
    port: 8080
`;

  it("is a self-build change on its own", () => {
    expect(isSelfBuildChange(["deploys.yaml"])).toBe(true);
  });

  it("is not a self-build change when mixed with an ordinary file", () => {
    expect(isSelfBuildChange(["deploys.yaml", "src/orchestrator.ts"])).toBe(false);
  });

  it("admits a PR that adds an entry", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: "deployments: []\n", headDeploysYaml: ENTRY });
    expect(verdict).toEqual({ allowed: true });
  });

  it("admits a PR that removes an entry", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY, headDeploysYaml: "deployments: []\n" });
    expect(verdict).toEqual({ allowed: true });
  });

  it("refuses a deploys.yaml that does not validate", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: "deployments: []\n", headDeploysYaml: "deployments:\n  - slug: x\n" });
    expect(verdict).toMatchObject({ allowed: false, rule: 4 });
  });

  it("refuses an entry edited in place", () => {
    const repointed = ENTRY.replace("Clanker-HQ/clanker-status-page", "AAS-Labs/something-else");
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY, headDeploysYaml: repointed });
    expect(verdict).toMatchObject({ allowed: false, rule: 4 });
    expect((verdict as { reason: string }).reason).toMatch(/edited in place/);
  });

  it("refuses a new entry claiming a hostname an existing entry already has", () => {
    const colliding = ENTRY + ENTRY.replace("status-page", "other-page");
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY, headDeploysYaml: colliding });
    expect(verdict).toMatchObject({ allowed: false, rule: 4 });
    expect((verdict as { reason: string }).reason).toMatch(/hostname/);
  });

  it("leaves the existing rules reachable when deploys.yaml is untouched", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY });
    expect(verdict).toEqual({ allowed: true });
  });
});
```

Note the last case: `headDeploysYaml` undefined must reuse the base content unchanged, exactly as `headGrantsYaml` already does.

- [ ] **Step 2: Write the failing exclusion tests**

Add to `tests/excluded-paths.test.ts`:

```ts
it("refuses a PR touching the deploy script — it owns the health gate and the rollback", () => {
  expect(touchesExcludedPath(["scripts/auto-deploy.sh"])).toBe(true);
  expect(touchesExcludedPath(["scripts/deploy-products.sh"])).toBe(true);
});

it("refuses a PR touching the self-build gate itself", () => {
  expect(touchesExcludedPath(["src/control/self-build-gate.ts"])).toBe(true);
});

it("still permits deploys.yaml — the whole point is that agents write it", () => {
  expect(touchesExcludedPath(["deploys.yaml"])).toBe(false);
});
```

**Two existing assertions in that file will go red, and both are meant to.** `tests/excluded-paths.test.ts:25` asserts `EXCLUDED_PATHS` equals an exact array, and `:49` asserts `EXCLUDED_PREFIXES` equals `["agents/"]`. They are change-detector guards: adding to either list is supposed to require editing the test, so nobody widens or narrows the set by accident. Update both to include the new entries **in the same commit**. Do not delete either assertion, do not relax it to `toContain`, and above all do not "fix" the red by dropping the exclusion — the exclusion is the deliverable and the test is the record of it.

- [ ] **Step 3: Run both and watch them fail**

Run: `npx vitest run tests/self-build-gate.test.ts tests/excluded-paths.test.ts`
Expected: FAIL — `isSelfBuildChange(["deploys.yaml"])` returns `false`; `baseDeploysYaml` is not a known property; both exclusion assertions return `false`.

- [ ] **Step 4: Protect the two gate files**

In `src/control/excluded-paths.ts`, add to `EXCLUDED_PATHS`:

```ts
  "src/control/self-build-gate.ts",
```

and to `EXCLUDED_PREFIXES`:

```ts
export const EXCLUDED_PREFIXES: readonly string[] = ["agents/", "scripts/"];
```

Extend the file's header comment to say why, in its own voice:

```
 * `scripts/` is a prefix rather than a path for the same reason `agents/` is:
 * `scripts/auto-deploy.sh` owns the health gate and the rollback that make
 * unattended deploys safe at all, `scripts/deploy-products.sh` owns the same
 * for products, and a directory that grows needs its subtree covered rather
 * than today's filenames listed. A pipeline able to weaken the check that
 * catches its own bad deploy has no such check.
 *
 * `src/control/self-build-gate.ts` is listed for the reason group 2 already
 * gives: it *is* the mechanical rules. A PR touching only that file touched no
 * excluded path before this line existed, so it merged through the ordinary
 * reviewer path — one PR weakens a rule, the next does anything.
```

This narrows what the pipeline may touch and widens nothing.

- [ ] **Step 5: Admit `deploys.yaml` as a third shape**

In `src/control/self-build-gate.ts`:

```ts
export function isSelfBuildChange(changedFiles: string[]): boolean {
  return (
    changedFiles.length > 0 &&
    changedFiles.every((f) => f === "grants.yaml" || f === "deploys.yaml" || AGENT_FILE_PATTERN.test(f))
  );
}
```

Add to `SelfBuildInput`:

```ts
  /** deploys.yaml content at the base ref. */
  baseDeploysYaml: string;
  /** deploys.yaml content at the head ref, or undefined when this PR does not touch it (base content is then reused unchanged). */
  headDeploysYaml?: string;
```

Widen the verdict: `export type SelfBuildVerdict = { allowed: true } | { allowed: false; rule: 1 | 2 | 3 | 4; reason: string };`

- [ ] **Step 6: Implement rule 4**

Insert before the final `return { allowed: true };`:

```ts
  // Rule 4 — deploys.yaml. Schema-valid, no entry edited in place, no
  // hostname claimed twice. The cap and the env-name check deliberately are
  // NOT here: both need config.yaml, which this pure function is not given —
  // the same limitation the outbox.discord note above describes. They run in
  // loadDeploys at boot and in tests/deploys-file.test.ts, so a PR that gets
  // one wrong fails CI, and in the worst case rolls back at deploy exactly as
  // that note describes. See design §3.1.
  const resultingDeploysYaml = input.headDeploysYaml ?? input.baseDeploysYaml;
  let deployments: Deployment[];
  try {
    deployments = parseDeploysShape("deploys.yaml", resultingDeploysYaml);
  } catch (err) {
    return { allowed: false, rule: 4, reason: `deploys.yaml does not validate: ${messageFor(err)}` };
  }

  let baseDeployments: Deployment[];
  try {
    baseDeployments = parseDeploysShape("deploys.yaml", input.baseDeploysYaml);
  } catch {
    // Unreachable in practice for the same reason baseGrants' catch is: the
    // base ref is the live, already-merged state, which passed this check
    // when it landed. Treat as nothing deployed rather than let a caller-side
    // data problem masquerade as this PR editing something.
    baseDeployments = [];
  }

  const baseBySlug = new Map(baseDeployments.map((d) => [d.slug, d]));
  for (const d of deployments) {
    const prior = baseBySlug.get(d.slug);
    if (prior && JSON.stringify(prior) !== JSON.stringify(d)) {
      return {
        allowed: false,
        rule: 4,
        reason: `deployment "${d.slug}" was edited in place; a deployment may only be added or removed — an in-place edit could repoint a live hostname at a different repo`,
      };
    }
  }

  const claimedHostnames = new Set<string>();
  for (const d of deployments) {
    if (claimedHostnames.has(d.hostname)) {
      return {
        allowed: false,
        rule: 4,
        reason: `hostname "${d.hostname}" is claimed by more than one deployment; two services cannot share one hostname`,
      };
    }
    claimedHostnames.add(d.hostname);
  }
```

Add to the imports at the top of the file:

```ts
import { parseDeploysShape, type Deployment } from "../deploy/deploys-schema.js";
```

`parseDeploysShape` rather than `parseDeploys` is the whole point: it runs exactly the checks a pure function with no `config.yaml` can honestly make. Do not reach for the config-aware variant here, and do not re-implement its checks inline.

- [ ] **Step 7: Update the fetching wrapper**

`evaluateSelfBuildPr` (same file, ~line 201) fetches base and head content before calling the pure function. Add `deploys.yaml` beside the existing `grants.yaml` handling — base content always, head content only when the PR touches it, and the same "absent file reads as an empty document" default:

```ts
  const [baseGrantsYaml, baseDeploysYaml, baseRepoFiles] = await Promise.all([
    github.getFileContent(repo, info.base, "grants.yaml"),
    github.getFileContent(repo, info.base, "deploys.yaml"),
    github.listRepoFiles(repo, info.base, "agents/"),
  ]);
```

then beside the existing `headGrantsYaml`:

```ts
  const headDeploysYaml = info.changedFiles.includes("deploys.yaml")
    ? ((await github.getFileContent(repo, info.headSha, "deploys.yaml")) ?? "deployments: []\n")
    : undefined;
```

and pass both into the `evaluateSelfBuildChange` call:

```ts
    baseDeploysYaml: baseDeploysYaml ?? "deployments: []\n",
    headDeploysYaml,
```

Every existing `evaluateSelfBuildChange` test fixture now needs `baseDeploysYaml: "deployments: []\n"`. The compiler lists them all; add the field rather than making it optional, so a future caller cannot forget it.

- [ ] **Step 8: Run and watch them pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Teach `builder` how to put something live**

In `agents/builder/prompt.md`, add a section. Cover exactly these points and no more:

- To put a service live, add an entry to `deploys.yaml` in a PR — one entry, nothing else in the PR, or it is refused.
- An existing entry may only be added or removed, never edited. Repointing a live hostname is refused.
- Products get a real domain, which an operator points at the host. The `<name>.<ip>.sslip.io` form is for this system's own services only. If no domain has been pointed yet, say so in the PR and leave the entry out — do not substitute a free hostname for a product.
- `env` may only name variables already listed in `config.yaml`'s `deploy.availableProductEnv`. A deployment cannot introduce a credential, and a product receives only the variables its own entry declares — never another product's.
- The product repo must contain a `docker-compose.yml` (or `compose.yml`) defining **one service named exactly by the slug**, listening on the port the entry declares. The host applies its own memory cap and env file as an override onto that service name, so a mismatch fails the deploy.
- **A product must never use this system's Claude subscription token.** Anthropic does not permit serving a third-party product's end users on it, and `goals.yaml`'s `means` forbid violating a service's terms. A product needing a model gets its own paid API key, from whichever provider research picked for it — nothing here is Anthropic-specific.

`agents/` is on `EXCLUDED_PREFIXES`; this is an operator-directed edit.

- [ ] **Step 10: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/control/self-build-gate.ts src/control/excluded-paths.ts tests/self-build-gate.test.ts tests/excluded-paths.test.ts agents/builder/prompt.md
git commit -m "feat: let an agent declare a deployment, and protect the gates that check it"
```

---

### Task 3: Render the Caddy config from the desired state

**Why:** Something has to turn `deploys.yaml` into routing. Doing it in the supervisor rather than in bash keeps it in the language the tests are written in; writing it into a bind-mounted directory is what lets the host read it without reaching into a Docker named volume.

**Files:**
- Create: `src/deploy/caddyfile.ts`, `tests/caddyfile.test.ts`
- Modify: `src/index.ts`, `docker-compose.yml`
- Create: `caddy/.gitkeep`

**Interfaces:**
- Consumes: `Deployment` from Task 1; `deployments` in `src/index.ts` from Task 1 Step 8; `writeFileAtomic` from `src/atomic-write.js`.
- Produces: `renderCaddyfile(deployments)`, `renderDeploymentsTsv(deployments)`, `writeDeployArtifacts({ deployments, dir })`.

**Two outputs, one source.** The Caddyfile routes; the TSV is what `scripts/deploy-products.sh` reads in Task 5. The TSV exists so no bash script ever parses YAML — one `while IFS=$'\t' read` loop instead of a YAML parser in shell, and no `node` invocation from the host either.

- [ ] **Step 1: Write the failing tests**

Create `tests/caddyfile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/caddyfile.test.ts`
Expected: FAIL — cannot resolve `../src/deploy/caddyfile.js`.

- [ ] **Step 3: Implement the renderer**

Create `src/deploy/caddyfile.ts`:

```ts
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
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/caddyfile.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the artifacts at boot**

In `src/index.ts`, after the `loadDeploys` call from Task 1:

```ts
  await writeDeployArtifacts({ deployments, dir: join(ROOT, "caddy") });
```

Boot must not die if this fails — a routing file that cannot be written is a reason for the host to keep the previous routing, not for the supervisor to stop running every agent. Wrap it the way the world-model reads are wrapped: `catch` and `console.error`, then continue.

- [ ] **Step 6: Mount it and add Caddy**

In `docker-compose.yml`, add to the supervisor's volumes:

```yaml
      # Read-WRITE, unlike every other mount here: the supervisor renders
      # caddy/Caddyfile and caddy/deployments.tsv from deploys.yaml at boot, and
      # both the caddy container and the host's deploy script read them
      # directly. A named volume would put them somewhere the host script can
      # only reach by digging into /var/lib/docker.
      - ./caddy:/app/caddy
```

Add the service:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      # The DIRECTORY, not ./caddy/Caddyfile itself. A bind mount whose host
      # path does not exist yet makes Docker create a DIRECTORY at that path,
      # and a directory named Caddyfile fails in a way that reads as a Caddy
      # bug rather than a missing file. caddy/ always exists (.gitkeep); the
      # Caddyfile inside it does not, until the supervisor writes it.
      - ./caddy:/etc/caddy:ro
      - caddy-data:/data
      - caddy-config:/config
```

and `caddy-data:` / `caddy-config:` to `volumes:`. `caddy-data` holds the certificates and **must** persist, or every restart re-requests them and walks into Let's Encrypt's rate limit.

Create `caddy/.gitkeep`, and add `caddy/Caddyfile` and `caddy/deployments.tsv` to `.gitignore`.

**Both generated files must stay gitignored, and this is not a style preference.** `./caddy` is bind-mounted into the supervisor read-write, so the supervisor rewrites those two files *inside the repo's own working tree on the VPS*. If either were tracked, every boot would leave the working tree dirty, and `scripts/auto-deploy.sh`'s `git merge --ff-only` would fail against a dirty tree — freezing all deploys, including the supervisor's own, until a human intervened. Do not commit a seed Caddyfile "so Caddy has something to start with".

The consequence to accept instead: on a **fresh** host, `caddy` starts before any Caddyfile exists, fails to load a config, and is restarted by `restart: unless-stopped` until the supervisor's first boot writes one — seconds later, and self-healing. That short crash loop on first boot is the correct trade for a deploy pipeline that cannot wedge itself.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/deploy/caddyfile.ts tests/caddyfile.test.ts src/index.ts docker-compose.yml caddy/.gitkeep .gitignore
git commit -m "feat: render Caddy routing and the host's deployment list from deploys.yaml"
```

---

### Task 4: Probe what is live, and put the answer where it is read

**Why:** `PortfolioEntry` has no liveness field and `src/state/liveness.ts` is about stale metrics passes, so a product returning 502 for a week still reads as `status: "live"` to the overseer. This is the plan's recurring defect inverted: an observable fact with nothing observing it.

**This task deliberately ships the producer and both consumers together.** Splitting them is exactly how `goals.yaml`, `notAchievedByAgent`, A1's `overrides?`, `Strategy.allocation` and C5's `dueReviews` each became dead on arrival. Do not defer the overseer section or the digest line to "a follow-up".

**Files:**
- Create: `src/deploy/probe-store.ts`, `src/deploy/probe.ts`, `src/deploy/probe-warnings.ts`, `src/triggers/probe.ts`
- Create: `tests/probe-store.test.ts`, `tests/probe.test.ts`, `tests/probe-warnings.test.ts`, `tests/probe-trigger.test.ts`
- Modify: `src/triggers/overseer.ts`, `src/digest.ts`, `src/triggers/digest.ts`, `src/index.ts`
- Modify: `tests/digest.test.ts`, `tests/overseer-trigger.test.ts`

**Interfaces:**
- Consumes: `Deployment` (Task 1); `writeFileAtomic`; `Cron` from `croner`.
- Produces: `ProbeResult`, `ProbeStore`, `UrlProbe`, `httpProbe`, `runProbePass`, `probeWarnings`, `startProbe`, and a `## Product liveness` section in `buildPromptContext`.

**Mirror the precedents exactly.** `probe-warnings.ts` is a pure function returning `⚠️`-prefixed strings, shaped like `stalePasses` in `src/state/liveness.ts` — read that file first, it is 20 lines. `startProbe` mirrors `startMetrics` in `src/triggers/metrics.ts`: async callback, `protect: true`, `job.trigger()` awaitable, `now?: () => Date` injected. The prober runs **in the app**, not on the host: probing is an outbound HTTP GET needing no privileges, unlike deploying.

- [ ] **Step 1: Write the failing store tests**

Create `tests/probe-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeStore, type ProbeResult } from "../src/deploy/probe-store.js";

const RESULT: ProbeResult = {
  slug: "status-page",
  url: "https://status.example.com/",
  lastProbeAt: "2026-09-01T10:00:00.000Z",
  ok: true,
  consecutiveFailures: 0,
  detail: null,
};

describe("ProbeStore", () => {
  it("reads a missing file as empty rather than throwing", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    expect(await store.read()).toEqual([]);
  });

  it("round-trips what it wrote", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    await store.write([RESULT]);
    expect(await store.read()).toEqual([RESULT]);
  });

  it("replaces the whole set on write — one writer, no merge", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    await store.write([RESULT]);
    await store.write([{ ...RESULT, slug: "widget" }]);
    expect((await store.read()).map((r) => r.slug)).toEqual(["widget"]);
  });

  it("reads a corrupt file as empty rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-"));
    const store = new ProbeStore(dir);
    await store.write([RESULT]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "state", "probes.json"), "{not json", "utf8");
    expect(await store.read()).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing probe-pass tests**

Create `tests/probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runProbePass, type UrlProbe } from "../src/deploy/probe.js";
import type { Deployment } from "../src/deploy/deploys-schema.js";

const D: Deployment = { slug: "status-page", repo: "o/r", hostname: "status.example.com", port: 8080, env: [] };
const NOW = new Date("2026-09-01T10:00:00.000Z");

const up: UrlProbe = async () => ({ ok: true, detail: null });
const down: UrlProbe = async () => ({ ok: false, detail: "HTTP 502" });

describe("runProbePass", () => {
  it("probes each deployment's public HTTPS URL, not its container", async () => {
    const seen: string[] = [];
    const spy: UrlProbe = async (url) => {
      seen.push(url);
      return { ok: true, detail: null };
    };
    await runProbePass({ deployments: [D], previous: [], probe: spy, now: NOW });
    expect(seen).toEqual(["https://status.example.com/"]);
  });

  it("records a healthy probe with zero consecutive failures", async () => {
    const results = await runProbePass({ deployments: [D], previous: [], probe: up, now: NOW });
    expect(results).toEqual([{ slug: "status-page", url: "https://status.example.com/", lastProbeAt: NOW.toISOString(), ok: true, consecutiveFailures: 0, detail: null }]);
  });

  it("counts consecutive failures across passes", async () => {
    const first = await runProbePass({ deployments: [D], previous: [], probe: down, now: NOW });
    expect(first[0]!.consecutiveFailures).toBe(1);
    const second = await runProbePass({ deployments: [D], previous: first, probe: down, now: NOW });
    expect(second[0]!.consecutiveFailures).toBe(2);
  });

  it("resets the failure count once a probe succeeds", async () => {
    const failed = await runProbePass({ deployments: [D], previous: [], probe: down, now: NOW });
    const recovered = await runProbePass({ deployments: [D], previous: failed, probe: up, now: NOW });
    expect(recovered[0]!.consecutiveFailures).toBe(0);
    expect(recovered[0]!.detail).toBeNull();
  });

  it("drops records for deployments no longer declared", async () => {
    const previous = await runProbePass({ deployments: [D], previous: [], probe: up, now: NOW });
    const results = await runProbePass({ deployments: [], previous, probe: up, now: NOW });
    expect(results).toEqual([]);
  });

  it("records a probe that throws as a failure rather than aborting the pass", async () => {
    const throwing: UrlProbe = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const results = await runProbePass({ deployments: [D], previous: [], probe: throwing, now: NOW });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/ENOTFOUND/);
  });

  it("keeps probing the rest when one deployment fails", async () => {
    const other: Deployment = { ...D, slug: "widget", hostname: "widget.example.com" };
    const mixed: UrlProbe = async (url) => (url.includes("widget") ? { ok: true, detail: null } : { ok: false, detail: "HTTP 500" });
    const results = await runProbePass({ deployments: [D, other], previous: [], probe: mixed, now: NOW });
    expect(results.map((r) => [r.slug, r.ok])).toEqual([["status-page", false], ["widget", true]]);
  });
});
```

- [ ] **Step 3: Write the failing warnings tests**

Create `tests/probe-warnings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { probeWarnings } from "../src/deploy/probe-warnings.js";
import type { ProbeResult } from "../src/deploy/probe-store.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const ok: ProbeResult = { slug: "status-page", url: "https://status.example.com/", lastProbeAt: "2026-09-01T09:55:00.000Z", ok: true, consecutiveFailures: 0, detail: null };

describe("probeWarnings", () => {
  it("says nothing when everything is healthy", () => {
    expect(probeWarnings({ probes: [ok], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 })).toEqual([]);
  });

  it("says nothing at all when nothing is deployed", () => {
    expect(probeWarnings({ probes: [], declaredSlugs: [], now: NOW, maxAgeMinutes: 30 })).toEqual([]);
  });

  it("warns about a deployment that is down, naming it and why", () => {
    const down = { ...ok, ok: false, consecutiveFailures: 3, detail: "HTTP 502" };
    const lines = probeWarnings({ probes: [down], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("status-page");
    expect(lines[0]).toContain("HTTP 502");
    expect(lines[0]).toMatch(/^⚠️/);
  });

  it("warns when the prober itself has stopped running", () => {
    const stale = { ...ok, lastProbeAt: "2026-09-01T08:00:00.000Z" };
    const lines = probeWarnings({ probes: [stale], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 });
    expect(lines[0]).toMatch(/stopped running|stale/i);
  });

  it("warns about a declared deployment that has never been probed", () => {
    const lines = probeWarnings({ probes: [], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 });
    expect(lines[0]).toContain("status-page");
    expect(lines[0]).toMatch(/never/i);
  });
});
```

- [ ] **Step 4: Run all three and watch them fail**

Run: `npx vitest run tests/probe-store.test.ts tests/probe.test.ts tests/probe-warnings.test.ts`
Expected: FAIL — none of the three modules resolve.

- [ ] **Step 5: Implement the store**

Create `src/deploy/probe-store.ts`:

```ts
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

export interface ProbeResult {
  slug: string;
  /** The public URL actually requested — recorded so a warning can be acted on without re-deriving it. */
  url: string;
  lastProbeAt: string;
  ok: boolean;
  /** Consecutive failing passes up to and including lastProbeAt; 0 whenever ok. */
  consecutiveFailures: number;
  /** Short reason for the current failure, or null when ok. */
  detail: string | null;
}

/**
 * One writer (the prober), whole-set writes, no merge. Bounded by the number
 * of declared deployments, which deploy.maxLiveDeployments already caps — so
 * this file cannot grow without an operator raising that cap.
 */
export class ProbeStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "probes.json");
  }

  /** A missing or corrupt file reads as empty and never throws: the digest and the overseer must survive a bad probes.json, not go quiet because of one. */
  async read(): Promise<ProbeResult[]> {
    const text = await readFile(this.path(), "utf8").catch(() => "");
    if (text === "") return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as ProbeResult[]) : [];
    } catch (error) {
      console.error("[probe] probes.json is unreadable; treating as empty", error);
      return [];
    }
  }

  async write(results: ProbeResult[]): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFileAtomic(this.path(), `${JSON.stringify(results, null, 2)}\n`);
  }
}
```

- [ ] **Step 6: Implement the probe pass**

Create `src/deploy/probe.ts`:

```ts
import type { Deployment } from "./deploys-schema.js";
import type { ProbeResult } from "./probe-store.js";

export type UrlProbe = (url: string) => Promise<{ ok: boolean; detail: string | null }>;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The real probe: an ordinary outbound request to the deployment's public URL,
 * exactly as a customer would make it — through Caddy, over the internet, with
 * TLS verified. Deliberately NOT the product's own Docker HEALTHCHECK, which
 * is written by the same agent that wrote the app and so cannot gate its own
 * rollback. See the deploy-path design §5.
 */
export const httpProbe: UrlProbe = async (url) => {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.status >= 200 && response.status < 400) return { ok: true, detail: null };
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
};

export function urlFor(deployment: Deployment): string {
  return `https://${deployment.hostname}/`;
}

/**
 * Probes every declared deployment and returns the complete next state.
 * Records for deployments no longer declared are dropped rather than kept:
 * this file describes what is declared now, and a record for something nobody
 * deploys any more is exactly the stale liveness data this whole task exists
 * to prevent.
 */
export async function runProbePass(opts: {
  deployments: Deployment[];
  previous: ProbeResult[];
  probe: UrlProbe;
  now: Date;
}): Promise<ProbeResult[]> {
  const previousBySlug = new Map(opts.previous.map((r) => [r.slug, r]));
  const lastProbeAt = opts.now.toISOString();

  return Promise.all(
    opts.deployments.map(async (deployment) => {
      const url = urlFor(deployment);
      // A probe that throws rather than resolving is still just a failure —
      // one unreachable host must never abort the pass and leave every other
      // deployment's record frozen at its last value.
      const outcome = await opts.probe(url).catch((error: unknown) => ({ ok: false, detail: (error as Error).message }));
      const priorFailures = previousBySlug.get(deployment.slug)?.consecutiveFailures ?? 0;
      return {
        slug: deployment.slug,
        url,
        lastProbeAt,
        ok: outcome.ok,
        consecutiveFailures: outcome.ok ? 0 : priorFailures + 1,
        detail: outcome.ok ? null : outcome.detail,
      };
    }),
  );
}
```

- [ ] **Step 7: Implement the warnings**

Create `src/deploy/probe-warnings.ts`:

```ts
import type { ProbeResult } from "./probe-store.js";

const MS_PER_MINUTE = 60 * 1000;

/**
 * Whether anything the system believes is live is actually serving.
 *
 * Deliberately code and not an agent, for the same reason `stalePasses` is:
 * the failure this detects includes "the prober stopped running", and a pass
 * that has stopped running cannot report that it has stopped running. Read by
 * the daily digest, which runs on its own schedule.
 */
export function probeWarnings(input: {
  probes: ProbeResult[];
  /** Slugs currently declared in deploys.yaml. A declared deployment with no probe record is its own warning. */
  declaredSlugs: string[];
  now: Date;
  maxAgeMinutes: number;
}): string[] {
  const lines: string[] = [];
  const bySlug = new Map(input.probes.map((r) => [r.slug, r]));

  for (const slug of input.declaredSlugs) {
    const probe = bySlug.get(slug);
    if (!probe) {
      lines.push(`⚠️ \`${slug}\` is declared in deploys.yaml but has never been probed — the prober may not be running.`);
      continue;
    }
    const ageMinutes = (input.now.getTime() - new Date(probe.lastProbeAt).getTime()) / MS_PER_MINUTE;
    if (ageMinutes > input.maxAgeMinutes) {
      lines.push(
        `⚠️ \`${slug}\`'s last probe is ${Math.floor(ageMinutes)} minutes old — the prober has stopped running, so its liveness below is stale.`,
      );
      continue;
    }
    if (!probe.ok) {
      lines.push(
        `⚠️ \`${slug}\` is not serving at ${probe.url} — ${probe.detail ?? "no detail"} ` +
          `(${probe.consecutiveFailures} consecutive failure(s)).`,
      );
    }
  }

  return lines;
}
```

- [ ] **Step 8: Run all three and watch them pass**

Run: `npx vitest run tests/probe-store.test.ts tests/probe.test.ts tests/probe-warnings.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 9: Write the failing trigger test, then the trigger**

Create `tests/probe-trigger.test.ts`. `job.trigger()` is awaitable because the callback is async — the same mechanism `tests/metrics-trigger.test.ts` and `tests/cron-trigger.test.ts` rely on. Stop the job in each test so a scheduled tick cannot fire after it finishes.

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeStore } from "../src/deploy/probe-store.js";
import { startProbe } from "../src/triggers/probe.js";
import type { Deployment } from "../src/deploy/deploys-schema.js";

const A: Deployment = { slug: "status-page", repo: "o/r", hostname: "status.example.com", port: 8080, env: [] };
const B: Deployment = { slug: "widget", repo: "o/w", hostname: "widget.example.com", port: 3000, env: [] };
const NOW = new Date("2026-09-01T10:00:00.000Z");

// A schedule that never fires on its own within a test run: every firing here
// is an explicit job.trigger(), so nothing races the assertions.
const NEVER = "0 0 1 1 *";

describe("startProbe", () => {
  it("writes a record for every declared deployment", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    const job = startProbe({
      schedule: NEVER,
      timezone: "UTC",
      deployments: [A, B],
      store,
      probe: async () => ({ ok: true, detail: null }),
      now: () => NOW,
    });
    await job.trigger();
    job.stop();
    expect((await store.read()).map((r) => r.slug).sort()).toEqual(["status-page", "widget"]);
  });

  it("still records the reachable deployment when another one's probe throws", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    const job = startProbe({
      schedule: NEVER,
      timezone: "UTC",
      deployments: [A, B],
      store,
      probe: async (url) => {
        if (url.includes("status")) throw new Error("getaddrinfo ENOTFOUND");
        return { ok: true, detail: null };
      },
      now: () => NOW,
    });
    await job.trigger();
    job.stop();
    const results = await store.read();
    expect(results.find((r) => r.slug === "widget")?.ok).toBe(true);
    expect(results.find((r) => r.slug === "status-page")?.ok).toBe(false);
  });
});
```

Then create `src/triggers/probe.ts`:

```ts
import { Cron } from "croner";
import type { Deployment } from "../deploy/deploys-schema.js";
import { httpProbe, runProbePass, type UrlProbe } from "../deploy/probe.js";
import type { ProbeStore } from "../deploy/probe-store.js";

export function startProbe(opts: {
  schedule: string;
  timezone: string;
  deployments: Deployment[];
  store: ProbeStore;
  probe?: UrlProbe;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const probe = opts.probe ?? httpProbe;
  // Async rather than `void run().catch()`: croner awaits an async callback,
  // so `protect: true` genuinely prevents an overlapping pass and
  // `job.trigger()` becomes awaitable — same reasoning as startMetrics.
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, async () => {
    try {
      const previous = await opts.store.read();
      const results = await runProbePass({ deployments: opts.deployments, previous, probe, now: now() });
      await opts.store.write(results);
      const down = results.filter((r) => !r.ok);
      console.log(`[probe] probed ${results.length} deployment(s); ${down.length} not serving`);
    } catch (error) {
      console.error("[probe] pass failed", error);
    }
  });
  console.log(`[probe] scheduled "${opts.schedule}" (${opts.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`);
  return job;
}
```

- [ ] **Step 10: Consumer one — the overseer's prompt**

In `src/triggers/overseer.ts`, add beside `renderDueReviews`:

```ts
/**
 * Renders every declared deployment's current liveness, or says explicitly
 * that nothing is deployed. An empty section here would read as a rendering
 * bug rather than "nothing is live" — the same reasoning as renderDueReviews,
 * and the reason this section exists at all: without it the overseer reviews a
 * portfolio entry marked "live" with no way to know it has been 502ing for a
 * week.
 */
function renderProductLiveness(deployments: Deployment[], probes: ProbeResult[]): string {
  if (deployments.length === 0) return "(nothing is deployed)";
  const bySlug = new Map(probes.map((p) => [p.slug, p]));
  return deployments
    .map((d) => {
      const probe = bySlug.get(d.slug);
      if (!probe) return `- ${d.slug} (${d.hostname}): never probed`;
      if (probe.ok) return `- ${d.slug} (${d.hostname}): serving, last probed ${probe.lastProbeAt}`;
      return `- ${d.slug} (${d.hostname}): NOT SERVING — ${probe.detail ?? "no detail"}, ${probe.consecutiveFailures} consecutive failure(s), last probed ${probe.lastProbeAt}`;
    })
    .join("\n");
}
```

Thread `deployments: Deployment[]` and `probeStore: ProbeStore` through `buildPromptContext` and `startOverseer` as **required** options. Read the probes beside the existing `readPortfolio` call:

```ts
  const probes = await opts.probeStore.read();
```

and add the section between `## Due reviews` and `## World model`:

```ts
    `## Product liveness\n\n${renderProductLiveness(opts.deployments, probes)}\n\n` +
```

Required, not optional: an optional dependency here degrades to the overseer silently never seeing liveness, which is the exact trap `startMetrics`'s `overrides` comment documents. Making it required turns an omission at the call site into a `npm run typecheck` error.

Add a test to `tests/overseer-trigger.test.ts` asserting the rendered context contains `## Product liveness` and the `NOT SERVING` text for a failing probe.

- [ ] **Step 11: Consumer two — the daily digest**

In `src/digest.ts`, add `probeWarnings` output to the warning lines. Mirror how `metricsStore` is handled: optional in `buildDigestText` so existing fixtures keep working, and folded into the same `livenessWarnings` array so the existing "nothing happened" early return keeps accounting for it.

```ts
  const deployWarnings =
    opts.probeStore && opts.declaredSlugs
      ? probeWarnings({ probes: await opts.probeStore.read(), declaredSlugs: opts.declaredSlugs, now, maxAgeMinutes: MAX_PROBE_AGE_MINUTES })
      : [];
```

Add `const MAX_PROBE_AGE_MINUTES = 30;` beside `MAX_METRICS_AGE_DAYS`, with a comment giving the reason (twice the 15-minute probe cadence, so one missed pass is not an alarm — the same rule `MAX_METRICS_AGE_DAYS` follows). Include `deployWarnings.length === 0` in the early-return condition and push its lines beside `livenessWarnings`.

In `src/triggers/digest.ts`, pass both through from the production call site. Add a test to `tests/digest.test.ts` asserting a down deployment produces a digest line, and one asserting the production wiring actually supplies the store — the point of that second test is that an optional parameter nobody passes is a feature that never runs.

- [ ] **Step 12: Wire the prober at boot**

In `src/index.ts`, construct the store beside the other stores, then start the prober after `writeDeployArtifacts`, following the `startMetrics` block's lazy-import-and-catch shape:

```ts
  const probeStore = new ProbeStore(DATA_DIR);

  // Only when something is actually declared: a prober with nothing to probe
  // would write an empty file every 15 minutes forever and log a line saying
  // it probed nothing.
  if (deployments.length > 0) {
    void import("./triggers/probe.js")
      .then(({ startProbe }) => {
        startProbe({ schedule: "*/15 * * * *", timezone: config.digest.timezone, deployments, store: probeStore });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the deployment prober", error);
      });
  }
```

Use whatever the file already calls its data directory constant rather than introducing a new one, and reuse an existing timezone from config rather than adding a `deploy.timezone` nobody asked for — a probe cadence of every 15 minutes is timezone-insensitive, and an unused config field is the defect this plan keeps closing.

Then pass `deployments` and `probeStore` into the `startOverseer` call (Step 10 made both required, so the compiler will not let this be forgotten) and into the digest wiring (Step 11).

- [ ] **Step 13: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/deploy/probe-store.ts src/deploy/probe.ts src/deploy/probe-warnings.ts src/triggers/probe.ts src/triggers/overseer.ts src/digest.ts src/triggers/digest.ts src/index.ts tests/
git commit -m "feat: probe every deployment and surface it to the overseer and the digest"
```

---

### Task 5: The host side, and the end-to-end proof

**Why:** Tasks 1-4 are inert without the script that actually builds and runs a product, and the deploy gate that rolls it back. This is the only bash in the plan and the only part not unit-tested — it is verified by its first real run, which announces itself in Discord either way.

**Files:**
- Create: `scripts/deploy-products.sh`
- Modify: `scripts/auto-deploy.sh`, `docs/decisions.md`, `README.md`

**Interfaces:**
- Consumes: `caddy/deployments.tsv` (Task 3), written by the supervisor at boot.
- Produces: running product containers, per-slug last-good-SHA state, a reloaded Caddy.

**Read `scripts/auto-deploy.sh` in full first.** Match its conventions exactly: `set -euo pipefail`, `cd "$(dirname "$0")/.."`, quiet on the common case, the same `notify()` helper reading `DISCORD_WEBHOOK_OPS` from `.env`, and the same `--data-binary "@file"` trick for UTF-8 payloads. Do not reimplement `notify`; source it or copy it verbatim with a comment saying which.

**No YAML parsing in bash, and no `node` from the host.** Read `caddy/deployments.tsv` with a single `while IFS=$'\t' read -r slug repo hostname port env` loop. That file exists precisely so this script needs no interpreter.

- [ ] **Step 1: Write the deploy script**

Create `scripts/deploy-products.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Deploys the products declared in deploys.yaml. Runs on the VPS HOST, called
# by auto-deploy.sh once the supervisor's own deploy has settled — and, like
# that script, deliberately NOT an agent-callable tool: triggering a deploy
# from inside a container means mounting the Docker socket, which is close to
# host-root. See docs/decisions.md ("Auto-deploy runs host-side, not
# agent-side").
#
# THE HEALTH GATE IS THE EXTERNAL PROBE BELOW, NEVER THE PRODUCT'S OWN
# HEALTHCHECK. A product's Dockerfile is written by the same agent that wrote
# the app, so `HEALTHCHECK CMD exit 0` would pass forever and a rollback
# triggered by it would be no rollback at all. Design §5.
#
# Reads caddy/deployments.tsv, which the supervisor renders from deploys.yaml
# at boot, so this script parses no YAML and starts no interpreter.

cd "$(dirname "$0")/.."

PRODUCTS_DIR="${PRODUCTS_DIR:-$PWD/../products}"
STATE_DIR="${STATE_DIR:-$PWD/.deploy-state}"
PRODUCT_ENV_FILE="${PRODUCT_ENV_FILE:-$PWD/../products.env}"
TSV="${TSV:-$PWD/caddy/deployments.tsv}"
PROBE_TIMEOUT_S="${PROBE_TIMEOUT_S:-90}"
PROBE_POLL_S="${PROBE_POLL_S:-5}"
PRODUCT_MEMORY="${PRODUCT_MEMORY:-512m}"

# No file means the supervisor has not booted since this feature shipped, or
# nothing is declared. Either way there is nothing to do and nothing to say.
[ -s "$TSV" ] || exit 0

mkdir -p "$PRODUCTS_DIR" "$STATE_DIR"

# Copied verbatim from scripts/auto-deploy.sh rather than sourced: that script
# is a standalone entry point and this one is too, and a shared helper file
# would be a third thing to keep in sync. The --data-binary "@file" form is
# there for the same reason it is there — passing UTF-8 through argv to curl is
# not reliable on every platform.
notify() {
  local text="$1"
  local webhook
  webhook=$(grep -E '^DISCORD_WEBHOOK_OPS=' .env 2>/dev/null | cut -d= -f2- || true)
  [ -n "$webhook" ] || return 0
  local payload
  payload="$(mktemp)"
  printf '{"content": "%s"}' "$text" > "$payload"
  curl -fsS -X POST -H "Content-Type: application/json" --data-binary "@${payload}" "$webhook" >/dev/null || true
  rm -f "$payload"
}

# A 2xx or 3xx at the real public URL, over the internet, through Caddy, with
# TLS verified — exactly the request a customer would make. Echoes the last
# status seen so the caller can report it.
probe() {
  local url="$1" elapsed=0 code=000
  while [ "$elapsed" -lt "$PROBE_TIMEOUT_S" ]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
    case "$code" in
      2??|3??) echo "$code"; return 0 ;;
    esac
    sleep "$PROBE_POLL_S"
    elapsed=$((elapsed + PROBE_POLL_S))
  done
  echo "$code"
  return 1
}

# The memory cap and the env allowlist are applied HERE, in an override file
# this script owns, for the same reason the health gate is external: the
# product's own compose file is agent-authored, so a limit written there
# constrains nothing. Each product receives ONLY the variables its deploys.yaml
# entry declared — one product must never see another product's key.
write_overrides() {
  local slug="$1" dir="$2" names="$3"

  : > "$dir/.deploy-env"
  chmod 600 "$dir/.deploy-env"
  if [ -n "$names" ]; then
    local name
    IFS=',' read -ra requested <<< "$names"
    for name in "${requested[@]}"; do
      grep -E "^${name}=" "$PRODUCT_ENV_FILE" >> "$dir/.deploy-env" 2>/dev/null || true
    done
  fi

  cat > "$dir/.deploy-override.yml" <<EOF
services:
  $slug:
    mem_limit: $PRODUCT_MEMORY
    restart: unless-stopped
    env_file:
      - .deploy-env
EOF
}

compose_for() {
  local dir="$1" candidate
  for candidate in docker-compose.yml compose.yml; do
    if [ -f "$dir/$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

# Once, before the loop: the Caddyfile the supervisor rendered at boot already
# contains a site block for every declared hostname, so one reload makes every
# route live. Each one 502s only until its container is up, which is exactly
# what the probe below waits for.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || echo "[deploy-products] caddy reload failed or caddy is not running yet"

failures=0

# Read on fd 3, not stdin: git and docker below both read stdin, and would
# otherwise swallow the rest of this file.
while IFS=$'\t' read -r slug repo hostname port envnames <&3; do
  [ -n "$slug" ] || continue

  dir="$PRODUCTS_DIR/$slug"
  good_file="$STATE_DIR/$slug.sha"

  [ -d "$dir/.git" ] || git clone --quiet "https://github.com/$repo.git" "$dir"

  git -C "$dir" fetch origin --quiet
  # Queried from the remote rather than refs/remotes/origin/HEAD, for the
  # reason auto-deploy.sh documents: that ref is only set up by `git clone` and
  # is absent on a repo assembled any other way.
  default_branch="$(git -C "$dir" ls-remote --symref origin HEAD | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}')"
  target_sha="$(git -C "$dir" rev-parse "origin/$default_branch")"
  current_sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)"
  last_good="$(cat "$good_file" 2>/dev/null || echo none)"

  # Nothing new, and it deployed cleanly last time. Stay quiet — same posture
  # as auto-deploy.sh on a tick with nothing to do.
  if [ "$target_sha" = "$current_sha" ] && [ "$last_good" = "$target_sha" ]; then
    continue
  fi

  if ! compose_file="$(compose_for "$dir")"; then
    echo "[deploy-products] $slug: no docker-compose.yml or compose.yml at ${target_sha:0:7}"
    notify "⚠️ \`$slug\` has no compose file at \`${target_sha:0:7}\` — not deployed."
    failures=$((failures + 1))
    continue
  fi

  echo "[deploy-products] $slug: deploying ${target_sha:0:7} (was ${current_sha:0:7})"
  git -C "$dir" checkout --quiet "$target_sha"
  write_overrides "$slug" "$dir" "$envnames"

  if ! (cd "$dir" && docker compose -p "$slug" -f "$compose_file" -f .deploy-override.yml up --build -d); then
    echo "[deploy-products] $slug: build/start failed for ${target_sha:0:7}"
    notify "⚠️ \`$slug\`: \`${target_sha:0:7}\` failed to build or start — not serving."
    failures=$((failures + 1))
    continue
  fi

  if code="$(probe "https://$hostname/")"; then
    echo "$target_sha" > "$good_file"
    echo "[deploy-products] $slug: ${target_sha:0:7} is serving (HTTP $code)"
    notify "✅ \`$slug\` deployed \`${target_sha:0:7}\` — serving at https://$hostname/ (HTTP $code)."
  else
    failures=$((failures + 1))
    if [ "$last_good" = "none" ]; then
      # Nothing to roll back to. Leaving a broken service reachable is worse
      # than leaving nothing reachable: a 502 that persists is at least honest.
      echo "[deploy-products] $slug: first deploy never served (HTTP $code) — stopping it"
      (cd "$dir" && docker compose -p "$slug" -f "$compose_file" -f .deploy-override.yml down) || true
      notify "⚠️ \`$slug\`: first deploy of \`${target_sha:0:7}\` never served (HTTP ${code}) — stopped. No previous version to roll back to."
    else
      echo "[deploy-products] $slug: ${target_sha:0:7} failed its probe (HTTP $code) — rolling back to ${last_good:0:7}"
      git -C "$dir" checkout --quiet "$last_good"
      write_overrides "$slug" "$dir" "$envnames"
      (cd "$dir" && docker compose -p "$slug" -f "$compose_file" -f .deploy-override.yml up --build -d) || true
      notify "⚠️ \`$slug\`: \`${target_sha:0:7}\` failed its health probe (HTTP ${code}) — rolled back to \`${last_good:0:7}\`."
    fi
  fi
done 3< "$TSV"

# Every deployment is attempted before this matters: one product failing must
# never stop another from deploying.
[ "$failures" -eq 0 ] || exit 1
```

`chmod +x scripts/deploy-products.sh`.

**The product-repo contract this assumes**, which Step 9 of Task 2 must state in `agents/builder/prompt.md`: a product repo contains a `docker-compose.yml` (or `compose.yml`) defining **one service named exactly by its slug**, listening on the port its `deploys.yaml` entry declares. A mismatched service name makes the override apply to a service with no image or build, which Compose rejects loudly — a visible failure, not a silent one.

`.deploy-env` and `.deploy-override.yml` are written into the product's working tree and never committed; the deploy only ever checks out, so untracked files there are harmless.

- [ ] **Step 2: Hook it into the existing watcher**

In `scripts/auto-deploy.sh`, call `./scripts/deploy-products.sh` **after** the supervisor's own health check resolves, on both the healthy and the rolled-back path — a product must keep being deployed and probed even on a tick where the supervisor itself rolled back, or a supervisor bug would silently freeze every product's deploys. Guard with `[ -x ./scripts/deploy-products.sh ]` so an older checkout without the script still deploys the supervisor.

Note the ordering this relies on, established in design §4: `docker compose up --build -d` recreates the supervisor, which rewrites `caddy/Caddyfile` and `caddy/deployments.tsv` at boot, so by the time this call runs both reflect the newly merged `deploys.yaml`.

- [ ] **Step 3: Add `.deploy-state/` and the products directory to `.gitignore`**

- [ ] **Step 4: Record the billing resolution in `docs/decisions.md`**

Add an entry resolving the contradiction design §7 identifies. State that `docs/decisions.md`'s "Subscription billing, not API billing" reasoning rested on "no user-facing product is planned", which the primary goal contradicts; that a product therefore never uses the operator's subscription token; and that a product needing a model gets its own paid API key from whichever provider research selected for it, with nothing in the product path Anthropic-specific. Cross-reference the deploy-path design.

- [ ] **Step 5: Document the deploy path in `README.md`**

Extend "Deploying, and staying deployed": how `deploys.yaml` works, that products get real domains while the `sslip.io` form is for this system's own services, the per-product manual DNS step until D1b automates it, and the `deploy.availableProductEnv` allowlist. Add the `caddy` service and the two new volumes to whatever the README says about compose.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add scripts/deploy-products.sh scripts/auto-deploy.sh .gitignore docs/decisions.md README.md
git commit -m "feat: deploy, route and health-gate products on the host"
```

- [ ] **Step 7: The end-to-end proof — deferred until the VPS exists**

**Not part of the merge.** Design §11: nothing here works end-to-end until the system runs on a public host, which is a one-time manual operator step documented at `README.md:55-72`.

When that has happened, prove the path with the smallest possible service: a repo containing one static page, a `Dockerfile`, and a compose file; a `deploys.yaml` entry on a `sslip.io` hostname; then PR, CI, review, merge, and wait one auto-deploy tick. The path works when that page is reachable over HTTPS with a valid certificate and the next daily digest reports its liveness. Deliberately trivial: this proves the pipeline, not the product, and the dashboard's content is a separate design.

---

## What this plan does not do

- **Acquire anything** — no signup, no domain registration, no API key, no payment. That is D1b, and design §10 draws the boundary.
- **A runtime secret store.** Product env values are read by the host at deploy time from a file the operator owns. Making a key obtained at runtime usable without a redeploy is D1b's.
- **Deprovisioning.** Removing an entry stops its container and its route; it cancels no third-party service, because nothing yet signs up for one. D1b's most important requirement, and the failure most likely to survive every other guard in the parent plan.
- **Per-product resource caps beyond memory.** CPU and disk quotas are a real concern on a shared box and are deliberately deferred until a product exists to measure.
