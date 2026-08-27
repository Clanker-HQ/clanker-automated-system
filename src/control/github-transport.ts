export interface PullRequestInfo {
  number: number;
  repo: string;
  headSha: string;
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
}

/** Test double: lets a test seed PR state and inspect what was posted/merged, with no real GitHub calls. */
export class FakeGithubTransport implements GithubTransport {
  postedComments: { repo: string; number: number; body: string }[] = [];
  merged: { repo: string; number: number }[] = [];
  private pulls = new Map<string, PullRequestInfo>();

  private key(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  seedPullRequest(info: PullRequestInfo): void {
    this.pulls.set(this.key(info.repo, info.number), info);
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
}
