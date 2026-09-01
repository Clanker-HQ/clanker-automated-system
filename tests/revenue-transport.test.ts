import { describe, expect, it } from "vitest";
import { FakeRevenueTransport } from "../src/control/revenue-transport.js";

describe("FakeRevenueTransport", () => {
  it("returns an empty list when nothing has been seeded", async () => {
    const transport = new FakeRevenueTransport();
    expect(await transport.listSales("2026-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("returns only sales at or after sinceIso", async () => {
    const transport = new FakeRevenueTransport();
    transport.seedSale({ id: "s1", product: "widget", timestampIso: "2026-01-01T00:00:00.000Z", amountUsd: 9 });
    transport.seedSale({ id: "s2", product: "widget", timestampIso: "2026-06-01T00:00:00.000Z", amountUsd: 9 });

    const sales = await transport.listSales("2026-03-01T00:00:00.000Z");
    expect(sales.map((s) => s.id)).toEqual(["s2"]);
  });

  it("includes a sale exactly at sinceIso (boundary is inclusive)", async () => {
    const transport = new FakeRevenueTransport();
    transport.seedSale({ id: "s1", product: "widget", timestampIso: "2026-03-01T00:00:00.000Z", amountUsd: 9 });

    expect(await transport.listSales("2026-03-01T00:00:00.000Z")).toHaveLength(1);
  });

  it("returns sales oldest first regardless of seed order", async () => {
    const transport = new FakeRevenueTransport();
    transport.seedSale({ id: "later", product: "widget", timestampIso: "2026-06-01T00:00:00.000Z", amountUsd: 9 });
    transport.seedSale({ id: "earlier", product: "widget", timestampIso: "2026-02-01T00:00:00.000Z", amountUsd: 9 });

    const sales = await transport.listSales("2026-01-01T00:00:00.000Z");
    expect(sales.map((s) => s.id)).toEqual(["earlier", "later"]);
  });
});
