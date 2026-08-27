import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovedGrantsStore } from "../src/state/approved-grants.js";

describe("ApprovedGrantsStore", () => {
  it("returns an empty list for an unknown run", async () => {
    const store = new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-approved-")));
    expect(await store.read("run-unknown")).toEqual([]);
  });

  it("approve then read round-trips", async () => {
    const store = new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-approved-")));
    await store.approve("run-1", "test-echo");
    expect(await store.read("run-1")).toEqual(["test-echo"]);
  });

  it("approving the same grant twice does not duplicate it", async () => {
    const store = new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-approved-")));
    await store.approve("run-1", "test-echo");
    await store.approve("run-1", "test-echo");
    expect(await store.read("run-1")).toEqual(["test-echo"]);
  });

  it("approving two different grants for the same run accumulates both", async () => {
    const store = new ApprovedGrantsStore(mkdtempSync(join(tmpdir(), "cai-approved-")));
    await store.approve("run-1", "a");
    await store.approve("run-1", "b");
    expect(await store.read("run-1")).toEqual(["a", "b"]);
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-approved-"));
    await new ApprovedGrantsStore(dir).approve("run-1", "a");
    await new ApprovedGrantsStore(dir).approve("run-1", "b");
    expect(await new ApprovedGrantsStore(dir).read("run-1")).toEqual(["a", "b"]);
  });

  // If the file were ever corrupted or hand-edited into something that isn't
  // an array of strings, a bare `JSON.parse(...) as string[]` cast would let
  // it flow straight into `.includes()` — and a JSON *string* is array-like
  // enough that `.includes()` on it silently becomes a substring match
  // (`"test-echo-and-more".includes("test-echo")` is true). read() must fail
  // closed to [] instead.
  it("treats a malformed (non-array) file as no approvals, not a crash or a substring match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-approved-"));
    await mkdir(join(dir, "runs", "run-1"), { recursive: true });
    await writeFile(join(dir, "runs", "run-1", "approved-grants.json"), JSON.stringify("test-echo-and-more"));

    const store = new ApprovedGrantsStore(dir);
    expect(await store.read("run-1")).toEqual([]);
  });

  it("drops non-string entries from an array that has some", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-approved-"));
    await mkdir(join(dir, "runs", "run-1"), { recursive: true });
    await writeFile(join(dir, "runs", "run-1", "approved-grants.json"), JSON.stringify(["a", 5, null, "b"]));

    const store = new ApprovedGrantsStore(dir);
    expect(await store.read("run-1")).toEqual(["a", "b"]);
  });
});
