import { describe, expect, it } from "vitest";
import { FakeRouter, specialistsOf } from "../src/control/router.js";
import type { AgentDef } from "../src/registry.js";

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "research",
    description: "researches things",
    enabled: true,
    trigger: { type: "dispatched" },
    ...overrides,
  } as AgentDef;
}

describe("specialistsOf", () => {
  it("includes an enabled, dispatched agent as a specialist", () => {
    const result = specialistsOf([agent()]);
    expect(result).toEqual([{ name: "research", description: "researches things" }]);
  });

  it("excludes a disabled agent even if it is dispatched", () => {
    const result = specialistsOf([agent({ enabled: false })]);
    expect(result).toEqual([]);
  });

  it("excludes an agent whose trigger is not 'dispatched' (e.g. cron)", () => {
    const result = specialistsOf([agent({ trigger: { type: "cron", schedule: "* * * * *" } } as Partial<AgentDef>)]);
    expect(result).toEqual([]);
  });

  it("filters a mixed list down to only enabled+dispatched agents, preserving order", () => {
    const enabledDispatched = agent({ name: "research", description: "d1" });
    const disabled = agent({ name: "disabled-one", description: "d2", enabled: false });
    const cron = agent({ name: "cron-one", description: "d3", trigger: { type: "cron", schedule: "* * * * *" } } as Partial<AgentDef>);
    const otherDispatched = agent({ name: "other", description: "d4" });

    const result = specialistsOf([enabledDispatched, disabled, cron, otherDispatched]);
    expect(result).toEqual([
      { name: "research", description: "d1" },
      { name: "other", description: "d4" },
    ]);
  });

  it("returns an empty array for an empty agent list", () => {
    expect(specialistsOf([])).toEqual([]);
  });

  it("only projects the name and description fields, dropping the rest", () => {
    const result = specialistsOf([agent()]);
    expect(Object.keys(result[0]!)).toEqual(["name", "description"]);
  });
});

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
