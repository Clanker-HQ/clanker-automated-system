export interface PullRequestInfo {
  number: number;
  repo: string;
  headSha: string;
  /** The branch this PR targets, e.g. "main" — used by the self-build gate to fetch the CURRENT (not stale) base-ref registry state. */
  base: string;
  changedFiles: string[];
  diff: string;
  title: string;
  body: string;
  /**
   * GitHub's own PR state at the moment this was fetched — "open" covers
   * both a plain open PR and a merged one (GitHub's API reports `state:
   * "open"` until closed; `merged` is the separate flag that distinguishes
   * a merge from a plain close). webhook-wiring.ts's processEvent checks
   * this before spending a run: a webhook-triggered review can sit queued
   * behind a Governor refusal for hours (see WebhookRetryStore) and by the
   * time it's finally retried, the PR it was queued for may already have
   * been merged or closed by an earlier, cheaper duplicate delivery of the
   * same event, or by a human — discovered 2026-09-12 when a stale retry
   * spent $18.41 reviewing a PR that had already merged 1h38m earlier.
   */
  state: "open" | "closed";
  /** True when a "closed" PR was closed via merge rather than a plain close. Meaningless when `state` is "open". */
  merged: boolean;
}

export type MergeResult = { merged: true } | { merged: false; reason: string };

export interface GithubTransport {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  postReviewComment(repo: string, number: number, body: string): Promise<void>;
  /** Refuses (merged: false) rather than merging if the PR's current head has moved past expectedHeadSha. */
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult>;
  createPullRequest(repo: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /** Creates a new repo under `org`. */
  createRepo(org: string, name: string, opts: { private: boolean; description?: string }): Promise<{ fullName: string; url: string }>;
  /**
   * Registers a webhook on `repo` for pull_request events, pointed at this
   * system's own receiver — so a repo createRepo just made starts emitting
   * the events pr-reviewer needs, with no manual per-repo GitHub Settings
   * step. `opts.secret` is the same GITHUB_WEBHOOK_SECRET the receiver
   * itself verifies incoming deliveries against.
   */
  createHook(repo: string, opts: { url: string; secret: string }): Promise<void>;
  /** Content of `path` at `ref` (a branch name or commit SHA), or null if it doesn't exist there. */
  getFileContent(repo: string, ref: string, path: string): Promise<string | null>;
  /** Every blob path under `pathPrefix` at `ref`, recursively. */
  listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]>;
  /**
   * Whether at least one issue/PR comment exists with a timestamp at or
   * after `since` — from a human, or from a prior postReviewComment call.
   * Exists purely as the detection signal for webhook-wiring.ts's
   * post-run check: a pr-reviewer run can finish "success" having reasoned
   * through a full review, yet never actually get its postReviewComment
   * call through to GitHub — discovered 2026-09-09/10, "AbortError: Stream
   * closed" inside the Claude Code CLI's own transport, not this codebase,
   * so it can't be fixed at the source. Deliberately this narrow (a
   * boolean-ish existence check, not a general listComments) since nothing
   * else in this system needs more.
   */
  hasCommentSince(repo: string, number: number, since: Date): Promise<boolean>;
}

/** Test double: lets a test seed PR state and inspect what was posted/merged, with no real GitHub calls. */
export class FakeGithubTransport implements GithubTransport {
  postedComments: { repo: string; number: number; body: string; createdAt: string }[] = [];
  merged: { repo: string; number: number }[] = [];
  createdPullRequests: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  createdRepos: { org: string; name: string; private: boolean; description?: string }[] = [];
  createdHooks: { repo: string; url: string; secret: string }[] = [];
  private pulls = new Map<string, PullRequestInfo>();
  private files = new Map<string, string>();
  private nextPrNumber = 1;

  private key(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  private fileKey(repo: string, ref: string, path: string): string {
    return `${repo}@${ref}:${path}`;
  }

  /**
   * `base`, `state`, and `merged` all default (to "main", "open", and false
   * respectively) so every existing test that seeds a PR without caring
   * about closed/merged handling keeps working unchanged.
   */
  seedPullRequest(info: Omit<PullRequestInfo, "base" | "state" | "merged"> & { base?: string; state?: "open" | "closed"; merged?: boolean }): void {
    this.pulls.set(this.key(info.repo, info.number), {
      ...info,
      base: info.base ?? "main",
      state: info.state ?? "open",
      merged: info.merged ?? false,
    });
  }

  /** Seeds the content a getFileContent/listRepoFiles call returns for `path` at `ref`. */
  seedFile(repo: string, ref: string, path: string, content: string): void {
    this.files.set(this.fileKey(repo, ref, path), content);
  }

  async getFileContent(repo: string, ref: string, path: string): Promise<string | null> {
    return this.files.get(this.fileKey(repo, ref, path)) ?? null;
  }

  async listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]> {
    const prefix = this.fileKey(repo, ref, pathPrefix);
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(this.fileKey(repo, ref, "").length));
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const info = this.pulls.get(this.key(repo, number));
    if (!info) throw new Error(`FakeGithubTransport: no pull request seeded for ${repo}#${number}`);
    return info;
  }

  async postReviewComment(repo: string, number: number, body: string): Promise<void> {
    this.postedComments.push({ repo, number, body, createdAt: new Date().toISOString() });
  }

  async hasCommentSince(repo: string, number: number, since: Date): Promise<boolean> {
    return this.postedComments.some(
      (c) => c.repo === repo && c.number === number && new Date(c.createdAt).getTime() >= since.getTime(),
    );
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult> {
    const info = await this.getPullRequest(repo, number);
    if (info.headSha !== expectedHeadSha) {
      return { merged: false, reason: `PR head moved (expected ${expectedHeadSha}, now ${info.headSha}) — a newer commit landed since review started` };
    }
    this.merged.push({ repo, number });
    return { merged: true };
  }

  async createPullRequest(
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    this.createdPullRequests.push({ repo, ...opts });
    const number = this.nextPrNumber++;
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }

  async createRepo(org: string, name: string, opts: { private: boolean; description?: string }): Promise<{ fullName: string; url: string }> {
    this.createdRepos.push({ org, name, ...opts });
    return { fullName: `${org}/${name}`, url: `https://github.com/${org}/${name}` };
  }

  async createHook(repo: string, opts: { url: string; secret: string }): Promise<void> {
    this.createdHooks.push({ repo, ...opts });
  }
}
