import { mkdtempSync } from "node:fs";
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
});
