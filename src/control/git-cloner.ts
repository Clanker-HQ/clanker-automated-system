import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable clone mechanism, mirroring GitPusher's injectable-transport shape. */
export interface GitCloner {
  clone(opts: { remoteUrl: string; targetDir: string }): Promise<void>;
}

/**
 * Shells out to the real `git` binary via execFile (never a shell — no
 * interpolation risk from `remoteUrl`). `remoteUrl` carries the read
 * credential as a one-shot CLI argument
 * (`https://x-access-token:<token>@github.com/owner/repo.git`), the same
 * pattern RealGitPusher uses (git-pusher.ts) — it never touches disk and
 * never appears in `git remote -v` afterward.
 *
 * This exists specifically because a bare, credential-less clone URL
 * against a private repo does not fail cleanly — it makes git fall back to
 * whatever credential helper is configured on the machine, up to and
 * including an interactive browser sign-in window on a machine with Git
 * Credential Manager installed (observed live against AAS-Labs' private
 * product repos). An unattended agent can never complete that prompt.
 * Embedding the credential up front means git never invokes a helper at
 * all, so it fails (or succeeds) immediately and non-interactively either
 * way.
 */
export class RealGitCloner implements GitCloner {
  async clone(opts: { remoteUrl: string; targetDir: string }): Promise<void> {
    await execFileAsync("git", ["clone", "--depth", "1", opts.remoteUrl, opts.targetDir]);
  }
}

/** Test double: records what would have been cloned, with no real git or network call. */
export class FakeGitCloner implements GitCloner {
  cloned: { remoteUrl: string; targetDir: string }[] = [];
  /** Set to make the next clone() call reject, simulating a real git failure (e.g. repo not found). */
  shouldFail = false;

  async clone(opts: { remoteUrl: string; targetDir: string }): Promise<void> {
    if (this.shouldFail) throw new Error(`fatal: repository '${opts.remoteUrl}' not found`);
    this.cloned.push(opts);
  }
}
