import { describe, expect, it, vi } from "vitest";
import { StripeRevenueTransport } from "../src/control/stripe-revenue-transport.js";

/** A minimal Response-shaped stub — only the members StripeRevenueTransport reads. */
function fakeResponse(opts: { ok?: boolean; status?: number; json?: unknown }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
  } as unknown as Response;
}

function charge(overrides: Record<string, unknown> = {}) {
  return { id: "ch_1", amount: 900, created: 1_764_000_000, description: "widget", status: "succeeded", ...overrides };
}

describe("StripeRevenueTransport.listSales", () => {
  it("maps a succeeded charge to a Sale", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: { data: [charge()], has_more: false } })) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales).toEqual([
      { id: "ch_1", product: "widget", timestampIso: new Date(1_764_000_000 * 1000).toISOString(), amountUsd: 9 },
    ]);
  });

  it("falls back to the charge id as product when description is null", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ json: { data: [charge({ description: null })], has_more: false } }),
    ) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales[0]?.product).toBe("ch_1");
  });

  it("excludes charges that are not succeeded", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        json: { data: [charge({ id: "ch_ok", status: "succeeded" }), charge({ id: "ch_failed", status: "failed" })], has_more: false },
      }),
    ) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales.map((s) => s.id)).toEqual(["ch_ok"]);
  });

  it("sends since as a created[gte] filter derived from sinceIso", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: { data: [], has_more: false } })) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl, apiBase: "https://api.stripe.com" });

    await t.listSales("2026-01-01T00:00:00.000Z");

    const calledUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe("/v1/charges");
    expect(calledUrl.searchParams.get("created[gte]")).toBe(String(Math.floor(new Date("2026-01-01T00:00:00.000Z").getTime() / 1000)));
  });

  it("paginates via starting_after until has_more is false", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      call += 1;
      if (call === 1) {
        expect(new URL(String(url)).searchParams.get("starting_after")).toBeNull();
        return fakeResponse({ json: { data: [charge({ id: "ch_page1" })], has_more: true } });
      }
      expect(new URL(String(url)).searchParams.get("starting_after")).toBe("ch_page1");
      return fakeResponse({ json: { data: [charge({ id: "ch_page2" })], has_more: false } });
    }) as unknown as typeof fetch;

    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl });
    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales.map((s) => s.id).sort()).toEqual(["ch_page1", "ch_page2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns sales oldest first regardless of Stripe's newest-first page order", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        json: {
          data: [charge({ id: "later", created: 1_764_100_000 }), charge({ id: "earlier", created: 1_764_000_000 })],
          has_more: false,
        },
      }),
    ) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl });

    const sales = await t.listSales("2026-01-01T00:00:00.000Z");

    expect(sales.map((s) => s.id)).toEqual(["earlier", "later"]);
  });

  it("throws with the status code when Stripe rejects the request", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 401 })) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "bad", fetchImpl });

    await expect(t.listSales("2026-01-01T00:00:00.000Z")).rejects.toThrow(/401/);
  });

  it("defaults apiBase to https://api.stripe.com when not given", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: { data: [], has_more: false } })) as unknown as typeof fetch;
    const t = new StripeRevenueTransport({ token: "sk_test_x", fetchImpl });

    await t.listSales("2026-01-01T00:00:00.000Z");

    const calledUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]));
    expect(calledUrl.origin).toBe("https://api.stripe.com");
  });
});
