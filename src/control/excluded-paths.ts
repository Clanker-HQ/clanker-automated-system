/**
 * Files that define the rules constraining every agent in this system —
 * including the files that implement this exclusion itself. A PR touching any
 * of these can never merge through the automated review-gate pipeline, no
 * matter what a review concludes — this is a static, mechanical exclusion,
 * not a judgment call any agent or review makes. See
 * docs/decisions.md ("the PR reviewer runs a PR's code directly") for why
 * this backstop exists alongside CODEOWNERS/branch protection.
 *
 * The set deliberately covers two groups:
 *
 * 1. The parent governance files (`src/governor.ts`, `src/grants.ts`,
 *    `src/agent-schema.ts`, `src/control/bot.ts`, `grants.yaml`,
 *    `config.yaml`) — the rules every agent runs under.
 * 2. This pipeline's own implementation — the merge gates
 *    (`src/runner/sdk-runner.ts`), this file itself (deleting one line here
 *    would remove the whole mechanism), the webhook trust boundary
 *    (`src/control/webhook-signature.ts`, `src/control/webhook-wiring.ts`,
 *    `src/control/webhook-receiver.ts`), the child-env credential allowlist
 *    (`src/runner/credentials.ts`), the boot wiring (`src/index.ts`), CI
 *    itself (`.github/workflows/ci.yml`), and `src/control/git-pusher.ts` —
 *    the code that turns a validated `branch` argument into the actual
 *    pushed git ref, and so needs the same protection as the regex in
 *    `sdk-runner.ts` that validates that argument in the first place. A
 *    pipeline able to merge changes to its own gates is a pipeline with no
 *    gates: one PR weakens the check, the next does anything.
 *
 * `config.yaml` is excluded whole rather than just its `governor:` key: a
 * line-range check inside one file is fragile against reformatting, and
 * nothing else in config.yaml is sensitive enough to be worth that risk for
 * the rare case an automated PR would want to touch it at all.
 *
 * `EXCLUDED_PREFIXES` covers what exact-path membership structurally cannot:
 * `agents/` is a directory that grows over time, and ANY `agent.yaml` in it
 * is a capability grant — a PR adding `tier: autonomous, approval: auto,
 * grantRefs: [infra-repo]` to some unrelated agent hands that agent merge
 * capability without ever touching the excluded `grants.yaml`. Listing today's
 * agent files by name would silently stop protecting tomorrow's.
 *
 * As of the self-build merge gate (`src/control/self-build-gate.ts`), a PR
 * whose changed files are EXACTLY `grants.yaml`, or EXACTLY
 * `agents/<name>/{agent.yaml,prompt.md}` for one agent, is no longer
 * refused outright — it is instead checked against four mechanical rules
 * (schema-valid, no in-place grant edit, credential scope, CI green)
 * before `mergePR`'s other gates run. Everything else — including any PR
 * that mixes a self-build file with anything outside that exact shape —
 * is still refused here, unconditionally, exactly as before. The scenario
 * this comment originally warned about (a `grants.yaml`-free path to
 * `tier: autonomous, approval: auto`) is now possible in principle, but
 * only through a PR the four rules above admit — see
 * docs/superpowers/specs/2026-08-30-self-evaluation-design.md's rule-3
 * amendment for why that is the intended, credential-bounded trade rather
 * than an oversight.
 */
export const EXCLUDED_PATHS: readonly string[] = [
  // The parent governance files.
  "src/governor.ts",
  "src/grants.ts",
  "src/agent-schema.ts",
  "src/control/bot.ts",
  "grants.yaml",
  "config.yaml",
  // This pipeline's own safety rails.
  "src/control/excluded-paths.ts",
  "src/runner/sdk-runner.ts",
  "src/control/git-pusher.ts",
  "src/control/webhook-signature.ts",
  "src/control/webhook-wiring.ts",
  "src/control/webhook-receiver.ts",
  "src/runner/credentials.ts",
  "src/index.ts",
  ".github/workflows/ci.yml",
];

/**
 * Path prefixes whose whole subtree is excluded. Unlike `EXCLUDED_PATHS`,
 * this covers files that don't exist yet — see the note above about any
 * `agent.yaml` under `agents/`.
 */
export const EXCLUDED_PREFIXES: readonly string[] = ["agents/"];

export function touchesExcludedPath(changedFiles: string[]): boolean {
  return changedFiles.some((f) => EXCLUDED_PATHS.includes(f) || EXCLUDED_PREFIXES.some((p) => f.startsWith(p)));
}
