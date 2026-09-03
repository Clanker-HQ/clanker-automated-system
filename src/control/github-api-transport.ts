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

    const pr = (await prRes.json()) as { head: { sha: string }; base: { ref: string }; title: string; body: string | null };
    const files = (await filesRes.json()) as { filename: string; previous_filename?: string }[];
    const diff = await diffRes.text();
    return {
      number,
      repo,
      headSha: pr.head.sha,
      base: pr.base.ref,
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

  async createRepo(org: string, name: string, opts: { private: boolean; description?: string }): Promise<{ fullName: string; url: string }> {
    const res = await this.fetchImpl(`https://api.github.com/orgs/${org}/repos`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      // auto_init: true — without it GitHub creates a completely empty repo
      // (zero commits, zero branches), and whichever agent branch gets
      // pushed first becomes the default branch by accident instead of
      // "main" existing as expected. openPR's base then 404s with nothing to
      // target. Auto-initializing gives every new repo a real "main" (with a
      // README commit) at creation time, before pushBranch/openPR ever run.
      body: JSON.stringify({
        name,
        private: opts.private,
        auto_init: true,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Checked against 201 specifically, not `res.ok` (any 2xx) — this is a
    // new resource being created, so an unexpected-but-2xx response is worth
    // surfacing rather than silently accepting. The response body is
    // included verbatim (not swallowed into a generic message): the operator
    // needs to know exactly what GitHub said went wrong.
    if (res.status !== 201) {
      const body = await res.text();
      throw new Error(`GitHub API: failed to create repo ${org}/${name} (${res.status}): ${body}`);
    }
    const created = (await res.json()) as { full_name: string; html_url: string };
    return { fullName: created.full_name, url: created.html_url };
  }

  async getFileContent(repo: string, ref: string, path: string): Promise<string | null> {
    // Each segment is encoded individually rather than the whole path at once:
    // the "/" separators must stay literal for the Contents API, but anything
    // else — `path` now comes from PR-controlled data via evaluateSelfBuildPr's
    // info.changedFiles — must not be able to end the path early (a raw "?" or
    // "#" would otherwise start the query string or fragment).
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API: failed to fetch ${repo}/${path}@${ref} (${res.status})`);
    const body = (await res.json()) as { content: string; encoding: string };
    return Buffer.from(body.content, "base64").toString("utf8");
  }

  /**
   * Uses the Git Trees API recursively rather than the Contents API, which
   * only lists one directory level per call — this needs every
   * agents directory's agent.yaml regardless of nesting depth in one round trip.
   * Fails closed on a truncated tree for the same reason getPullRequest
   * fails closed on a paginated changed-files list: an incomplete listing
   * here could hide an agent.yaml from the self-build gate's schema check.
   */
  async listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to list files in ${repo}@${ref} (${res.status})`);
    const body = (await res.json()) as { tree: { path: string; type: string }[]; truncated: boolean };
    if (body.truncated) {
      throw new Error(`GitHub API: file tree for ${repo}@${ref} is truncated; refusing to enumerate an incomplete listing`);
    }
    return body.tree.filter((e) => e.type === "blob" && e.path.startsWith(pathPrefix)).map((e) => e.path);
  }
}
