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
}

export type MergeResult = { merged: true } | { merged: false; reason: string };

export interface GithubTransport {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  postReviewComment(repo: string, number: number, body: string): Promise<void>;
  /** Refuses (merged: false) rather than merging if the PR's current head has moved past expectedHeadSha. */
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult>;
  createPullRequest(repo: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /** Content of `path` at `ref` (a branch name or commit SHA), or null if it doesn't exist there. */
  getFileContent(repo: string, ref: string, path: string): Promise<string | null>;
  /** Every blob path under `pathPrefix` at `ref`, recursively. */
  listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]>;
}

/** Test double: lets a test seed PR state and inspect what was posted/merged, with no real GitHub calls. */
export class FakeGithubTransport implements GithubTransport {
  postedComments: { repo: string; number: number; body: string }[] = [];
  merged: { repo: string; number: number }[] = [];
  createdPullRequests: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  private pulls = new Map<string, PullRequestInfo>();
  private files = new Map<string, string>();
  private nextPrNumber = 1;

  private key(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  private fileKey(repo: string, ref: string, path: string): string {
    return `${repo}@${ref}:${path}`;
  }

  seedPullRequest(info: Omit<PullRequestInfo, "base"> & { base?: string }): void {
    this.pulls.set(this.key(info.repo, info.number), { ...info, base: info.base ?? "main" });
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
    this.postedComments.push({ repo, number, body });
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
}
