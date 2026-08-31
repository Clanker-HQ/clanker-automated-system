export interface Sale {
  id: string;
  product: string;
  timestampIso: string;
  amountUsd: number;
}

/**
 * Read access to a merchant-of-record's per-sale records (Lemon Squeezy /
 * Gumroad / Stripe) — the one metric grounded outside the system's own
 * reporting (docs/superpowers/specs/2026-08-30-self-evaluation-design.md,
 * "Metrics"). No real implementation exists yet: REVENUE_API_TOKEN /
 * REVENUE_API_BASE are scaffolded in .env.example but unread by any code,
 * and the operator hasn't opened a merchant-of-record account yet. Writing
 * a real HTTP client against a guessed response shape before that account
 * exists risks shipping code nothing can verify. This interface — and
 * FakeRevenueTransport below — are what the weekly metrics job (a follow-up
 * plan) is written against, so that work can proceed without waiting on the
 * account. The real transport is a single new file implementing this same
 * interface once a provider is chosen; nothing that depends on the
 * interface needs to change when it lands.
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
