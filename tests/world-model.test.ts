import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldModel, type Finding, type PortfolioEntry, type ShelfItem } from "../src/world/world-model.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
  return { dataDir, world: new WorldModel(dataDir) };
}

function entry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    slug: "widget-api",
    purpose: "Paid API for widget conversion",
    status: "live",
    nextReviewAt: "2026-10-01",
    bar: "at least one paying customer",
    monthlyCostUsd: 12,
    notes: ["2026-09-01: launched"],
    ...overrides,
  };
}

function shelfItem(overrides: Partial<ShelfItem> = {}): ShelfItem {
  return {
    summary: "Chrome extension for widget tracking",
    shelvedAt: "2026-08-15",
    reason: "No signal after two weeks of outreach",
    revisitWhen: "if a paying customer asks for it directly",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    topic: "pricing-strategy",
    conclusion: "Usage-based pricing outperforms flat monthly for this segment",
    confidence: "medium",
    updatedAt: "2026-09-01T00:00:00.000Z",
    sources: ["run-1234"],
    ...overrides,
  };
}

describe("WorldModel portfolio", () => {
  it("round-trips an entry", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry());
    expect(await f.world.readPortfolio()).toEqual([entry()]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  // The bound on this file is the number of live products. If upsert appended
  // instead of replacing, every review would grow it forever and the overseer
  // would eventually be unable to read its own portfolio.
  it("replaces a section with the same slug rather than appending", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry());
    await f.world.upsertPortfolioEntry(entry({ status: "killed", monthlyCostUsd: 0 }));

    const all = await f.world.readPortfolio();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("killed");
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("keeps entries with different slugs side by side", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry({ slug: "a" }));
    await f.world.upsertPortfolioEntry(entry({ slug: "b" }));
    expect((await f.world.readPortfolio()).map((e) => e.slug)).toEqual(["a", "b"]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("returns an empty portfolio before anything has been written", async () => {
    const f = fixture();
    expect(await f.world.readPortfolio()).toEqual([]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});

describe("WorldModel shelf", () => {
  it("round-trips a shelf item", async () => {
    const f = fixture();
    await f.world.addShelfItem(shelfItem());
    expect(await f.world.readShelf()).toEqual([shelfItem()]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("returns an empty shelf before anything has been written", async () => {
    const f = fixture();
    expect(await f.world.readShelf()).toEqual([]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("keeps multiple shelf items in the order they were added", async () => {
    const f = fixture();
    await f.world.addShelfItem(shelfItem({ summary: "first" }));
    await f.world.addShelfItem(shelfItem({ summary: "second" }));
    expect((await f.world.readShelf()).map((s) => s.summary)).toEqual(["first", "second"]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});

describe("WorldModel findings", () => {
  it("returns null for an unknown topic", async () => {
    const f = fixture();
    expect(await f.world.readFinding("unknown-topic")).toBeNull();
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("round-trips a finding's current conclusion", async () => {
    const f = fixture();
    await f.world.writeFinding("pricing-strategy", finding());
    expect(await f.world.readFinding("pricing-strategy")).toEqual(finding());
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("replaces the current conclusion on a second write", async () => {
    const f = fixture();
    await f.world.writeFinding("pricing-strategy", finding());
    const updated = finding({ conclusion: "Flat monthly wins once support cost is included", confidence: "high" });
    await f.world.writeFinding("pricing-strategy", updated);
    expect(await f.world.readFinding("pricing-strategy")).toEqual(updated);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  // Distinguishes "we rejected this" from "we rejected this, but the world
  // has changed" — the superseded conclusion must stay legible, not vanish.
  it("moves the superseded conclusion into history rather than discarding it", async () => {
    const f = fixture();
    const original = finding();
    await f.world.writeFinding("pricing-strategy", original);
    await f.world.writeFinding("pricing-strategy", finding({ conclusion: "Flat monthly wins now" }));

    const path = join(f.dataDir, "world", "findings", "pricing-strategy.md");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("## History");
    const historyIndex = text.indexOf("## History");
    expect(text.slice(historyIndex)).toContain(original.conclusion);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});

describe("WorldModel summaryForPrompt", () => {
  it("includes portfolio slugs and statuses, shelf summaries, and current finding conclusions but not finding history", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry({ slug: "widget-api", status: "live" }));
    await f.world.upsertPortfolioEntry(entry({ slug: "gizmo-app", status: "paused" }));
    await f.world.addShelfItem(shelfItem({ summary: "Chrome extension for widget tracking" }));
    await f.world.writeFinding(
      "pricing-strategy",
      finding({ conclusion: "Usage-based pricing outperforms flat monthly for this segment" }),
    );
    await f.world.writeFinding("pricing-strategy", finding({ conclusion: "Flat monthly wins once support cost is included" }));

    const summary = await f.world.summaryForPrompt();

    expect(summary).toContain("widget-api");
    expect(summary).toContain("live");
    expect(summary).toContain("gizmo-app");
    expect(summary).toContain("paused");
    expect(summary).toContain("Chrome extension for widget tracking");
    expect(summary).toContain("pricing-strategy");
    expect(summary).toContain("Flat monthly wins once support cost is included");
    expect(summary).not.toContain("Usage-based pricing outperforms flat monthly for this segment");

    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("produces a bounded, non-throwing digest before anything has been written", async () => {
    const f = fixture();
    await expect(f.world.summaryForPrompt()).resolves.toEqual(expect.any(String));
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});
