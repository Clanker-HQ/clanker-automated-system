export interface Sale {
  id: string;
  product: string;
  /** UTC, Z-suffixed ISO 8601 (e.g. "2026-06-01T00:00:00.000Z") — FakeRevenueTransport compares these as strings, which is only chronologically correct in this exact format. */
  timestampIso: string;
  amountUsd: number;
}

/**
 * Read access to a merchant-of-record's per-sale records (Lemon Squeezy /
 * Gumroad / Stripe) — the one metric grounded outside the system's own
 * reporting (docs/superpowers/specs/2026-08-30-self-evaluation-design.md,
 * "Metrics"). This interface and FakeRevenueTransport below were written
 * before any real merchant-of-record account existed, so the weekly
 * metrics job could be built and tested against the fake without waiting
 * on that account — writing a real HTTP client against a guessed response
 * shape before the account exists would have risked shipping code nothing
 * could verify.
 *
 * Two real implementations now exist: LemonSqueezyRevenueTransport
 * (src/control/lemonsqueezy-revenue-transport.ts), reading the Orders API of
 * the merchant of record the operator actually set up, and
 * StripeRevenueTransport (src/control/stripe-revenue-transport.ts), reading
 * Stripe's Charges API. Both are wired into the weekly metrics job
 * (src/metrics.ts, scheduled by src/triggers/metrics.ts) via src/index.ts,
 * which picks between them on `revenue.provider` in config.yaml when
 * REVENUE_API_TOKEN is set, and falls back to FakeRevenueTransport when it's
 * absent. Nothing that depends on this interface needed to change when
 * either real transport landed.
 *
 * The provider is configured rather than inferred because runMetricsJob
 * deliberately catches a revenue failure (one outage must not lose the whole
 * snapshot) — so a transport pointed at the wrong API does not raise, it
 * reports $0 income indefinitely. `Metrics.revenueUnavailable` exists to keep
 * that case distinguishable from a genuine $0 in the digest.
 */
export interface RevenueTransport {
  /** Every completed sale at or after sinceIso (inclusive), oldest first. */
  listSales(sinceIso: string): Promise<Sale[]>;
}

export class FakeRevenueTransport implements RevenueTransport {
  private sales: Sale[] = [];

  seedSale(sale: Sale): void {
    this.sales.push(sale);
  }

  async listSales(sinceIso: string): Promise<Sale[]> {
    return this.sales
      .filter((s) => s.timestampIso >= sinceIso)
      .sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : a.timestampIso > b.timestampIso ? 1 : 0));
  }
}
