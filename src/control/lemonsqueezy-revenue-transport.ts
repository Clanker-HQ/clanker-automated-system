import type { RevenueTransport, Sale } from "./revenue-transport.js";

const REQUEST_TIMEOUT_MS = 30_000;
/** Lemon Squeezy's own maximum for `page[size]`; fewer pages means fewer round trips. */
const PAGE_SIZE = 100;

interface LemonSqueezyOrder {
  id: string;
  attributes: {
    identifier?: string;
    total: number;
    status: string;
    created_at: string;
    first_order_item?: { product_name?: string };
  };
}

/**
 * Reads completed sales from Lemon Squeezy's Orders API — the merchant of
 * record the operator actually set up (`.env.example`, "Revenue instrument").
 *
 * Written as a second transport rather than a generalisation of
 * StripeRevenueTransport because nothing about the two lines up: JSON:API's
 * nested `data[].attributes` versus Stripe's flat objects, `page[number]`
 * pagination versus `starting_after`, and a required
 * `Accept: application/vnd.api+json` that Stripe neither sends nor tolerates.
 * A shared client parameterised over all of that would be longer than both.
 *
 * `amountUsd` is `attributes.total / 100` (Lemon Squeezy amounts are in the
 * smallest currency unit) with no currency conversion — a non-USD order is
 * reported at face value in its own currency's major unit, the same caveat
 * StripeRevenueTransport carries.
 */
export class LemonSqueezyRevenueTransport implements RevenueTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly opts: { token: string; apiBase?: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? "https://api.lemonsqueezy.com";
  }

  private headers(): Record<string, string> {
    // `accept` is not optional politeness here: without the JSON:API media
    // type Lemon Squeezy answers 406 rather than the order list.
    return { authorization: `Bearer ${this.opts.token}`, accept: "application/vnd.api+json" };
  }

  async listSales(sinceIso: string): Promise<Sale[]> {
    const since = new Date(sinceIso).getTime();
    const sales: Sale[] = [];

    const first = new URL(`${this.apiBase}/v1/orders`);
    first.searchParams.set("page[size]", String(PAGE_SIZE));
    let next: string | undefined = first.toString();

    while (next) {
      const res = await this.fetchImpl(next, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Lemon Squeezy API: failed to list orders (${res.status})`);
      const body = (await res.json()) as { data: LemonSqueezyOrder[]; links?: { next?: string } };

      // Orders come back newest-first, so the first one older than the window
      // means every order after it is older too — stop rather than page back
      // through the account's entire history. The cutoff is checked on every
      // order regardless of status: a page of nothing but refunded orders
      // still tells us how far back we have paged.
      let reachedCutoff = false;
      for (const order of body.data) {
        const createdMs = new Date(order.attributes.created_at).getTime();
        if (createdMs < since) {
          reachedCutoff = true;
          break;
        }
        if (order.attributes.status !== "paid") continue;
        sales.push({
          id: order.id,
          product: order.attributes.first_order_item?.product_name ?? order.attributes.identifier ?? order.id,
          timestampIso: new Date(order.attributes.created_at).toISOString(),
          amountUsd: order.attributes.total / 100,
        });
      }

      if (reachedCutoff || body.data.length === 0) break;
      next = body.links?.next;
    }

    return sales.sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : a.timestampIso > b.timestampIso ? 1 : 0));
  }
}
