import { configDefaults, defineConfig } from "vitest/config";

/**
 * `.worktrees/` holds isolated git worktrees for executing plan tasks one at a
 * time (see .gitignore). Each one is a full checkout, so vitest's default
 * discovery finds a second copy of every test file and runs the suite twice —
 * roughly doubling the run and, worse, producing spurious failures: tests like
 * builder-agent-registration.test.ts load the real repo config by relative
 * path, which resolves differently when the file is reached through a
 * worktree. Excluded here rather than fixed per-test, because the problem is
 * discovery, not any individual test. A worktree runs its own suite from
 * inside itself, where this exclude does not apply.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
