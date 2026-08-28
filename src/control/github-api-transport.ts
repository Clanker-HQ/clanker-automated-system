import type { GithubTransport, MergeResult, PullRequestInfo } from "./github-transport.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** The only file that talks to the real GitHub API, mirroring how discord-transport.ts is the only file importing discord.js and sdk-runner.ts the only file importing the Agent SDK. */
export class GithubApiTransport implements GithubTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { token: string; fetchImpl?: typeof fetch }) {
    // Injectable (defaulting to the real global fetch), the same way
    // DiscordOutbox takes an optional fetchImpl — the only thing that makes
    // this class's HTTP behaviour (pagination, error handling) unit-testable
    // without a real GitHub call or a global fetch stub.
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const [prRes, filesRes, diffRes] = await Promise.all([
      this.fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      this.fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      this.fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}`, {
        headers: { ...this.headers(), accept: "application/vnd.github.diff" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ]);
    if (!prRes.ok) throw new Error(`GitHub API: failed to fetch ${repo}#${number} (${prRes.status})`);
    if (!filesRes.ok) throw new Error(`GitHub API: failed to fetch changed files for ${repo}#${number} (${filesRes.status})`);
    if (!diffRes.ok) throw new Error(`GitHub API: failed to fetch diff for ${repo}#${number} (${diffRes.status})`);

    // GitHub paginates this endpoint; per_page=100 only ever returns the
    // first page. mergePR's excluded-path gate (Lock 4) treats this
    // changedFiles list as authoritative, so a truncated list here would let
    // a large PR's later files (where an excluded path could easily sort)
    // go unchecked — a silent bypass, not merely an incomplete report. Fail
    // closed instead: refuse to review at all rather than review on data
    // known to be incomplete. Full pagination support is a reasonable future
    // improvement; it isn't required to close this specific gap.
    if (filesRes.headers.get("link")?.includes('rel="next"')) {
      throw new Error(
        `GitHub API: ${repo}#${number} has more than 100 changed files; refusing to review on a truncated file list`,
      );
    }

    const pr = (await prRes.json()) as { head: { sha: string }; title: string; body: string | null };
    const files = (await filesRes.json()) as { filename: string; previous_filename?: string }[];
    const diff = await diffRes.text();
    return {
      number,
      repo,
      headSha: pr.head.sha,
      // A rename is reported as one entry with `filename` = the NEW path and
      // `previous_filename` = the OLD one. Reporting only the new path would
      // let a PR move an excluded file out from under Lock 4's exact-path set
      // (e.g. src/governor.ts -> src/core/governor.ts): the check would see
      // only the unprotected new path, wave the rename through, and a
      // follow-up PR could then rewrite the now-unprotected file freely. Both
      // paths are carried through so the excluded-path check sees the file
      // the PR is moving away from as well as where it lands.
      changedFiles: files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
      diff,
      title: pr.title,
      body: pr.body ?? "",
    };
  }

  async postReviewComment(repo: string, number: number, body: string): Promise<void> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to post comment on ${repo}#${number} (${res.status})`);
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 409) {
      return { merged: false, reason: "PR head moved since review started (GitHub rejected the expected SHA)" };
    }
    if (!res.ok) {
      return { merged: false, reason: `GitHub API rejected the merge (${res.status})` };
    }
    return { merged: true };
  }

  async createPullRequest(
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ head: opts.head, base: opts.base, title: opts.title, body: opts.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to open a pull request for ${repo}:${opts.head} (${res.status})`);
    const pr = (await res.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url };
  }
}
