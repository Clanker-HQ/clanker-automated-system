import type { Sale } from "../control/revenue-transport.js";
import type { Metrics } from "../state/metrics-store.js";
import type { Expectation } from "./strategy.js";
import type { PortfolioEntry } from "./world-model.js";

export interface GradeInput {
  expectations: Expectation[];
  metrics: Metrics | null;
  salesInWindow: Sale[];
  portfolio: PortfolioEntry[];
  now: Date;
}

export interface Verdict {
  expectationId: string;
  outcome: "met" | "missed" | "not-yet-due" | "ungradeable";
  detail: string;
}

/**
 * Independent grader for the overseer's own predictions (see Design §3 in
 * the autonomous-operation plan) — mirrors OutcomeVerifier's shape (a
 * verdict is data, not prose) but is pure and synchronous: everything it
 * needs is already in GradeInput, so being wrong about the world is
 * detectable by a diff, not by re-reading an LLM's self-assessment.
 */
export function gradeExpectations(input: GradeInput): Verdict[] {
  return input.expectations.map((expectation) => gradeOne(expectation, input));
}

function gradeOne(expectation: Expectation, input: GradeInput): Verdict {
  const { id, dueAt, check } = expectation;
  if (input.now < new Date(dueAt)) {
    return { expectationId: id, outcome: "not-yet-due", detail: `due ${dueAt}, not yet reached` };
  }

  switch (check.kind) {
    case "netIncomeUsd":
      return gradeNetIncome(id, check.atLeast, input.metrics);
    case "productRevenueUsd":
      return gradeProductRevenue(id, check.product, check.atLeast, input.salesInWindow);
    case "portfolioStatus":
      return gradePortfolioStatus(id, check.slug, check.is, input.portfolio);
  }
}

function gradeNetIncome(id: string, atLeast: number, metrics: Metrics | null): Verdict {
  if (metrics === null) {
    return { expectationId: id, outcome: "ungradeable", detail: "no metrics snapshot available" };
  }
  // A revenue-read outage reports netIncomeUsd as 0, identically to a
  // genuine no-sales week. Scoring that as "missed" would teach the
  // overseer that a working strategy failed, so it must be distinguished
  // via Metrics.revenueUnavailable rather than the number itself.
  if (metrics.revenueUnavailable) {
    return { expectationId: id, outcome: "ungradeable", detail: "revenue transport failed; netIncomeUsd is not a real reading" };
  }
  const actual = metrics.netIncomeUsd;
  return actual >= atLeast
    ? { expectationId: id, outcome: "met", detail: `netIncomeUsd ${actual} >= ${atLeast}` }
    : { expectationId: id, outcome: "missed", detail: `netIncomeUsd ${actual} < ${atLeast}` };
}

function gradeProductRevenue(id: string, product: string, atLeast: number, salesInWindow: Sale[]): Verdict {
  // Sale.product is currently read from a Stripe charge's `description`
  // field (src/control/stripe-revenue-transport.ts), which was never
  // designed to carry a product identifier and predates any real checkout
  // flow — so a slug set here may not match anything a sale actually
  // reports. Grade what the data says; inventing fuzzy matching would hide
  // that gap instead of surfacing it.
  const actual = salesInWindow
    .filter((sale) => sale.product === product)
    .reduce((sum, sale) => sum + sale.amountUsd, 0);
  return actual >= atLeast
    ? { expectationId: id, outcome: "met", detail: `${product} revenue ${actual} >= ${atLeast}` }
    : { expectationId: id, outcome: "missed", detail: `${product} revenue ${actual} < ${atLeast}` };
}

function gradePortfolioStatus(id: string, slug: string, expectedStatus: PortfolioEntry["status"], portfolio: PortfolioEntry[]): Verdict {
  const entry = portfolio.find((p) => p.slug === slug);
  if (!entry) {
    return { expectationId: id, outcome: "ungradeable", detail: `no portfolio entry for slug "${slug}"` };
  }
  return entry.status === expectedStatus
    ? { expectationId: id, outcome: "met", detail: `${slug} status is ${entry.status}` }
    : { expectationId: id, outcome: "missed", detail: `${slug} status is ${entry.status}, expected ${expectedStatus}` };
}
