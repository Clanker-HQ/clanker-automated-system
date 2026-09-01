import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeStore, type ProbeResult } from "../src/deploy/probe-store.js";

const RESULT: ProbeResult = {
  slug: "status-page",
  url: "https://status.example.com/",
  lastProbeAt: "2026-09-01T10:00:00.000Z",
  ok: true,
  consecutiveFailures: 0,
  detail: null,
};

describe("ProbeStore", () => {
  it("reads a missing file as empty rather than throwing", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    expect(await store.read()).toEqual([]);
  });

  it("round-trips what it wrote", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    await store.write([RESULT]);
    expect(await store.read()).toEqual([RESULT]);
  });

  it("replaces the whole set on write — one writer, no merge", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    await store.write([RESULT]);
    await store.write([{ ...RESULT, slug: "widget" }]);
    expect((await store.read()).map((r) => r.slug)).toEqual(["widget"]);
  });

  it("reads a corrupt file as empty rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-"));
    const store = new ProbeStore(dir);
    await store.write([RESULT]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "state", "probes.json"), "{not json", "utf8");
    expect(await store.read()).toEqual([]);
  });
});
