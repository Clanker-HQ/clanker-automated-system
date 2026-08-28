import { describe, expect, it } from "vitest";
import { FakeGithubTransport } from "../src/control/github-transport.js";

function pr(overrides: Partial<Parameters<FakeGithubTransport["seedPullRequest"]>[0]> = {}) {
  return {
    number: 1,
    repo: "owner/repo",
    headSha: "abc123",
    changedFiles: ["src/index.ts"],
    diff: "diff --git a/src/index.ts b/src/index.ts\n+// change",
    title: "A small change",
    body: "Does a small thing.",
    ...overrides,
  };
}

describe("FakeGithubTransport", () => {
  it("returns a seeded pull request", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr());
    const info = await t.getPullRequest("owner/repo", 1);
    expect(info).toMatchObject({ number: 1, headSha: "abc123", changedFiles: ["src/index.ts"] });
  });

  it("throws a clear error for an unseeded pull request", async () => {
    const t = new FakeGithubTransport();
    await expect(t.getPullRequest("owner/repo", 999)).rejects.toThrow(/999/);
  });

  it("records posted review comments", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr());
    await t.postReviewComment("owner/repo", 1, "Looks fine.");
    expect(t.postedComments).toEqual([{ repo: "owner/repo", number: 1, body: "Looks fine." }]);
  });

  it("merges when the expected SHA matches the current head", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr({ headSha: "abc123" }));
    const result = await t.mergePullRequest("owner/repo", 1, "abc123");
    expect(result).toEqual({ merged: true });
    expect(t.merged).toEqual([{ repo: "owner/repo", number: 1 }]);
  });

  it("refuses to merge when the expected SHA is stale", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr({ headSha: "new-commit-sha" }));
    const result = await t.mergePullRequest("owner/repo", 1, "abc123");
    expect(result).toEqual({ merged: false, reason: expect.stringContaining("head") });
    expect(t.merged).toEqual([]);
  });

  it("records a created pull request and returns an incrementing fake number/url", async () => {
    const t = new FakeGithubTransport();

    const first = await t.createPullRequest("owner/repo", { head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." });
    const second = await t.createPullRequest("owner/repo", { head: "agent/builder/add-z", base: "main", title: "Add Z", body: "Because W." });

    expect(t.createdPullRequests).toEqual([
      { repo: "owner/repo", head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." },
      { repo: "owner/repo", head: "agent/builder/add-z", base: "main", title: "Add Z", body: "Because W." },
    ]);
    expect(first).toEqual({ number: 1, url: "https://github.com/owner/repo/pull/1" });
    expect(second).toEqual({ number: 2, url: "https://github.com/owner/repo/pull/2" });
  });
});
