import { describe, expect, it, vi } from "vitest";
import { touchesExcludedPath } from "../src/control/excluded-paths.js";
import { GithubApiTransport } from "../src/control/github-api-transport.js";

/** A minimal Response-shaped stub — only the members GithubApiTransport reads. */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): Response {
  const headerMap = new Map(Object.entries(opts.headers ?? {}));
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

function prJson(overrides: Record<string, unknown> = {}) {
  return { head: { sha: "sha-1" }, title: "A change", body: "Does a thing.", ...overrides };
}

describe("GithubApiTransport.getPullRequest", () => {
  it("returns the PR's metadata, changed files and diff on a normal (single-page) response", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) {
        return fakeResponse({ json: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }] });
      }
      // The metadata fetch and the diff fetch hit the identical URL (only
      // the Accept header differs), so one stub response serving both
      // `.json()` and `.text()` covers whichever of the two this call is.
      return fakeResponse({ json: prJson(), text: "diff --git a/x b/x" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });
    const info = await t.getPullRequest("owner/repo", 1);

    expect(info.headSha).toBe("sha-1");
    expect(info.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(info.title).toBe("A change");
  });

  // Regression test for the final review's Critical #1: GitHub reports a
  // rename as a single entry whose `filename` is the NEW path, with the OLD
  // path only in `previous_filename`. Mapping just `filename` meant a PR that
  // renamed an excluded file (src/governor.ts -> src/core/governor.ts)
  // reported only the unprotected new path, so Lock 4's exact-path check
  // never saw the excluded path and waved the rename through — after which
  // the file is permanently outside the protected set.
  it("reports both sides of a rename, so a file renamed away from an excluded path is still visible to Lock 4", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) {
        return fakeResponse({
          json: [
            { filename: "src/core/governor.ts", previous_filename: "src/governor.ts", status: "renamed" },
            { filename: "README.md", status: "modified" },
          ],
        });
      }
      return fakeResponse({ json: prJson(), text: "diff --git a/x b/x" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });
    const info = await t.getPullRequest("owner/repo", 1);

    expect(info.changedFiles).toContain("src/governor.ts");
    expect(info.changedFiles).toContain("src/core/governor.ts");
    expect(info.changedFiles).toContain("README.md");
    // And the mapping that produces it is what Lock 4 actually consumes.
    expect(touchesExcludedPath(info.changedFiles)).toBe(true);
  });

  it("fails closed — refuses rather than silently truncating — when the changed-files list is paginated", async () => {
    // GitHub signals more pages via a `Link: <...>; rel="next"` response
    // header on the /files endpoint; per_page=100 only ever returns the
    // first page. mergePR's excluded-path gate treats changedFiles as
    // authoritative, so silently returning a truncated list here would let
    // an excluded path sorted past file #100 slip through undetected.
    const filesHeader = { link: '<https://api.github.com/repos/owner/repo/pulls/1/files?page=2>; rel="next"' };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) {
        return fakeResponse({ json: Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}.ts` })), headers: filesHeader });
      }
      return fakeResponse({ json: prJson(), text: "diff --git a/x b/x" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });

    await expect(t.getPullRequest("owner/repo", 1)).rejects.toThrow(/more than 100 changed files/);
  });

  it("throws when the PR metadata fetch fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) return fakeResponse({ json: [] });
      return fakeResponse({ ok: false, status: 404, json: {}, text: "" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });
    await expect(t.getPullRequest("owner/repo", 1)).rejects.toThrow(/404/);
  });

  it("throws when the changed-files fetch fails, rather than reviewing on an empty/opaque list", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) return fakeResponse({ ok: false, status: 500, json: {}, text: "" });
      return fakeResponse({ json: prJson(), text: "diff --git a/x b/x" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });
    await expect(t.getPullRequest("owner/repo", 1)).rejects.toThrow(/failed to fetch changed files/);
  });

  it("throws when the diff fetch fails", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) return fakeResponse({ json: [] });
      call += 1;
      // First non-/files call is the metadata fetch (succeeds), second is the diff fetch (fails).
      return call === 1 ? fakeResponse({ json: prJson() }) : fakeResponse({ ok: false, status: 502, json: {}, text: "" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });
    await expect(t.getPullRequest("owner/repo", 1)).rejects.toThrow(/failed to fetch diff/);
  });
});

describe("GithubApiTransport.mergePullRequest", () => {
  it("reports a stale SHA (409) as a refusal, not an exception", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 409 })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });
    const result = await t.mergePullRequest("owner/repo", 1, "sha-1");
    expect(result).toEqual({ merged: false, reason: expect.stringContaining("head moved") });
  });

  it("reports success on a 2xx merge response", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: true, status: 200 })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });
    await expect(t.mergePullRequest("owner/repo", 1, "sha-1")).resolves.toEqual({ merged: true });
  });
});

describe("GithubApiTransport.createPullRequest", () => {
  it("posts to the pulls endpoint and returns the created PR's number and url", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ json: { number: 42, html_url: "https://github.com/owner/repo/pull/42" } }),
    ) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });

    const pr = await t.createPullRequest("owner/repo", { head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." });

    expect(pr).toEqual({ number: 42, url: "https://github.com/owner/repo/pull/42" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." }),
      }),
    );
  });

  it("throws when GitHub rejects the pull request creation", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 422 })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });

    await expect(
      t.createPullRequest("owner/repo", { head: "agent/builder/add-x", base: "main", title: "Add X", body: "" }),
    ).rejects.toThrow(/422/);
  });
});
