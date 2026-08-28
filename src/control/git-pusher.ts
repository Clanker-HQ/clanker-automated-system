import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable push mechanism, mirroring GithubTransport's injectable-transport shape. */
export interface GitPusher {
  push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void>;
}

/**
 * Shells out to the real `git` binary via execFile (never a shell — no
 * interpolation risk from `remoteUrl`/`branch`). `remoteUrl` carries the push
 * credential as a one-shot CLI argument
 * (`https://x-access-token:<token>@github.com/owner/repo.git`) rather than a
 * credential helper or `git remote add` — it never touches disk and never
 * appears in `git remote -v` afterward.
 */
export class RealGitPusher implements GitPusher {
  async push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void> {
    await execFileAsync("git", ["-C", opts.cwd, "push", opts.remoteUrl, `HEAD:refs/heads/${opts.branch}`]);
  }
}

/** Test double: records what would have been pushed, with no real git or network call. */
export class FakeGitPusher implements GitPusher {
  pushed: { cwd: string; remoteUrl: string; branch: string }[] = [];

  async push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void> {
    this.pushed.push(opts);
  }
}
