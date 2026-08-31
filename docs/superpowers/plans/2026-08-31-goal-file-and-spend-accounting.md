# Goal file, spend accounting, and revenue-transport interface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation pieces of subsystem 2's build-order step 3 —
the `goals.yaml` schema/loader, its `EXCLUDED_PATHS` entry, a spend-accounting
engine for a prepaid-card `provision` grant, and a `RevenueTransport`
interface (with a fake) that a later metrics job will read from.

**Architecture:** Four independent, small modules, each following an
already-established pattern in this codebase rather than inventing a new one:
`src/goals.ts` mirrors `src/config.ts`'s parse/load split; the `EXCLUDED_PATHS`
change extends the existing array+test; `src/state/spend-store.ts` mirrors
`src/state/breaker.ts`'s read/write-JSON-with-default-on-miss shape;
`src/spend/spend-accounting.ts` mirrors `src/control/self-build-gate.ts`'s
pure-function-plus-thin-integration split; `src/control/revenue-transport.ts`
mirrors `src/control/github-transport.ts`'s interface+fake pattern.

**Tech Stack:** TypeScript, zod, the `yaml` package, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`
(read in full — "The goal file", "What is fixed, and what that costs", "The
spend pot", "What the pot is and is not for", and "Testing" sections are what
this plan implements). Also touches `docs/superpowers/specs/2026-08-30-self-build-design.md`
indirectly (the self-build gate already treats `EXCLUDED_PATHS` additions as
ordinary excluded-file changes — no self-build-gate code changes here).

## Global Constraints

- No new npm dependencies. Everything needed (`zod`, `yaml`, `node:fs`,
  `node:crypto`) is already a dependency.
- Every new/modified `.ts` file uses ESM `.js` import specifiers
  (`from "./foo.js"`), matching every existing file in `src/`.
- **This plan never creates a real `goals.yaml` at the repo root.** The spec
  is explicit that the system "may propose a revision with evidence at any
  time; it may never author one" — the file's first authorship is the
  operator's one-time bootstrap step, not this plan's. Tests use fixture
  strings or temp files under `tests/`/OS temp dirs, never
  `<repo-root>/goals.yaml`.
- Money amounts are plain `number` (USD, whole-dollar or fractional — no
  cents-as-integer convention, no currency library). This is bookkeeping for
  observability; the real ceiling is enforced by the bank/card outside this
  codebase (see spec, "The spend pot" and "`limit.perDay` cannot be relied
  on").
- **The real HTTP client for a merchant-of-record API (Lemon Squeezy /
  Gumroad / Stripe) is explicitly OUT of scope for this plan.** Build only
  the `RevenueTransport` interface and `FakeRevenueTransport`. No account
  exists yet to verify a real provider's response shape against, and the
  operator hasn't chosen one — writing that adapter now would be guessing at
  field names for code nothing can exercise. It is Task 1 of the follow-up
  metrics-job plan, written once a provider is chosen.
- Every task: `npm test` and `npm run typecheck` must both pass before
  committing.
- Cited line numbers below are accurate as of this plan's writing but may
  drift — locate insertion points by matching the surrounding code shown,
  not by trusting the number alone.

---

### Task 1: Goal file schema and loader

**Files:**
- Create: `src/goals.ts`
- Test: `tests/goals.test.ts`

**Interfaces:**
- Consumes: `ValidationError`, `formatZodError` from `src/errors.ts` (existing).
- Produces: `export interface Goals { primary: { id: string; statement: string }; secondary: { id: string; instrumental: true; statement: string }; means: string[] }`, `export function parseGoals(source: string, yamlText: string): Goals`, `export function loadGoals(path: string): Goals | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/goals.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { loadGoals, parseGoals } from "../src/goals.js";

const VALID = `
primary:
  id: revenue
  statement: Generate real, recurring income for the operator.

secondary:
  id: capability
  instrumental: true
  statement: Improve this system's own capability, reliability and reach.

means:
  - Legal in the operator's jurisdiction and in any market touched.
  - No violation of any service's terms of service.
`;

