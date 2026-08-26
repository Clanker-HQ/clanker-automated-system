import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRunner } from "../src/runner/build-runner.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import { SdkRunner } from "../src/runner/sdk-runner.js";

// Constructing an SdkRunner does nothing on its own — no credential is read
// and no SDK call is made until execute() is iterated — so both polarities are
// safe to assert offline.
afterEach(() => vi.restoreAllMocks());

describe("buildRunner", () => {
  it("returns the real runner by default: the fake is the opt-in, not the other way round", () => {
    expect(buildRunner({})).toBeInstanceOf(SdkRunner);
  });

  it("returns the fake runner only when RUNNER=fake", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(buildRunner({ RUNNER: "fake" })).toBeInstanceOf(FakeRunner);
    expect(log.mock.calls.flat().join(" ")).toContain("no subscription quota");
  });

  it("does not treat some other RUNNER value as the fake", () => {
    expect(buildRunner({ RUNNER: "sdk" })).toBeInstanceOf(SdkRunner);
    expect(buildRunner({ RUNNER: "" })).toBeInstanceOf(SdkRunner);
  });
});
