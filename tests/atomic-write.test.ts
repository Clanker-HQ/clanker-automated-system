import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn<(from: string, to: string) => Promise<void>>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: renameMock };
});

const { writeFileAtomic } = await import("../src/atomic-write.js");

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-write-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("writeFileAtomic", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    renameMock.mockImplementation((from, to) => actual.rename(from, to));
  });

  afterEach(() => {
    renameMock.mockReset();
  });

  it("writes the full contents to the target path", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "file.txt");
      await writeFileAtomic(path, "hello world");
      expect(await readFile(path, "utf8")).toBe("hello world");
    }));

  it("overwrites an existing file's contents entirely, not appending", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "file.txt");
      await writeFileAtomic(path, "first, much longer content here");
      await writeFileAtomic(path, "second");
      expect(await readFile(path, "utf8")).toBe("second");
    }));

  it("leaves no temp file behind after a successful write", () =>
    withTmpDir(async (dir) => {
      await writeFileAtomic(join(dir, "file.txt"), "content");
      const entries = await readdir(dir);
      expect(entries).toEqual(["file.txt"]);
    }));

  it("retries a rename that transiently fails with EPERM and eventually succeeds", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "file.txt");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let attempts = 0;
      renameMock.mockImplementation(async (from, to) => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("busy") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return actual.rename(from, to);
      });

      await writeFileAtomic(path, "content");

      expect(attempts).toBe(3);
      expect(await readFile(path, "utf8")).toBe("content");
    }));

  it("propagates a rename failure that isn't a transient lock error, without retrying", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "file.txt");
      let attempts = 0;
      renameMock.mockImplementation(async () => {
        attempts++;
        const err = new Error("no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });

      await expect(writeFileAtomic(path, "content")).rejects.toThrow("no such file or directory");
      expect(attempts).toBe(1);
    }));

  it("gives up after exhausting retries on a persistent transient error", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "file.txt");
      let attempts = 0;
      renameMock.mockImplementation(async () => {
        attempts++;
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      });

      await expect(writeFileAtomic(path, "content")).rejects.toMatchObject({ code: "EBUSY" });
      expect(attempts).toBe(5);
    }));
});
