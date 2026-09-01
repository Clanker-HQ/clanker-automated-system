import { describe, expect, it, vi } from "vitest";
import { LemonSqueezyRevenueTransport } from "../src/control/lemonsqueezy-revenue-transport.js";

/** A minimal Response-shaped stub — only the members the transport reads. */
function fakeResponse(opts: { ok?: boolean; status?: number; json?: unknown }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
  } as unknown as Response;
}

function order(attributes: Record<string, unknown> = {}, id = "1") {
  return {
    type: "orders",
    id,
    attributes: {
      identifier: "3b1c-order",
      order_number: 41,
      total: 900,
      currency: "USD",
      status: "paid",
      created_at: "2026-06-01T12:00:00.000000Z",
      first_order_item: { product_name: "Widget", variant_name: "Pro" },
      ...attributes,
    },
  };
}

/** Lemon Squeezy returns orders newest-first; `links.next` is absent on the last page. */
function page(orders: unknown[], next?: string) {
  return { data: orders, links: next ? { next } : {} };
}

describe("LemonSqueezyRevenueTransport.listSales", () => {
  it("maps a paid order to a Sale", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: page([order()]) })) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales).toEqual([
      { id: "1", product: "Widget", timestampIso: "2026-06-01T12:00:00.000Z", amountUsd: 9 },
    ]);
  });

  it("excludes orders that are not paid", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        json: page([
          order({ status: "pending" }, "1"),
          order({ status: "refunded" }, "2"),
          order({ status: "failed" }, "3"),
        ]),
      }),
    ) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    expect(await t.listSales("2026-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("sends the JSON:API Accept header and the bearer token", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: page([]) })) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    await t.listSales("2026-01-01T00:00:00.000Z");

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.api+json");
    expect(headers.authorization).toBe("Bearer ls_test_x");
  });

  it("requests the orders endpoint on the Lemon Squeezy API base by default", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: page([]) })) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    await t.listSales("2026-01-01T00:00:00.000Z");

    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toContain("https://api.lemonsqueezy.com/v1/orders");
  });

  it("stops paginating once an order predates the window", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        json: page(
          [
            order({ created_at: "2026-06-01T12:00:00.000000Z" }, "2"),
            order({ created_at: "2025-01-01T12:00:00.000000Z" }, "1"),
          ],
          "https://api.lemonsqueezy.com/v1/orders?page%5Bnumber%5D=2",
        ),
      }),
    ) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales.map((s) => s.id)).toEqual(["2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows links.next while every order is still inside the window", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          json: page([order({ created_at: "2026-06-02T12:00:00.000000Z" }, "2")], "https://api.lemonsqueezy.com/v1/orders?page%5Bnumber%5D=2"),
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ json: page([order({ created_at: "2026-06-01T12:00:00.000000Z" }, "1")]) })) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales.map((s) => s.id)).toEqual(["1", "2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns sales oldest-first even though the API returns them newest-first", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        json: page([
          order({ created_at: "2026-06-03T12:00:00.000000Z" }, "3"),
          order({ created_at: "2026-06-02T12:00:00.000000Z" }, "2"),
        ]),
      }),
    ) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    expect((await t.listSales("2026-01-01T00:00:00.000Z")).map((s) => s.id)).toEqual(["2", "3"]);
  });

  it("falls back to the order identifier when the line item carries no product name", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ json: page([order({ first_order_item: undefined })]) }),
    ) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "ls_test_x", fetchImpl });

    expect((await t.listSales("2026-01-01T00:00:00.000Z"))[0]?.product).toBe("3b1c-order");
  });

  it("throws when the API rejects the request", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 401 })) as unknown as typeof fetch;
    const t = new LemonSqueezyRevenueTransport({ token: "bad", fetchImpl });

    await expect(t.listSales("2026-01-01T00:00:00.000Z")).rejects.toThrow(/401/);
  });
});
