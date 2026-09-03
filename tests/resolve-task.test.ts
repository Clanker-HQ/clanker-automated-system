import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../src/control/task-store.js";
import { resolveTaskByPrefix } from "../src/control/resolve-task.js";

function store(): TaskStore {
  return new TaskStore(mkdtempSync(join(tmpdir(), "cai-resolve-")));
}

describe("resolveTaskByPrefix", () => {
  it("resolves a full id to its task", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "test" });
    expect(await resolveTaskByPrefix(s, task.id)).toEqual({ task });
  });

  it("resolves a short prefix that matches exactly one task", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "test" });
    expect(await resolveTaskByPrefix(s, task.id.slice(0, 8))).toEqual({ task });
  });

  it("returns notFound: true when no task matches", async () => {
    const result = await resolveTaskByPrefix(store(), "nope");
    expect(result).toEqual({ error: "No task found starting with `nope`.", notFound: true });
  });

  it("returns notFound: false with the short ids when the prefix is ambiguous", async () => {
    const s = store();
    const a = await s.create({ text: "a", createdBy: "test" });
    const b = await s.create({ text: "b", createdBy: "test" });
    // Every id starts with "", so this always matches everything currently in the store.
    const result = await resolveTaskByPrefix(s, "");
    expect(result).toEqual({
      error: `\`\` matches 2 tasks — be more specific: ${a.id.slice(0, 8)}, ${b.id.slice(0, 8)}`,
      notFound: false,
    });
  });
});
