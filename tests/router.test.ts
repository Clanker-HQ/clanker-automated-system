import { describe, expect, it } from "vitest";
import { FakeRouter } from "../src/control/router.js";

describe("FakeRouter", () => {
  it("returns a fixed answer and records the call", async () => {
    const router = new FakeRouter("research");
    const specialists = [{ name: "research", description: "researches things" }];
    const result = await router.route("find me a good business idea", specialists);
    expect(result).toBe("research");
    expect(router.calls).toEqual([{ taskText: "find me a good business idea", specialists }]);
  });

  it("returns null when constructed with null", async () => {
    const router = new FakeRouter(null);
    expect(await router.route("anything", [{ name: "research", description: "d" }])).toBeNull();
  });

  it("supports a function responder for per-call logic", async () => {
    const router = new FakeRouter((_text, specialists) => specialists[0]?.name ?? null);
    expect(await router.route("anything", [{ name: "research", description: "d" }])).toBe("research");
    expect(await router.route("anything", [])).toBeNull();
  });
});
