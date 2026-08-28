import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { RealGitPusher, FakeGitPusher } = await import("../src/control/git-pusher.js");

// The mock's call history persists across tests in this file (no clearMocks
// config in this repo's vitest setup), so reset it between tests — otherwise
// the FakeGitPusher test below would see leftover calls from the
// RealGitPusher tests instead of asserting its own behavior.
beforeEach(() => {
  execFileMock.mockClear();
});

describe("RealGitPusher", () => {
  it("shells out to git push with the remote URL and an explicit refspec, no shell interpolation", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(null, "", ""),
    );
    const pusher = new RealGitPusher();

    await pusher.push({
      cwd: "/work/repo",
      remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git",
      branch: "agent/builder/add-x",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/work/repo", "push", "https://x-access-token:tok@github.com/owner/repo.git", "HEAD:refs/heads/agent/builder/add-x"],
      expect.any(Function),
    );
  });

  it("rejects when the underlying git push fails", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(new Error("git push failed"), "", "non-fast-forward"),
    );
    const pusher = new RealGitPusher();

    await expect(
      pusher.push({ cwd: "/work/repo", remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", branch: "agent/builder/add-x" }),
    ).rejects.toThrow("git push failed");
  });
});

describe("FakeGitPusher", () => {
  it("records the push without touching real git or the network", async () => {
    const pusher = new FakeGitPusher();
    const opts = { cwd: "/work/repo", remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", branch: "agent/builder/add-x" };

    await pusher.push(opts);

    expect(pusher.pushed).toEqual([opts]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
