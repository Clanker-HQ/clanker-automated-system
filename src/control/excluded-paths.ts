/**
 * Files that define the rules constraining every agent in this system. A PR
 * touching any of these can never merge through the automated review-gate
 * pipeline, no matter what a review concludes — this is a static, mechanical
 * exclusion, not a judgment call any agent or review makes. See
 * docs/superpowers/specs/2026-08-27-pr-review-gate-design.md §3 (Lock 4).
 *
 * `config.yaml` is excluded whole rather than just its `governor:` key: a
 * line-range check inside one file is fragile against reformatting, and
 * nothing else in config.yaml is sensitive enough to be worth that risk for
 * the rare case an automated PR would want to touch it at all.
 */
export const EXCLUDED_PATHS: readonly string[] = [
  "src/governor.ts",
  "src/grants.ts",
  "src/agent-schema.ts",
  "src/control/bot.ts",
  "grants.yaml",
  "config.yaml",
];

export function touchesExcludedPath(changedFiles: string[]): boolean {
  return changedFiles.some((f) => EXCLUDED_PATHS.includes(f));
}
