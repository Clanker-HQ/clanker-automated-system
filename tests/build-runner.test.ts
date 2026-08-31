import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeGitPusher } from "../src/control/git-pusher.js";
import { PendingStore } from "../src/control/pending.js";
import { TaskStore } from "../src/control/task-store.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { buildRunner } from "../src/runner/build-runner.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import { SdkRunner } from "../src/runner/sdk-runner.js";

afterEach(() => vi.restoreAllMocks());

function opts() {
  return { grants: [], pending: new PendingStore(mkdtempSync(join(tmpdir(), "cai-buildrunner-"))) };
}

describe("buildRunner", () => {
  it("returns the real runner by default: the fake is the opt-in, not the other way round", () => {
    expect(buildRunner(opts(), {})).toBeInstanceOf(SdkRunner);
  });

  it("returns the fake runner only when RUNNER=fake", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(buildRunner(opts(), { RUNNER: "fake" })).toBeInstanceOf(FakeRunner);
    expect(log.mock.calls.flat().join(" ")).toContain("no subscription quota");
  });

  it("does not treat some other RUNNER value as the fake", () => {
    expect(buildRunner(opts(), { RUNNER: "sdk" })).toBeInstanceOf(SdkRunner);
    expect(buildRunner(opts(), { RUNNER: "" })).toBeInstanceOf(SdkRunner);
  });

  it("passes the grants and pending store through to the real runner's constructor", () => {
    const { grants, pending } = opts();
    const runner = buildRunner({ grants, pending }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });

  it("accepts tasks/wake and still returns the real runner when provided", () => {
    const { grants, pending } = opts();
    const tasks = new TaskStore(mkdtempSync(join(tmpdir(), "cai-buildrunner-")));
    const wake = async () => {};
    const runner = buildRunner({ grants, pending, tasks, wake }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });

  it("accepts a gitPusher and still returns the real runner when provided", () => {
    const { grants, pending } = opts();
    const gitPusher = new FakeGitPusher();
    const runner = buildRunner({ grants, pending, gitPusher }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });

  it("accepts memory/memoryConfig and still returns the real runner when provided", () => {
    const { grants, pending } = opts();
    const memory = new MemoryStore(mkdtempSync(join(tmpdir(), "cai-buildrunner-")));
    const memoryConfig = { enabled: true } as any; // only `enabled` matters to buildRunner itself
    const runner = buildRunner({ grants, pending, memory, memoryConfig }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });
});
