import type { RevenueTransport, Sale } from "./revenue-transport.js";

const REQUEST_TIMEOUT_MS = 30_000;

interface StripeCharge {
  id: string;
  amount: number;
  created: number;
  description: string | null;
  status: string;
}

/**
 * Reads completed sales from Stripe's Charges API — the same underlying
 * object whether the account is classic Stripe or Managed Payments, which
 * runs on Stripe's own infrastructure. `product` is read from the charge's
 * `description`, since a Charge has no separate product field without
 * expanding line items; once a real checkout flow exists, revisit this
 * mapping against what it actually sets. `amountUsd` is `amount / 100`
 * (Stripe amounts are in the smallest currency unit) with no currency
 * conversion — a non-USD charge is reported at face value in its own
 * currency's major unit, not converted to USD.
 */
export class StripeRevenueTransport implements RevenueTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly opts: { token: string; apiBase?: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? "https://api.stripe.com";
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}` };
  }

  async listSales(sinceIso: string): Promise<Sale[]> {
    const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
    const sales: Sale[] = [];
    let startingAfter: string | undefined;

    for (;;) {
      const url = new URL(`${this.apiBase}/v1/charges`);
      url.searchParams.set("limit", "100");
      url.searchParams.set("created[gte]", String(sinceUnix));
      if (startingAfter) url.searchParams.set("starting_after", startingAfter);

      const res = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Stripe API: failed to list charges (${res.status})`);
      const body = (await res.json()) as { data: StripeCharge[]; has_more: boolean };

      for (const charge of body.data) {
        if (charge.status !== "succeeded") continue;
        sales.push({
          id: charge.id,
          product: charge.description ?? charge.id,
          timestampIso: new Date(charge.created * 1000).toISOString(),
          amountUsd: charge.amount / 100,
        });
      }

      if (!body.has_more || body.data.length === 0) break;
      startingAfter = body.data[body.data.length - 1]?.id;
    }

    return sales.sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : a.timestampIso > b.timestampIso ? 1 : 0));
  }
}