describe("parseGoals", () => {
  it("parses a valid goals document", () => {
    const goals = parseGoals("goals.yaml", VALID);
    expect(goals.primary).toEqual({ id: "revenue", statement: "Generate real, recurring income for the operator." });
    expect(goals.secondary.instrumental).toBe(true);
    expect(goals.means).toHaveLength(2);
  });

  it("rejects invalid YAML syntax", () => {
    expect(() => parseGoals("goals.yaml", "primary: [")).toThrow(ValidationError);
  });

  it("rejects a document missing primary", () => {
    const yaml = VALID.replace(/primary:[\s\S]*?statement: Generate real, recurring income for the operator\.\n\n/, "");
    expect(() => parseGoals("goals.yaml", yaml)).toThrow(ValidationError);
  });

  it("rejects secondary.instrumental: false", () => {
    const yaml = VALID.replace("instrumental: true", "instrumental: false");
    expect(() => parseGoals("goals.yaml", yaml)).toThrow(ValidationError);
  });

  it("rejects an empty means list", () => {
    const yaml = VALID.replace(/means:[\s\S]*/, "means: []\n");
    expect(() => parseGoals("goals.yaml", yaml)).toThrow(ValidationError);
  });

  it("rejects an unrecognised top-level key, naming it", () => {
    const yaml = VALID + "\nextra: field\n";
    try {
      parseGoals("goals.yaml", yaml);
      expect.fail("expected parseGoals to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).lines.join(" ")).toMatch(/extra/);
    }
  });
});

describe("loadGoals", () => {
  const dir = mkdtempSync(join(tmpdir(), "cai-goals-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    expect(loadGoals(join(dir, "does-not-exist.yaml"))).toBeNull();
  });

  it("returns the parsed goals when the file exists and is valid", () => {
    const path = join(dir, "present.yaml");
    writeFileSync(path, VALID);
    expect(loadGoals(path)?.primary.id).toBe("revenue");
  });

  it("throws (does not silently return null) when the file exists but is malformed", () => {
    const path = join(dir, "malformed.yaml");
    writeFileSync(path, "primary: [\n");
    expect(() => loadGoals(path)).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- goals`
Expected: FAIL — `Cannot find module '../src/goals.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/goals.ts
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "./errors.js";

const GoalsSchema = z
  .object({
    primary: z.object({ id: z.string().min(1), statement: z.string().min(1) }).strict(),
    secondary: z
      .object({ id: z.string().min(1), instrumental: z.literal(true), statement: z.string().min(1) })
      .strict(),
    means: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Goals = z.infer<typeof GoalsSchema>;

export function parseGoals(source: string, yamlText: string): Goals {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (error) {
    throw new ValidationError(source, [`is not valid YAML: ${(error as Error).message}`]);
  }

  const result = GoalsSchema.safeParse(raw);
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

/**
 * Returns null when the file does not exist yet. Unlike config.yaml,
 * goals.yaml is legitimately absent until the operator completes the
 * one-time bootstrap step in docs/superpowers/specs/2026-08-30-self-evaluation-design.md
 * ("Operator bootstrap: Write goals.yaml"). A file that exists but is
 * malformed still throws — only genuine absence is a valid, quiet state.
 */
export function loadGoals(path: string): Goals | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ValidationError(path, [
      `it could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`,
    ]);
  }
  return parseGoals(path, text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- goals`
Expected: PASS, all 9 tests (6 in `parseGoals`, 3 in `loadGoals`).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/goals.ts tests/goals.test.ts
git commit -m "feat: add goals.yaml schema and loader"
```

---

### Task 2: Exclude goals.yaml from the merge pipeline

**Files:**
- Modify: `src/control/excluded-paths.ts`
- Modify: `tests/excluded-paths.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `"goals.yaml"` becomes a member of `EXCLUDED_PATHS`.

- [ ] **Step 1: Write the failing test**

Extend the exact-equality assertion in `tests/excluded-paths.test.ts` (the
`it("the excluded set names exactly the files this plan specifies", ...)`
block) to include `"goals.yaml"` in the expected array, positioned with the
other parent governance files:

```ts
  it("the excluded set names exactly the files this plan specifies", () => {
    expect(EXCLUDED_PATHS).toEqual([
      // The parent governance files.
      "src/governor.ts",
      "src/grants.ts",
      "src/agent-schema.ts",
      "src/control/bot.ts",
      "grants.yaml",
      "config.yaml",
      "goals.yaml",
      // This pipeline's own safety rails — a pipeline able to merge changes
      // to its own gates is a pipeline with no gates.
      "src/control/excluded-paths.ts",
      "src/runner/sdk-runner.ts",
      "src/control/git-pusher.ts",
      "src/control/webhook-signature.ts",
      "src/control/webhook-wiring.ts",
      "src/control/webhook-receiver.ts",
      "src/runner/credentials.ts",
      "src/index.ts",
      ".github/workflows/ci.yml",
    ]);
  });
```

Also add a dedicated regression test just below the existing "flags the
pipeline's own implementation files" block:

```ts
  it("flags a change to goals.yaml, the same as grants.yaml and config.yaml", () => {
    expect(touchesExcludedPath(["goals.yaml"])).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- excluded-paths`
Expected: FAIL — the exact-equality assertion mismatches (actual array
lacks `"goals.yaml"`), and the new dedicated test fails (`touchesExcludedPath`
returns `false`).

- [ ] **Step 3: Update the implementation**

In `src/control/excluded-paths.ts`, add `"goals.yaml"` to `EXCLUDED_PATHS`
right after `"config.yaml"`:

```ts
export const EXCLUDED_PATHS: readonly string[] = [
  // The parent governance files.
  "src/governor.ts",
  "src/grants.ts",
  "src/agent-schema.ts",
  "src/control/bot.ts",
  "grants.yaml",
  "config.yaml",
  "goals.yaml",
  // This pipeline's own safety rails.
  "src/control/excluded-paths.ts",
  "src/runner/sdk-runner.ts",
  "src/control/git-pusher.ts",
  "src/control/webhook-signature.ts",
  "src/control/webhook-wiring.ts",
  "src/control/webhook-receiver.ts",
  "src/runner/credentials.ts",
  "src/index.ts",
  ".github/workflows/ci.yml",
];
```

Update the file's leading doc comment: in the "1. The parent governance
files" bullet, add `grants.yaml`, `config.yaml`) list — extend it to read
`` `src/governor.ts`, `src/grants.ts`, `src/agent-schema.ts`, `src/control/bot.ts`, `grants.yaml`, `config.yaml`, `goals.yaml`) `` — and append one sentence
after the `config.yaml` justification paragraph:

```
 *
 * `goals.yaml` is excluded for a different reason than the others: it is not
 * a safety rail this pipeline enforces on itself, but the fixed reference
 * point subsystem 2 measures the system against. A system that could revise
 * its own goal does not grow, it drifts — see
 * docs/superpowers/specs/2026-08-30-self-evaluation-design.md ("What is
 * fixed, and what that costs"). The system may propose a revision with
 * evidence; it may never author one, which is exactly what this exclusion
 * enforces mechanically.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- excluded-paths`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green — no other test hardcodes the old `EXCLUDED_PATHS`
contents (the self-build-gate tests only check specific paths, not the full
array).

- [ ] **Step 6: Commit**

```bash
git add src/control/excluded-paths.ts tests/excluded-paths.test.ts
git commit -m "feat: exclude goals.yaml from the merge pipeline"
```

---

### Task 3: Add a spend-card provision resource

**Files:**
- Modify: `src/grants.ts`
- Modify: `tests/grants.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Grant`'s `provision` variant now accepts `resource: "spend-card"` in addition to the three existing values.

- [ ] **Step 1: Write the failing test**

Add to `tests/grants.test.ts`, near the existing `it("parses a provision grant", ...)` block:

```ts
  it("parses a provision grant for a spend card", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: spend-pot\n    kind: provision\n    resource: spend-card\n    scope: spend-pot\n    limit: { perDay: 1 }\n    secret: SPEND_CARD_NUMBER\n",
    );
    expect(grants[0]).toMatchObject({ kind: "provision", resource: "spend-card" });
  });

  it("rejects an unknown provision resource, naming spend-card as a legal value", () => {
    const yaml =
      "grants:\n  - id: spend-pot\n    kind: provision\n    resource: bank-account\n    scope: spend-pot\n    limit: { perDay: 1 }\n    secret: X\n";
    try {
      parseGrants("grants.yaml", yaml);
      expect.fail("expected parseGrants to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).lines.join(" ")).toMatch(/spend-card/);
    }
  });
```

(`ValidationError` is already imported at the top of `tests/grants.test.ts` — confirm, and add the import only if it is missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- grants`
Expected: FAIL — `resource: "spend-card"` is rejected by the current enum
(`Legal values: "github-repo", "host-site", "dns-subdomain"`, no
`"spend-card"`), so the first new test fails and the second passes for the
wrong reason (it already throws, just not yet naming `spend-card` as a legal
value — read the actual failure message to confirm the first test is the one
failing, not a false-pass on the second).

- [ ] **Step 3: Update the implementation**

In `src/grants.ts`, change the `ProvisionGrant` schema's `resource` field
(currently at approximately line 30):

```ts
const ProvisionGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("provision"),
    // "spend-card" backs the prepaid-card grant described in
    // docs/superpowers/specs/2026-08-30-self-evaluation-design.md ("The
    // spend pot") — the system holds card-spend credentials behind this
    // resource, never the account's own login.
    resource: z.enum(["github-repo", "host-site", "dns-subdomain", "spend-card"]),
    scope: z.string().min(1),
    limit: z.object({ perDay: z.number().int().positive() }).strict(),
    secret: z.string().min(1),
  })
  .strict();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- grants`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/grants.ts tests/grants.test.ts
git commit -m "feat: add spend-card as a provision grant resource"
```

---

### Task 4: SpendStore — persisted spend state

**Files:**
- Create: `src/state/spend-store.ts`
- Test: `tests/spend-store.test.ts`

**Interfaces:**
- Consumes: nothing new (mirrors `src/state/breaker.ts`'s shape).
- Produces: `export interface SpendCommitment { id: string; amountUsd: number; recurring: boolean; nextRenewalAt: string | null }`, `export interface SpendState { balanceUsd: number; commitments: SpendCommitment[] }`, `export class SpendStore { constructor(dataDir: string); read(): Promise<SpendState>; write(state: SpendState): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/spend-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpendStore } from "../src/state/spend-store.js";

function makeStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-spend-store-"));
  return { dataDir, store: new SpendStore(dataDir) };
}

describe("SpendStore", () => {
  it("returns a zero-balance, no-commitments default when nothing has been written yet", async () => {
    const { dataDir, store } = makeStore();
    expect(await store.read()).toEqual({ balanceUsd: 0, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a written state", async () => {
    const { dataDir, store } = makeStore();
    const state = {
      balanceUsd: 42.5,
      commitments: [{ id: "spend_a", amountUsd: 5, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    await store.write(state);
    expect(await store.read()).toEqual(state);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overwrites the previous state rather than merging", async () => {
    const { dataDir, store } = makeStore();
    await store.write({ balanceUsd: 10, commitments: [] });
    await store.write({ balanceUsd: 20, commitments: [] });
    expect(await store.read()).toEqual({ balanceUsd: 20, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates the state directory if it does not exist yet", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-spend-store-"));
    const store = new SpendStore(join(dataDir, "nested", "deeper"));
    await store.write({ balanceUsd: 1, commitments: [] });
    expect(await store.read()).toEqual({ balanceUsd: 1, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- spend-store`
Expected: FAIL — `Cannot find module '../src/state/spend-store.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/state/spend-store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SpendCommitment {
  id: string;
  amountUsd: number;
  recurring: boolean;
  /** ISO date string of the next renewal. Only meaningful when recurring is true. */
  nextRenewalAt: string | null;
}

export interface SpendState {
  balanceUsd: number;
  commitments: SpendCommitment[];
}

/**
 * One file, not per-agent like BreakerStore — there is exactly one spend
 * pot. balanceUsd is operator-declared at top-up time (see spec, "The spend
 * pot": the chosen provider, Revolut personal, has no read API), not fetched
 * from anywhere; this store is the system's own record of it plus its
 * outstanding commitments.
 */
export class SpendStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "spend.json");
  }

  async read(): Promise<SpendState> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as SpendState;
    } catch {
      return { balanceUsd: 0, commitments: [] };
    }
  }

  async write(state: SpendState): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFile(this.path(), JSON.stringify(state, null, 2) + "\n");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- spend-store`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/state/spend-store.ts tests/spend-store.test.ts
git commit -m "feat: add SpendStore for persisted spend-pot state"
```

---

### Task 5: Spend accounting — pure functions

**Files:**
- Create: `src/spend/spend-accounting.ts`
- Test: `tests/spend-accounting.test.ts`

**Interfaces:**
- Consumes: `SpendState`, `SpendCommitment` from `../state/spend-store.js` (Task 4).
- Produces: `export function availableToSpendUsd(state: SpendState): number`, `export function wouldExhaustBeforeRenewal(state: SpendState, candidate: SpendCommitment): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/spend-accounting.test.ts
import { describe, expect, it } from "vitest";
import { availableToSpendUsd, wouldExhaustBeforeRenewal } from "../src/spend/spend-accounting.js";
import type { SpendState } from "../src/state/spend-store.js";

describe("availableToSpendUsd", () => {
  it("equals the full balance when there are no commitments", () => {
    expect(availableToSpendUsd({ balanceUsd: 100, commitments: [] })).toBe(100);
  });

  it("subtracts a single recurring commitment", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 30, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    expect(availableToSpendUsd(state)).toBe(70);
  });

  it("sums multiple recurring commitments", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [
        { id: "a", amountUsd: 30, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" },
        { id: "b", amountUsd: 25, recurring: true, nextRenewalAt: "2026-10-15T00:00:00.000Z" },
      ],
    };
    expect(availableToSpendUsd(state)).toBe(45);
  });

  it("ignores non-recurring commitments (a one-off already reduced the balance directly)", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 30, recurring: false, nextRenewalAt: null }],
    };
    expect(availableToSpendUsd(state)).toBe(100);
  });
});

describe("wouldExhaustBeforeRenewal", () => {
  it("refuses a new recurring commitment that pushes total committed spend past the balance", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 90, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    const candidate = { id: "b", amountUsd: 20, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" };
    expect(wouldExhaustBeforeRenewal(state, candidate)).toBe(true);
  });

  it("allows a new recurring commitment that still fits", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 50, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    const candidate = { id: "b", amountUsd: 20, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" };
    expect(wouldExhaustBeforeRenewal(state, candidate)).toBe(false);
  });

  it("allows a commitment that lands exactly on the balance (boundary, not negative)", () => {
    const state: SpendState = {
      balanceUsd: 100,
      commitments: [{ id: "a", amountUsd: 80, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    };
    const candidate = { id: "b", amountUsd: 20, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" };
    expect(wouldExhaustBeforeRenewal(state, candidate)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- spend-accounting`
Expected: FAIL — `Cannot find module '../src/spend/spend-accounting.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/spend/spend-accounting.ts
import type { SpendCommitment, SpendState } from "../state/spend-store.js";

function committedRecurringUsd(state: SpendState): number {
  return state.commitments.filter((c) => c.recurring).reduce((sum, c) => sum + c.amountUsd, 0);
}

/**
 * balance − sum(committed recurring). A one-off spend already reduced
 * balanceUsd directly when it was recorded (see recordSpend, Task 6), so it
 * plays no further part here — only standing recurring draws do.
 */
export function availableToSpendUsd(state: SpendState): number {
  return state.balanceUsd - committedRecurringUsd(state);
}

/**
 * True when adding `candidate` as a new recurring commitment would leave the
 * balance unable to cover every committed recurring charge — i.e. it would
 * run out before some commitment's next renewal, not necessarily candidate's
 * own.
 */
export function wouldExhaustBeforeRenewal(state: SpendState, candidate: SpendCommitment): boolean {
  const withCandidate: SpendState = { ...state, commitments: [...state.commitments, candidate] };
  return availableToSpendUsd(withCandidate) < 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- spend-accounting`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/spend/spend-accounting.ts tests/spend-accounting.test.ts
git commit -m "feat: add pure spend-accounting functions"
```

---

### Task 6: recordSpend — wire accounting to the store and the memory log

**Files:**
- Modify: `src/spend/spend-accounting.ts`
- Modify: `tests/spend-accounting.test.ts`

**Interfaces:**
- Consumes: `SpendStore` (Task 4), `availableToSpendUsd`/`wouldExhaustBeforeRenewal` (Task 5, same file), `MemoryStore` from `../memory/memory-store.js` (existing).
- Produces: `export type SpendRequest = { amountUsd: number; recurring: boolean; nextRenewalAt: string | null; description: string; rationale: string; importance: number }`, `export type SpendResult = { recorded: true; state: SpendState } | { recorded: false; reason: string }`, `export async function recordSpend(store: SpendStore, memory: MemoryStore, request: SpendRequest): Promise<SpendResult>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/spend-accounting.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/memory-store.js";
import { SpendStore } from "../src/state/spend-store.js";
import { recordSpend } from "../src/spend/spend-accounting.js";

function fixtures() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-record-spend-"));
  return { dataDir, store: new SpendStore(dataDir), memory: new MemoryStore(dataDir) };
}

describe("recordSpend", () => {
  it("records a one-off spend within the available balance, reducing it", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 30,
      recurring: false,
      nextRenewalAt: null,
      description: "domain registration",
      rationale: "needed for HTTPS on the first product",
      importance: 5,
    });

    expect(result).toEqual({ recorded: true, state: { balanceUsd: 70, commitments: [] } });
    expect(await store.read()).toEqual({ balanceUsd: 70, commitments: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a one-off spend that exceeds the available balance, without touching state", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 10, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 30,
      recurring: false,
      nextRenewalAt: null,
      description: "domain registration",
      rationale: "needed for HTTPS",
      importance: 5,
    });

    expect(result.recorded).toBe(false);
    expect(await store.read()).toEqual({ balanceUsd: 10, commitments: [] });
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("records a recurring spend that fits, adding a commitment without reducing the balance", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    const result = await recordSpend(store, memory, {
      amountUsd: 15,
      recurring: true,
      nextRenewalAt: "2026-10-01T00:00:00.000Z",
      description: "hosting API credit",
      rationale: "backs the first product's usage-metered API calls",
      importance: 6,
    });

    expect(result.recorded).toBe(true);
    const state = await store.read();
    expect(state.balanceUsd).toBe(100);
    expect(state.commitments).toHaveLength(1);
    expect(state.commitments[0]).toMatchObject({ amountUsd: 15, recurring: true, nextRenewalAt: "2026-10-01T00:00:00.000Z" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a recurring spend that would exhaust the balance, adding no commitment", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({
      balanceUsd: 100,
      commitments: [{ id: "existing", amountUsd: 90, recurring: true, nextRenewalAt: "2026-09-30T00:00:00.000Z" }],
    });

    const result = await recordSpend(store, memory, {
      amountUsd: 20,
      recurring: true,
      nextRenewalAt: "2026-10-01T00:00:00.000Z",
      description: "another subscription",
      rationale: "not affordable alongside the existing commitment",
      importance: 4,
    });

    expect(result.recorded).toBe(false);
    const state = await store.read();
    expect(state.commitments).toHaveLength(1);
    expect(await memory.list()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("appends a memory-log record with the spend's rationale on success", async () => {
    const { dataDir, store, memory } = fixtures();
    await store.write({ balanceUsd: 100, commitments: [] });

    await recordSpend(store, memory, {
      amountUsd: 12,
      recurring: false,
      nextRenewalAt: null,
      description: "npm package publish fee",
      rationale: "one-time cost to ship the first library",
      importance: 3,
    });

    const records = await memory.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      domain: "spend",
      kind: "outcome",
      subject: "npm package publish fee",
      body: "one-time cost to ship the first library",
      importance: 3,
      createdBy: "system:spend-accounting",
    });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- spend-accounting`
Expected: FAIL — `recordSpend` is not exported yet.

- [ ] **Step 3: Extend the implementation**

In `src/spend/spend-accounting.ts`, update the top-of-file import from
`import type { SpendCommitment, SpendState } from "../state/spend-store.js";`
(Task 5) to also bring in `SpendStore`, and add an import for `MemoryStore`
and `randomUUID`:

```ts
import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../memory/memory-store.js";
import type { SpendCommitment, SpendState, SpendStore } from "../state/spend-store.js";
```

Then append below the two pure functions from Task 5:

```ts
export interface SpendRequest {
  amountUsd: number;
  recurring: boolean;
  /** Required (non-null) when recurring is true; ignored for a one-off spend. */
  nextRenewalAt: string | null;
  description: string;
  rationale: string;
  /** Self-assessed 1-10, same scale as MemoryRecord.importance. */
  importance: number;
}

export type SpendResult = { recorded: true; state: SpendState } | { recorded: false; reason: string };

/**
 * The one place that turns a spend decision into both persisted state and a
 * memory-log record — see spec, "Design rules": "Every spend is logged to
 * the memory log with its goal rationale, so the reflection pass can
 * evaluate return per euro as a first-class metric."
 */
export async function recordSpend(
  store: SpendStore,
  memory: MemoryStore,
  request: SpendRequest,
): Promise<SpendResult> {
  const state = await store.read();
  const commitment: SpendCommitment = {
    id: `spend_${randomUUID().slice(0, 12)}`,
    amountUsd: request.amountUsd,
    recurring: request.recurring,
    nextRenewalAt: request.nextRenewalAt,
  };

  if (request.recurring) {
    if (wouldExhaustBeforeRenewal(state, commitment)) {
      return {
        recorded: false,
        reason: `committing $${request.amountUsd}/cycle would exceed the balance once every recurring commitment is counted`,
      };
    }
  } else if (request.amountUsd > availableToSpendUsd(state)) {
    return {
      recorded: false,
      reason: `$${request.amountUsd} exceeds the $${availableToSpendUsd(state)} available to spend`,
    };
  }

  const nextState: SpendState = request.recurring
    ? { ...state, commitments: [...state.commitments, commitment] }
    : { ...state, balanceUsd: state.balanceUsd - request.amountUsd };

  await store.write(nextState);
  await memory.append({
    domain: "spend",
    kind: "outcome",
    subject: request.description,
    body: request.rationale,
    importance: request.importance,
    createdBy: "system:spend-accounting",
  });

  return { recorded: true, state: nextState };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- spend-accounting`
Expected: PASS, all 12 tests in the file (4 `availableToSpendUsd` + 3
`wouldExhaustBeforeRenewal` from Task 5, plus 5 new `recordSpend` tests).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/spend/spend-accounting.ts tests/spend-accounting.test.ts
git commit -m "feat: wire spend accounting to the store and memory log"
```

---

### Task 7: RevenueTransport interface and fake

**Files:**
- Create: `src/control/revenue-transport.ts`
- Test: `tests/revenue-transport.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface Sale { id: string; product: string; timestampIso: string; amountUsd: number }`, `export interface RevenueTransport { listSales(sinceIso: string): Promise<Sale[]> }`, `export class FakeRevenueTransport implements RevenueTransport { seedSale(sale: Sale): void; listSales(sinceIso: string): Promise<Sale[]> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/revenue-transport.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- revenue-transport`
Expected: FAIL — `Cannot find module '../src/control/revenue-transport.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/control/revenue-transport.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- revenue-transport`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/control/revenue-transport.ts tests/revenue-transport.test.ts
git commit -m "feat: add RevenueTransport interface and fake"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/system-context.md`
- Modify: `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing (docs only).

- [ ] **Step 1: Update `README.md`**

In the `## Not built yet` section, after the existing self-build-gate
paragraph, add:

```markdown
Subsystem 2's foundation pieces are in place: `src/goals.ts` (a `goals.yaml`
schema and loader — the file itself is never authored by the system, only
by the operator, and is excluded from the merge pipeline the same as
`grants.yaml`), `src/spend/spend-accounting.ts` + `src/state/spend-store.ts`
(spend-pot bookkeeping for a `provision`-kind grant), and
`src/control/revenue-transport.ts` (the interface a weekly metrics job will
read sales from). None of these run yet: `goals.yaml` doesn't exist until
the operator commits it, no spend-card grant exists in `grants.yaml` yet,
and the real revenue transport (a specific merchant-of-record's API) is
still unwritten. See `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`.
```

- [ ] **Step 2: Update `docs/system-context.md`**

After the existing paragraph describing the memory log (the one ending "...
and what a run starts already knowing."), add a new paragraph:

```markdown
A `goals.yaml` at the repo root (`src/goals.ts`), once the operator commits
it, is the fixed reference point subsystem 2 measures the system against —
excluded from the merge pipeline the same as `grants.yaml`, since the
system may propose a revision but must never author one. A weekly metrics
job (not yet built) will compute revenue and instrumental metrics against
it; `src/spend/spend-accounting.ts` and `src/control/revenue-transport.ts`
are the spend-pot and revenue-reader building blocks that job depends on.
```

- [ ] **Step 3: Update the spec's status**

In `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`, immediately
below the existing line "Subsystem 2 of 2. Depends on the memory log from
`2026-08-30-agent-loop-design.md` and on the merge gate from
`2026-08-30-self-build-design.md` (whose rule 3 this spec amends).", add:

```markdown

Status: partially shipped. The goal-file schema/loader, its `EXCLUDED_PATHS`
entry, spend accounting, and the `RevenueTransport` interface (with its
fake) landed in `docs/superpowers/plans/2026-08-31-goal-file-and-spend-accounting.md`.
Still needed: the operator's one-time `goals.yaml` commit; the real
merchant-of-record revenue transport; the weekly metrics job and its digest
integration; instrumental subordination and the means-constraint classifier
in the proposal/queue path; quota-aware shedding in the Governor;
`architecture-scout`, which the spec's own build order places last.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: unaffected (docs-only change) — green.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/system-context.md docs/superpowers/specs/2026-08-30-self-evaluation-design.md
git commit -m "docs: describe the goal-file and spend-accounting foundation as shipped"
```

## Testing

Covered per-task above. Summary against the spec's "Testing" section:

- Metric computation: out of scope for this plan (deferred to the metrics-job
  follow-up plan named in Task 8).
- `goals.yaml` in `EXCLUDED_PATHS`: Task 2.
- Credential-scope rule: already covered by the shipped self-build gate
  (`tests/self-build-gate.test.ts`), not re-tested here.
- Spend accounting (available-to-spend subtracts recurring; a recurring
  commitment that would exhaust the balance is refused; every spend appends
  a memory-log record with its rationale): Tasks 5 and 6.
- Quota-aware shedding, instrumental subordination, means-constraint
  classifier: out of scope for this plan (they depend on `goals.yaml`
  existing at runtime and touch the Governor / queue / `pr-reviewer` prompt
  — a separate follow-up plan once this one and the metrics job have landed).
