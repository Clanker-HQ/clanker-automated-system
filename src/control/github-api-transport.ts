import type { GithubTransport, MergeResult, PullRequestInfo } from "./github-transport.js";

/** The only file that talks to the real GitHub API, mirroring how discord-transport.ts is the only file importing discord.js and sdk-runner.ts the only file importing the Agent SDK. */
export class GithubApiTransport implements GithubTransport {
  constructor(private readonly opts: { token: string }) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const [prRes, filesRes, diffRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: this.headers() }),
      fetch(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100`, { headers: this.headers() }),
      fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: { ...this.headers(), accept: "application/vnd.github.diff" } }),
    ]);
    if (!prRes.ok) throw new Error(`GitHub API: failed to fetch ${repo}#${number} (${prRes.status})`);
    const pr = (await prRes.json()) as { head: { sha: string }; title: string; body: string | null };
    const files = (await filesRes.json()) as { filename: string }[];
    const diff = await diffRes.text();
    return {
      number,
      repo,
      headSha: pr.head.sha,
      changedFiles: files.map((f) => f.filename),
      diff,
      title: pr.title,
      body: pr.body ?? "",
    };
  }

  async postReviewComment(repo: string, number: number, body: string): Promise<void> {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to post comment on ${repo}#${number} (${res.status})`);
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }),
    });
    if (res.status === 409) {
      return { merged: false, reason: "PR head moved since review started (GitHub rejected the expected SHA)" };
    }
    if (!res.ok) {
      return { merged: false, reason: `GitHub API rejected the merge (${res.status})` };
    }
    return { merged: true };
  }
}
