import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { RealGitCloner, FakeGitCloner } = await import("../src/control/git-cloner.js");

// The mock's call history persists across tests in this file (no clearMocks
// config in this repo's vitest setup), so reset it between tests — otherwise
// the FakeGitCloner test below would see leftover calls from the
// RealGitCloner tests instead of asserting its own behavior.
beforeEach(() => {
  execFileMock.mockClear();
});

describe("RealGitCloner", () => {
  it("shells out to git clone with the remote URL and target dir, no shell interpolation", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(null, "", ""),
    );
    const cloner = new RealGitCloner();

    await cloner.clone({
      remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git",
      targetDir: "/work/repo",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "https://x-access-token:tok@github.com/owner/repo.git", "/work/repo"],
      expect.any(Function),
    );
  });

  it("rejects when the underlying git clone fails", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(new Error("fatal: repository not found"), "", "not found"),
    );
    const cloner = new RealGitCloner();

    await expect(
      cloner.clone({ remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", targetDir: "/work/repo" }),
    ).rejects.toThrow("fatal: repository not found");
  });
});

describe("FakeGitCloner", () => {
  it("records the clone without touching real git or the network", async () => {
    const cloner = new FakeGitCloner();
    const opts = { remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", targetDir: "/work/repo" };

    await cloner.clone(opts);

    expect(cloner.cloned).toEqual([opts]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects when shouldFail is set, simulating a real git failure", async () => {
    const cloner = new FakeGitCloner();
    cloner.shouldFail = true;

    await expect(
      cloner.clone({ remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", targetDir: "/work/repo" }),
    ).rejects.toThrow("not found");
    expect(cloner.cloned).toEqual([]);
  });
});
