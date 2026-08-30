# Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the system a persistent memory of what it has already done, stop it re-proposing work it has finished, rank pending proposals instead of treating them all as equal, and let a finished run create the next task.

**Architecture:** An append-only JSONL memory log under `data/memory/`, three pure functions over it (lexical similarity, scoring, a novelty gate), and four wiring points: `queueTask` gains a novelty gate and computed priority, the dispatcher writes outcome records and runs a successor pass, `retention` prunes the log, and the digest reports on it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod for config schemas, Vitest for tests, Node `fs/promises`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-loop-design.md`

## Global Constraints

- **No new npm dependencies.** Deps are `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code`, `croner`, `discord.js`, `yaml`, `zod`. Nothing else may be added.
- **No embeddings.** This system authenticates with a Claude subscription, not API billing, and Anthropic serves no embeddings endpoint. Similarity is lexical and deterministic. Do not add an embedding provider.
- **ESM import specifiers end in `.js`** even for `.ts` files — e.g. `import { TaskStore } from "../control/task-store.js"`. Match the existing codebase.
- **Tests live in `tests/<name>.test.ts`** and import from `../src/...js`. Run with `npm test` (vitest). Never add a test runner.
- **Agent-originated task priority stays ≤ 49.** Human `!task` defaults to 50; nothing computed here may equal or exceed it.
- **Fail loud, never silent.** A corrupt/unparseable record is logged via `console.error` and skipped, never silently dropped — match `TaskStore.get`'s posture (`src/control/task-store.ts:94-105`).
- **Windows-safe filenames** — no colons in any generated id (see `newRunId` in `src/run-store.ts:33`).
- Every task ends with `npm test` and `npm run typecheck` both green before committing.
- **Line numbers cited anywhere in this plan (`src/index.ts`, `src/control/dispatcher.ts`, `src/runner/sdk-runner.ts`, etc.) are approximate locations in the file as it existed when this plan was written.** Earlier tasks in this same plan edit these files, so by the time a later task runs, cited line numbers have shifted. Locate every insertion point by reading the file fresh and matching the named surrounding code (a function name, a comment, an adjacent existing call) — never by trusting an absolute line number.

**A note on the test code below.** Tasks 1-4, 9 and 10 create new files, so their tests are given as complete, runnable code — write them exactly as shown. Tasks 5, 7, 8 and 11 extend test files that already exist (`sdk-runner-queue-task.test.ts`, `dispatcher.test.ts`, `retention.test.ts`, `digest.test.ts`), each with its own established harness for building stub deps. For those, the plan gives the exact `it(...)` titles and the precise assertion each must make: **read the existing file first and write the assertions using that file's own harness.** Do not invent a parallel harness beside one that already exists.

---

### Task 1: MemoryStore and the `memory:` config block

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/memory-store.ts`
- Modify: `src/config.ts` (add `MemorySchema`, register in `ConfigSchema`)
- Test: `tests/memory-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MemoryRecord`, `MemoryKind`, `MemoryStore` with
  `append(input: MemoryInput): Promise<MemoryRecord>`,
  `list(): Promise<MemoryRecord[]>`,
  `prune(opts: { olderThan: Date; keepKinds: MemoryKind[] }): Promise<number>`.
  Config type `MemoryConfig` exported from `src/config.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memory-store.test.ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";

function store(): { s: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cai-memory-"));
  return { s: new MemoryStore(dir), dir };
}

describe("MemoryStore", () => {
  it("appends a record with a generated id and timestamp", async () => {
    const { s } = store();
    const rec = await s.append({
      domain: "research", kind: "finding", subject: "npm audit tooling",
      body: "details", importance: 5, createdBy: "agent:research",
    });
    expect(rec.id).toMatch(/^mem_/);
    expect(rec.id).not.toContain(":");
    expect(rec.ts).toBeTruthy();
    expect(rec.chainDepth).toBe(0);
    expect(await s.list()).toEqual([rec]);
  });

  it("appends without rewriting earlier records", async () => {
    const { s, dir } = store();
    await s.append({ domain: "d", kind: "finding", subject: "a", body: "", importance: 1, createdBy: "x" });
    await s.append({ domain: "d", kind: "finding", subject: "b", body: "", importance: 1, createdBy: "x" });
    const lines = readFileSync(join(dir, "memory", "log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((await s.list()).map((r) => r.subject)).toEqual(["a", "b"]);
  });

  it("logs and skips a corrupt line rather than losing the whole log", async () => {
    const { s, dir } = store();
    await s.append({ domain: "d", kind: "finding", subject: "good", body: "", importance: 1, createdBy: "x" });
    writeFileSync(join(dir, "memory", "log.jsonl"), '{ truncated\n' + readFileSync(join(dir, "memory", "log.jsonl"), "utf8"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await s.list()).map((r) => r.subject)).toEqual(["good"]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("returns an empty list when no log exists yet", async () => {
    expect(await store().s.list()).toEqual([]);
  });

  it("prunes old records but keeps protected kinds", async () => {
    const { s } = store();
    const old = new Date("2020-01-01T00:00:00.000Z");
    await s.append({ domain: "d", kind: "finding", subject: "old", body: "", importance: 1, createdBy: "x", ts: old.toISOString() });
    await s.append({ domain: "d", kind: "reflection", subject: "old reflection", body: "", importance: 1, createdBy: "x", ts: old.toISOString() });
    await s.append({ domain: "d", kind: "finding", subject: "fresh", body: "", importance: 1, createdBy: "x" });
    const removed = await s.prune({ olderThan: new Date("2021-01-01T00:00:00.000Z"), keepKinds: ["reflection"] });
    expect(removed).toBe(1);
    expect((await s.list()).map((r) => r.subject).sort()).toEqual(["fresh", "old reflection"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- memory-store`
Expected: FAIL — cannot resolve `../src/memory/memory-store.js`.

- [ ] **Step 3: Write the types**

```ts
// src/memory/types.ts

/**
 * `finding` — something learned (a research result, an audit finding).
 * `proposal` — work suggested but not yet done.
 * `outcome` — what actually happened when work ran, carrying its verdict.
 * `reflection` — a periodic higher-level conclusion synthesised from the above.
 */
export type MemoryKind = "finding" | "proposal" | "outcome" | "reflection";

export interface MemoryRecord {
  id: string;
  ts: string;
  /** Partitions similarity checks so an npm advisory is never compared to a revenue prospect. */
  domain: string;
  kind: MemoryKind;
  /** One canonical line, and the only field similarity compares. */
  subject: string;
  /** A natural key where the domain has one (package name, file path, repo) — an exact match short-circuits similarity to 1. */
  key?: string;
  body: string;
  /** Self-assessed 1-10, meaning importance TOWARD THE GOAL, not intrinsic interest. */
  importance: number;
  createdBy: string;
  sourceRunId?: string;
  sourceTaskId?: string;
  verdict?: "achieved" | "not-achieved" | "unclear";
  /** How many successor hops produced this. Root work is 0. Bounds runaway self-propagation. */
  chainDepth: number;
}

export type MemoryInput = Omit<MemoryRecord, "id" | "ts" | "chainDepth"> &
  Partial<Pick<MemoryRecord, "ts" | "chainDepth">>;
```

- [ ] **Step 4: Write the store**

```ts
// src/memory/memory-store.ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { MemoryInput, MemoryKind, MemoryRecord } from "./types.js";

/**
 * Append-only JSONL, the same shape (and for the same reason) as a run's
 * transcript.jsonl: written as events arrive, so it survives a crash.
 *
 * Nothing here ever rewrites an existing record in place. The memory
 * literature is specific that LLM-rewritten memory degrades over time
 * ("Useful Memories Become Faulty When Continuously Updated by LLMs"), so
 * consolidation produces derived output rather than mutating the raw log.
 * `prune` is the single exception — it only ever DELETES whole records, never
 * edits one, and only runs from the retention job.
 */
export class MemoryStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "memory");
  }

  private path(): string {
    return join(this.dir(), "log.jsonl");
  }

  async append(input: MemoryInput): Promise<MemoryRecord> {
    await mkdir(this.dir(), { recursive: true });
    const record: MemoryRecord = {
      ...input,
      id: `mem_${randomUUID().slice(0, 12)}`,
      ts: input.ts ?? new Date().toISOString(),
      chainDepth: input.chainDepth ?? 0,
    };
    await appendFile(this.path(), JSON.stringify(record) + "\n");
    return record;
  }

  async list(): Promise<MemoryRecord[]> {
    const raw = await readFile(this.path(), "utf8").catch(() => "");
    const records: MemoryRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as MemoryRecord);
      } catch (err) {
        // Never silent: a corrupt line vanishing from every novelty check
        // forever is exactly the quiet loss this project's posture forbids.
        console.error("[memory-store] skipping unparseable log line", err);
      }
    }
    return records;
  }

  /** Returns how many records were removed. Rewrites the whole file — retention only. */
  async prune(opts: { olderThan: Date; keepKinds: MemoryKind[] }): Promise<number> {
    const all = await this.list();
    const kept = all.filter((r) => opts.keepKinds.includes(r.kind) || new Date(r.ts) >= opts.olderThan);
    if (kept.length === all.length) return 0;
    await writeFileAtomic(this.path(), kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
    return all.length - kept.length;
  }
}
```

- [ ] **Step 5: Add the config block**

In `src/config.ts`, after `RetentionSchema` (around line 130), add:

```ts
export const MemorySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Raw records older than this are pruned by the retention job. */
    retentionDays: z.number().int().positive().default(90),
    /** Reflections are already compressed, so they outlive raw records. */
    reflectionRetentionDays: z.number().int().positive().default(365),
    /** Above this similarity, a candidate counts as covering the same ground. */
    similarityThreshold: z.number().min(0).max(1).default(0.75),
    /** A prior record older than this no longer suppresses a repeat — the world moved on. */
    stalenessDays: z.number().int().positive().default(30),
    recencyHalfLifeDays: z.number().int().positive().default(14),
    /** Successor chain depth cap — bounds runaway self-propagation. */
    maxChainDepth: z.number().int().nonnegative().default(3),
    /** Ceiling on agent-originated tasks per rolling day, independent of depth. */
    maxAgentTasksPerDay: z.number().int().positive().default(20),
    weights: z
      .object({
        goal: z.number().min(0).default(0.5),
        novelty: z.number().min(0).default(0.25),
        importance: z.number().min(0).default(0.15),
        recency: z.number().min(0).default(0.1),
      })
      .strict()
      .prefault({}),
  })
  .strict();
```

Then register it in `ConfigSchema` alongside `retention`, and export the type:

```ts
    retention: RetentionSchema.prefault({}),
    memory: MemorySchema.prefault({}),
```

```ts
export type MemoryConfig = z.infer<typeof MemorySchema>;
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- memory-store && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/memory/types.ts src/memory/memory-store.ts src/config.ts tests/memory-store.test.ts
git commit -m "feat: append-only memory log store and memory config block"
```

---

### Task 2: Lexical similarity

**Files:**
- Create: `src/memory/similarity.ts`
- Test: `tests/memory-similarity.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord` shape from Task 1 (only `subject` and `key` are read).
- Produces: `similarity(a: Comparable, b: Comparable): number` returning 0..1, where `Comparable = { subject: string; key?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memory-similarity.test.ts
import { describe, expect, it } from "vitest";
import { similarity } from "../src/memory/similarity.js";

describe("similarity", () => {
  it("returns 1 for a matching natural key regardless of wording", () => {
    expect(similarity(
      { subject: "bump lodash to 4.17.21", key: "npm:lodash" },
      { subject: "upgrade the lodash package", key: "NPM:LODASH" },
    )).toBe(1);
  });

  it("returns a high score for near-identical subjects", () => {
    expect(similarity(
      { subject: "research paid newsletter platforms for developers" },
      { subject: "research paid newsletter platforms for developer audiences" },
    )).toBeGreaterThan(0.75);
  });

  it("returns a low score for unrelated subjects", () => {
    expect(similarity(
      { subject: "research paid newsletter platforms" },
      { subject: "fix the broken link in the deployment runbook" },
    )).toBeLessThan(0.3);
  });

  it("is unaffected by case, punctuation and stop words", () => {
    expect(similarity(
      { subject: "Audit the NPM dependencies!" },
      { subject: "audit npm dependencies" },
    )).toBeGreaterThan(0.9);
  });

  it("is symmetric and self-identical", () => {
    const a = { subject: "one two three" };
    const b = { subject: "two three four" };
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a));
    expect(similarity(a, a)).toBe(1);
  });

  it("scores two empty subjects as 0 rather than dividing by zero", () => {
    expect(similarity({ subject: "" }, { subject: "" })).toBe(0);
  });

  it("does not match on key when only one side has one", () => {
    // A lone key must never change the result at all — the code's guard
    // requires BOTH sides to carry a key before the exact-match fast path
    // fires, so this checks equality against the keyless baseline rather
    // than asserting some specific score. (An earlier version of this test
    // used two IDENTICAL subjects and asserted <1, which is wrong: identical
    // lexical content legitimately scores 1.0 on its own, independent of any
    // key, and demanding otherwise forced an arbitrary special case with no
    // real invariant behind it.)
    const withoutKey = similarity({ subject: "quarterly revenue report draft" }, { subject: "quarterly revenue report final" });
    const withOneKey = similarity({ subject: "quarterly revenue report draft", key: "npm:a" }, { subject: "quarterly revenue report final" });
    expect(withOneKey).toBe(withoutKey);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- memory-similarity`
Expected: FAIL — cannot resolve `../src/memory/similarity.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/similarity.ts

export interface Comparable {
  subject: string;
  key?: string;
}

/**
 * Deliberately lexical, not embedding-based. This system runs on a Claude
 * subscription with no API billing, and Anthropic serves no embeddings
 * endpoint — an embedding provider would mean a new credential and new
 * billing, and a local model would mean RAM this box is preserving for other
 * things. Accuracy ceiling accepted in exchange; see the spec's Risks.
 *
 * Two signals, averaged: token-set Jaccard (catches reordering and filler)
 * and character-trigram overlap (catches morphology). Both drop stop words
 * before comparing — including inside the trigram text, not just the token
 * list, since a shared filler word ("the") otherwise shifts every trigram
 * after it and drags the score down for no semantic reason. Tokens
 * additionally strip one trailing "s": a cheap, dependency-free stand-in for
 * stemming (this system takes no new dependencies) that's enough to treat
 * "platform"/"platforms" or "developer"/"developers" as the same word.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "of", "for", "in", "on", "at", "by", "with",
  "is", "are", "be", "it", "this", "that", "or", "as", "from", "into",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/** Strips one trailing "s" — length > 1 so a lone "s" token is never reduced to "". */
function singularize(word: string): string {
  return word.length > 1 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function tokens(text: string): Set<string> {
  return new Set(words(text).map(singularize));
}

function trigrams(text: string): Set<string> {
  const normalized = words(text).join("");
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) grams.add(normalized.slice(i, i + 3));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function similarity(a: Comparable, b: Comparable): number {
  if (a.key && b.key && a.key.toLowerCase() === b.key.toLowerCase()) return 1;
  return (jaccard(tokens(a.subject), tokens(b.subject)) + jaccard(trigrams(a.subject), trigrams(b.subject))) / 2;
}
```

**Note on how this was derived** (kept for whoever next touches this file): the version of this code first drafted in this plan computed trigrams over the FULL normalized text, stop words included, and had no plural normalization in `tokens()`. Hand-verifying the test numbers against that version (done during this plan's execution, not before) showed two of the seven test cases could never pass against it: the "near-identical subjects" case tops out around 0.68 without singularization (short of its own >0.75 bar), and the "unaffected by... stop words" case tops out around 0.85 without stop-word-filtered trigrams (short of its own >0.9 bar). The version above is the corrected one — verified by hand against all seven cases before being written here.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- memory-similarity && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/similarity.ts tests/memory-similarity.test.ts
git commit -m "feat: deterministic lexical similarity for memory records"
```

---

### Task 3: Scoring — retrieval and prioritization

**Files:**
- Create: `src/memory/scoring.ts`
- Test: `tests/memory-scoring.test.ts`

**Interfaces:**
- Consumes: `MemoryConfig["weights"]` and `recencyHalfLifeDays` from Task 1; `similarity` from Task 2 is NOT called here (callers pass in the already-computed `maxSimilarity`), keeping this file pure arithmetic.
- Produces:
  `recencyDecay(ts: string, now: Date, halfLifeDays: number): number`,
  `priorityScore(input: PriorityInput, weights: ScoringWeights, now: Date): number` (0..1),
  `toPriority(score: number): number` (integer 0..49),
  `retrievalScore(input: RetrievalInput, now: Date, halfLifeDays: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memory-scoring.test.ts
import { describe, expect, it } from "vitest";
import { priorityScore, recencyDecay, retrievalScore, toPriority } from "../src/memory/scoring.js";

const WEIGHTS = { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 };
const NOW = new Date("2026-08-30T00:00:00.000Z");

describe("recencyDecay", () => {
  it("is 1 for something that just happened", () => {
    expect(recencyDecay(NOW.toISOString(), NOW, 14)).toBeCloseTo(1);
  });

  it("is 0.5 after exactly one half-life", () => {
    expect(recencyDecay(new Date("2026-08-16T00:00:00.000Z").toISOString(), NOW, 14)).toBeCloseTo(0.5);
  });

  it("never goes negative for a future timestamp", () => {
    expect(recencyDecay(new Date("2027-01-01T00:00:00.000Z").toISOString(), NOW, 14)).toBeLessThanOrEqual(1);
    expect(recencyDecay(new Date("2027-01-01T00:00:00.000Z").toISOString(), NOW, 14)).toBeGreaterThanOrEqual(0);
  });
});

describe("priorityScore", () => {
  const base = { goalAlignment: 0.5, maxSimilarity: 0.5, importance: 5, proposedAt: NOW.toISOString() };

  it("ranks goal alignment above novelty", () => {
    const alignedButRepetitive = priorityScore({ ...base, goalAlignment: 1, maxSimilarity: 1 }, WEIGHTS, NOW);
    const novelButUnaligned = priorityScore({ ...base, goalAlignment: 0, maxSimilarity: 0 }, WEIGHTS, NOW);
    expect(alignedButRepetitive).toBeGreaterThan(novelButUnaligned);
  });

  it("penalises similarity to completed work", () => {
    const novel = priorityScore({ ...base, maxSimilarity: 0 }, WEIGHTS, NOW);
    const repeat = priorityScore({ ...base, maxSimilarity: 1 }, WEIGHTS, NOW);
    expect(novel).toBeGreaterThan(repeat);
  });

  it("rewards higher self-assessed importance", () => {
    expect(priorityScore({ ...base, importance: 10 }, WEIGHTS, NOW))
      .toBeGreaterThan(priorityScore({ ...base, importance: 1 }, WEIGHTS, NOW));
  });

  it("stays within 0..1", () => {
    const max = priorityScore({ goalAlignment: 1, maxSimilarity: 0, importance: 10, proposedAt: NOW.toISOString() }, WEIGHTS, NOW);
    const min = priorityScore({ goalAlignment: 0, maxSimilarity: 1, importance: 1, proposedAt: "2000-01-01T00:00:00.000Z" }, WEIGHTS, NOW);
    expect(max).toBeLessThanOrEqual(1);
    expect(min).toBeGreaterThanOrEqual(0);
  });
});

describe("toPriority", () => {
  it("never reaches the human-task default of 50", () => {
    expect(toPriority(1)).toBe(49);
    expect(toPriority(1.5)).toBe(49);
  });

  it("floors at 0 and returns an integer", () => {
    expect(toPriority(0)).toBe(0);
    expect(toPriority(-1)).toBe(0);
    expect(Number.isInteger(toPriority(0.37))).toBe(true);
  });
});

describe("retrievalScore", () => {
  it("treats similarity as a POSITIVE, unlike priorityScore", () => {
    const related = retrievalScore({ similarity: 1, importance: 5, ts: NOW.toISOString() }, NOW, 14);
    const unrelated = retrievalScore({ similarity: 0, importance: 5, ts: NOW.toISOString() }, NOW, 14);
    expect(related).toBeGreaterThan(unrelated);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- memory-scoring`
Expected: FAIL — cannot resolve `../src/memory/scoring.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/scoring.ts

export interface ScoringWeights {
  goal: number;
  novelty: number;
  importance: number;
  recency: number;
}

export interface PriorityInput {
  /** 0..1 — the proposal's own stated contribution to the primary goal. */
  goalAlignment: number;
  /** 0..1 — highest similarity to anything already completed. A PENALTY here. */
  maxSimilarity: number;
  /** 1..10, self-assessed. */
  importance: number;
  proposedAt: string;
}

export interface RetrievalInput {
  /** 0..1 — similarity to what the agent is about to work on. A BONUS here. */
  similarity: number;
  importance: number;
  ts: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Human `!task` priority. Nothing computed here may reach it. */
const HUMAN_PRIORITY = 50;

export function recencyDecay(ts: string, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(ts).getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Generative Agents scores memory retrieval as recency + importance +
 * relevance. That is right for RETRIEVAL and inverted for PRIORITISATION:
 * when choosing what to work on next, similarity to already-completed work is
 * a penalty, not a bonus. Conflating the two is the easy bug here, which is
 * why they are separate exported functions with separate input types.
 *
 * `goal` carries the largest weight by design — novelty and recency break
 * ties between comparably goal-aligned candidates, they never outvote the goal.
 */
export function priorityScore(input: PriorityInput, weights: ScoringWeights, now: Date): number {
  const total = weights.goal + weights.novelty + weights.importance + weights.recency;
  if (total === 0) return 0;
  const raw =
    weights.goal * clamp01(input.goalAlignment) +
    weights.novelty * (1 - clamp01(input.maxSimilarity)) +
    weights.importance * clamp01((input.importance - 1) / 9) +
    weights.recency * recencyDecay(input.proposedAt, now, 14);
  return clamp01(raw / total);
}

/** Maps a 0..1 score onto the task queue's integer priority, capped below human tasks. */
export function toPriority(score: number): number {
  return Math.min(HUMAN_PRIORITY - 1, Math.max(0, Math.round(clamp01(score) * (HUMAN_PRIORITY - 1))));
}

export function retrievalScore(input: RetrievalInput, now: Date, halfLifeDays: number): number {
  return (
    0.5 * clamp01(input.similarity) +
    0.3 * clamp01((input.importance - 1) / 9) +
    0.2 * recencyDecay(input.ts, now, halfLifeDays)
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- memory-scoring && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/scoring.ts tests/memory-scoring.test.ts
git commit -m "feat: retrieval and prioritization scoring for the memory log"
```

---

### Task 4: The novelty gate

**Files:**
- Create: `src/memory/novelty-gate.ts`
- Test: `tests/memory-novelty-gate.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord` (Task 1), `similarity` + `Comparable` (Task 2).
- Produces: `assessNovelty(candidate: Comparable & { domain: string }, records: MemoryRecord[], opts: NoveltyOptions): NoveltyVerdict` where
  `NoveltyOptions = { threshold: number; stalenessDays: number; now: Date }` and
  `NoveltyVerdict = { kind: "novel"; maxSimilarity: number } | { kind: "suppressed"; priorId: string; maxSimilarity: number } | { kind: "retry"; priorId: string; maxSimilarity: number; priorReason?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memory-novelty-gate.test.ts
import { describe, expect, it } from "vitest";
import { assessNovelty } from "../src/memory/novelty-gate.js";
import type { MemoryRecord } from "../src/memory/types.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const OPTS = { threshold: 0.75, stalenessDays: 30, now: NOW };

function record(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem_1", ts: NOW.toISOString(), domain: "research", kind: "outcome",
    subject: "research paid newsletter platforms", body: "", importance: 5,
    createdBy: "agent:research", chainDepth: 0, verdict: "achieved", ...over,
  };
}

describe("assessNovelty", () => {
  it("suppresses a fresh repeat of work already achieved", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({})],
      OPTS,
    );
    expect(verdict.kind).toBe("suppressed");
  });

  it("allows a repeat once the prior record is stale", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({ ts: "2026-01-01T00:00:00.000Z" })],
      OPTS,
    );
    expect(verdict.kind).toBe("retry");
  });

  it("allows a repeat of work that was graded not-achieved, carrying the reason", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({ verdict: "not-achieved", body: "the fetch kept timing out" })],
      OPTS,
    );
    expect(verdict.kind).toBe("retry");
    if (verdict.kind === "retry") expect(verdict.priorReason).toBe("the fetch kept timing out");
  });

  it("passes genuinely new work through as novel", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "fix the broken deployment runbook link" },
      [record({})],
      OPTS,
    );
    expect(verdict.kind).toBe("novel");
  });

  it("never compares across domains", () => {
    const verdict = assessNovelty(
      { domain: "deps", subject: "research paid newsletter platforms" },
      [record({ domain: "research" })],
      OPTS,
    );
    expect(verdict.kind).toBe("novel");
  });

  it("ignores proposals and reflections, comparing only against work that ran", () => {
    const verdict = assessNovelty(
      { domain: "research", subject: "research paid newsletter platforms" },
      [record({ kind: "proposal" }), record({ id: "mem_2", kind: "reflection" })],
      OPTS,
    );
    expect(verdict.kind).toBe("novel");
  });

  it("is novel against an empty log", () => {
    expect(assessNovelty({ domain: "d", subject: "anything" }, [], OPTS).kind).toBe("novel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- memory-novelty-gate`
Expected: FAIL — cannot resolve `../src/memory/novelty-gate.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/novelty-gate.ts
import { similarity, type Comparable } from "./similarity.js";
import type { MemoryRecord } from "./types.js";

export interface NoveltyOptions {
  threshold: number;
  stalenessDays: number;
  now: Date;
}

export type NoveltyVerdict =
  | { kind: "novel"; maxSimilarity: number }
  | { kind: "suppressed"; priorId: string; maxSimilarity: number }
  | { kind: "retry"; priorId: string; maxSimilarity: number; priorReason?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decides whether a proposal covers ground the system has already covered.
 *
 * Only `finding` and `outcome` records are compared against — a `proposal` is
 * work that has not run yet (suppressing against it would block work purely
 * because it was suggested twice), and a `reflection` is a synthesised
 * conclusion, not a piece of work.
 *
 * A prior that is fresh AND was actually achieved suppresses. Anything else
 * — stale, or graded not-achieved/unclear — is allowed through as a retry
 * carrying the prior's own record, so the next attempt is informed rather
 * than blind.
 */
export function assessNovelty(
  candidate: Comparable & { domain: string },
  records: MemoryRecord[],
  opts: NoveltyOptions,
): NoveltyVerdict {
  let best: { record: MemoryRecord; score: number } | null = null;
  for (const record of records) {
    if (record.domain !== candidate.domain) continue;
    if (record.kind !== "outcome" && record.kind !== "finding") continue;
    const score = similarity(candidate, record);
    if (!best || score > best.score) best = { record, score };
  }

  if (!best || best.score <= opts.threshold) {
    return { kind: "novel", maxSimilarity: best?.score ?? 0 };
  }

  const ageDays = (opts.now.getTime() - new Date(best.record.ts).getTime()) / DAY_MS;
  const isStale = ageDays > opts.stalenessDays;
  if (!isStale && best.record.verdict === "achieved") {
    return { kind: "suppressed", priorId: best.record.id, maxSimilarity: best.score };
  }
  return {
    kind: "retry",
    priorId: best.record.id,
    maxSimilarity: best.score,
    ...(best.record.body ? { priorReason: best.record.body } : {}),
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- memory-novelty-gate && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/novelty-gate.ts tests/memory-novelty-gate.test.ts
git commit -m "feat: novelty gate suppressing fresh repeats of achieved work"
```

---

### Task 5: Gate and score `queueTask`

**Files:**
- Modify: `src/runner/sdk-runner.ts` (the `queueTask` tool, around lines 551-608)
- Test: `tests/sdk-runner-queue-task.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `assessNovelty` (Task 4), `priorityScore`/`toPriority` (Task 3), `MemoryConfig` (Task 1).
- Produces: `SdkRunner` deps gain `memory?: MemoryStore` and `memoryConfig?: MemoryConfig`. `queueTask` gains optional args `domain`, `subject`, `importance`, `goalAlignment`.

- [ ] **Step 1: Read the existing tool and test**

Read `src/runner/sdk-runner.ts` lines 551-610 and `tests/sdk-runner-queue-task.test.ts` in full. The existing per-run cap (`MAX_QUEUE_TASK_CALLS_PER_RUN = 3`) and the `Math.min(priority ?? 30, 30)` clamp must both keep working — this task adds to them, replaces neither.

- [ ] **Step 2: Write the failing tests**

Append to `tests/sdk-runner-queue-task.test.ts`, adapting the file's existing harness (reuse whatever helper it already uses to build an `SdkRunner` and invoke the tool; do not invent a new one):

```ts
  it("refuses a proposal the novelty gate suppresses, without creating a task", async () => {
    // Seed the memory log with a fresh, achieved outcome on the same subject,
    // then queue a near-identical proposal.
    // Expect: the tool's text contains "already", and tasks.list() stays empty.
  });

  it("records a proposal record in the memory log when it does queue", async () => {
    // Expect: memory.list() gains one record with kind "proposal" and the
    // subject the tool was given.
  });

  it("annotates a retry with the prior attempt's reason", async () => {
    // Seed a not-achieved outcome, queue a near-identical proposal.
    // Expect: the created task's text contains the prior reason.
  });

  it("computes priority from the score rather than always using 30", async () => {
    // A highly goal-aligned, novel, important proposal should get a priority
    // above 30; all computed priorities stay <= 49.
  });

  it("still clamps to <= 49 so a human !task always outranks it", async () => {
    // Expect: created.priority <= 49 for goalAlignment 1, importance 10.
  });

  it("still enforces the existing 3-calls-per-run cap", async () => {
    // Unchanged behaviour — guard against this task regressing it.
  });
```

Fill each body in using the existing file's harness before running.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- sdk-runner-queue-task`
Expected: FAIL on the new cases; the pre-existing cases still PASS.

- [ ] **Step 4: Add the deps**

In the `SdkRunner` constructor deps object (`src/runner/sdk-runner.ts:206-220`), add alongside `tasks`:

```ts
      /** Optional, same shape as `tasks`: without it queueTask keeps its old flat-priority behaviour and writes no memory records. */
      memory?: MemoryStore;
      memoryConfig?: MemoryConfig;
```

- [ ] **Step 5: Rewrite the queueTask handler**

Replace the tool's argument schema and handler body (keeping `MAX_QUEUE_TASK_CALLS_PER_RUN` and the `queueTaskCalls` counter exactly as they are):

```ts
                  tool(
                    "queueTask",
                    "Queue a new task for the system to work on later — the same durable queue a human's !task command adds to. Use this to propose research or an improvement rather than doing it yourself in this run. Give a `domain` and a one-line `subject` so the system can tell whether this repeats work it already did.",
                    {
                      text: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
                      priority: z.number().int().nonnegative().optional(),
                      domain: z.string().min(1).default("general"),
                      subject: z.string().min(1).max(200).optional(),
                      key: z.string().max(200).optional(),
                      importance: z.number().int().min(1).max(10).default(5),
                      goalAlignment: z.number().min(0).max(1).default(0.5),
                    },
                    async ({ text, priority, domain, subject, key, importance, goalAlignment }) => {
                      if (queueTaskCalls >= MAX_QUEUE_TASK_CALLS_PER_RUN) {
                        return {
                          content: [{ type: "text" as const, text: `Refused: already queued ${MAX_QUEUE_TASK_CALLS_PER_RUN} tasks this run, the maximum allowed in one run.` }],
                        };
                      }

                      const memory = memoryDep;
                      const cfg = memoryConfigDep;
                      let annotation = "";
                      let computedPriority = Math.min(priority ?? DEFAULT_SELF_QUEUED_PRIORITY, DEFAULT_SELF_QUEUED_PRIORITY);

                      if (memory && cfg?.enabled) {
                        const now = new Date();
                        const candidate = { domain, subject: subject ?? text.slice(0, 200), ...(key ? { key } : {}) };
                        const verdict = assessNovelty(candidate, await memory.list(), {
                          threshold: cfg.similarityThreshold,
                          stalenessDays: cfg.stalenessDays,
                          now,
                        });

                        if (verdict.kind === "suppressed") {
                          // Counted against the per-run cap deliberately: a run
                          // that keeps proposing duplicates should run out of
                          // attempts rather than retry forever.
                          queueTaskCalls += 1;
                          await memory.append({
                            domain, kind: "proposal", subject: candidate.subject, body: `suppressed as a duplicate of ${verdict.priorId}`,
                            importance, createdBy: `agent:${agent.name}`,
                          });
                          return {
                            content: [{ type: "text" as const, text: `Refused: this already covers work recorded as achieved (${verdict.priorId}, similarity ${verdict.maxSimilarity.toFixed(2)}). Propose something else.` }],
                          };
                        }

                        if (verdict.kind === "retry" && verdict.priorReason) {
                          annotation = `\n\n(A previous attempt at closely related work recorded: "${verdict.priorReason}". Take that into account.)`;
                        }

                        computedPriority = toPriority(
                          priorityScore(
                            { goalAlignment, maxSimilarity: verdict.maxSimilarity, importance, proposedAt: now.toISOString() },
                            cfg.weights,
                            now,
                          ),
                        );
                      }

                      queueTaskCalls += 1;
                      const created = await tasksDep.create({
                        text: `${text}${annotation}`,
                        priority: computedPriority,
                        createdBy: `agent:${agent.name}`,
                        wantsDetail: true,
                      });
                      if (memory && cfg?.enabled) {
                        await memory.append({
                          domain, kind: "proposal", subject: subject ?? text.slice(0, 200), ...(key ? { key } : {}),
                          body: text, importance, createdBy: `agent:${agent.name}`, sourceTaskId: created.id,
                        });
                      }
                      void wakeDep().catch((err: unknown) => {
                        console.error(`[queueTask] dispatcher wake failed after queuing ${created.id} (agent ${agent.name})`, err);
                      });
                      return { content: [{ type: "text" as const, text: `Queued task ${created.id} at priority ${created.priority}.` }] };
                    },
                  ),
```

Add near `const tasksDep = this.deps.tasks;` (line 559):

```ts
    const memoryDep = this.deps.memory;
    const memoryConfigDep = this.deps.memoryConfig;
```

And add the imports at the top of the file:

```ts
import { assessNovelty } from "../memory/novelty-gate.js";
import { priorityScore, toPriority } from "../memory/scoring.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { MemoryConfig } from "../config.js";
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — including every pre-existing `sdk-runner-queue-task` case.

- [ ] **Step 7: Commit**

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-queue-task.test.ts
git commit -m "feat: gate queueTask on novelty and score its priority"
```

---

### Task 6: Wire the store at boot

**Files:**
- Modify: `src/index.ts` (around lines 79-107, where `buildRunner` is called)
- Modify: `src/runner/build-runner.ts` (pass the new deps through)
- Test: `tests/build-runner.test.ts`

(`tests/boot-wiring.test.ts` was listed here in an earlier draft of this plan — it's unrelated: that file tests `reconcileAndConnectBot`, the Discord bot's reconnection/pending-entry reconciliation logic, nothing to do with `buildRunner` or memory. `src/index.ts`'s `main()` is never imported by any test — per `build-runner.ts`'s own doc comment, doing so would run the whole supervisor — so there is no unit-testable surface for "index.ts constructs and passes a MemoryStore" beyond `buildRunner` itself accepting the new optional params, which `build-runner.test.ts` covers.)

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `SdkRunner` deps (Task 5).
- Produces: a single `MemoryStore` instance constructed on `DATA_DIR` and passed into `buildRunner`, available for Tasks 7-11.

- [ ] **Step 1: Read the wiring**

Read `src/runner/build-runner.ts` in full and `src/index.ts:70-130`. Follow exactly how `tasks` is threaded through — `memory` goes the same route.

- [ ] **Step 2: Write the failing test**

`SdkRunner` exposes no getter for its deps, so `build-runner.test.ts`'s existing tests (e.g. "accepts tasks/wake and still returns the real runner when provided", "accepts a gitPusher...") only assert `instanceof SdkRunner` — they can't and don't inspect what was actually stored. Match that exact shallow style; do not try to reach into `SdkRunner`'s internals. Add:

```ts
  it("accepts memory/memoryConfig and still returns the real runner when provided", () => {
    const { grants, pending } = opts();
    const memory = new MemoryStore(mkdtempSync(join(tmpdir(), "cai-buildrunner-")));
    const memoryConfig = { enabled: true } as MemoryConfig; // only `enabled` matters to buildRunner itself
    const runner = buildRunner({ grants, pending, memory, memoryConfig }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });
```

This will fail to compile before Step 4 (the options type doesn't yet accept `memory`/`memoryConfig`), which is this task's version of RED.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- build-runner`
Expected: FAIL — a TypeScript error, since `memory`/`memoryConfig` aren't yet valid keys on `buildRunner`'s options type.

- [ ] **Step 4: Thread the dependency**

In `build-runner.ts`, add `memory?: MemoryStore` and `memoryConfig?: MemoryConfig` to its options type and pass both into `new SdkRunner({ ... })`. In `src/index.ts`, construct it beside the existing `tasks` store and pass it:

```ts
const memory = new MemoryStore(DATA_DIR);
```

```ts
    runner = buildRunner({
      grants, pending: new PendingStore(DATA_DIR), github,
      gitPusher: new RealGitPusher(),
      tasks,
      memory,
      memoryConfig: config.memory,
      systemContext,
      wake: async () => { if (dispatcher) await dispatcher.wake(); },
    });
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/runner/build-runner.ts tests/build-runner.test.ts
git commit -m "feat: construct and wire the MemoryStore at boot"
```

---

### Task 7: The dispatcher records outcomes

**Files:**
- Modify: `src/control/dispatcher.ts` (`DispatcherDeps`, and `executeAndFinalize`'s terminal branches)
- Test: `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `Task` (existing).
- Produces: `DispatcherDeps` gains `memory?: MemoryStore`. One `kind: "outcome"` record is appended per terminal task completion, carrying `verdict`, `sourceTaskId`, `sourceRunId`.

- [ ] **Step 1: Write the failing test**

Add to `tests/dispatcher.test.ts`, using the file's existing dep-stub helper:

```ts
  it("records an outcome record when a task completes successfully", async () => {
    // Run one task to success with a memory store wired in.
    // Expect: exactly one record, kind "outcome", verdict "achieved",
    // sourceTaskId === the task's id.
  });

  it("records a not-achieved verdict on a task that exhausts its retries", async () => {
    // Expect: verdict "not-achieved" and the verifier's reason in `body`.
  });

  it("records a failed task's reason", async () => {
    // Expect: one outcome record whose body contains the failure reason.
  });

  it("writes no outcome record for a task that merely deferred", async () => {
    // A governor refusal puts the task back to pending — nothing happened yet.
    // Expect: memory.list() is empty.
  });

  it("does not fail the task when the memory append throws", async () => {
    // A broken memory store must never destroy a task's real status —
    // same posture as notifyBestEffort.
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dispatcher`
Expected: FAIL on the new cases.

- [ ] **Step 3: Add the dep and a best-effort recorder**

In `src/control/dispatcher.ts`, add to `DispatcherDeps`:

```ts
  /** Optional: without it the dispatcher behaves exactly as before, writing no memory records. */
  memory?: MemoryStore;
```

Add, next to `notifyBestEffort` and for the same reason:

```ts
/**
 * Recording to the memory log must never change what a task RECORDS about
 * itself — identical reasoning to notifyBestEffort above. A broken or full
 * disk under data/memory/ is not a reason to lose a task's real status.
 */
async function rememberBestEffort(deps: DispatcherDeps, input: MemoryInput): Promise<void> {
  if (!deps.memory) return;
  try {
    await deps.memory.append(input);
  } catch (error) {
    console.error("[dispatcher] memory append failed", error);
  }
}
```

- [ ] **Step 4: Call it from each terminal branch**

In `executeAndFinalize`, after each of the three terminal `tasks.update` calls — the retries-exhausted branch (~line 220), the plain success branch (~line 231), and the failure branch (~line 276) — add the matching record. Do **not** add one to the deferred or `waiting` branches: neither is a completed outcome.

```ts
      // retries-exhausted branch
      await rememberBestEffort(deps, {
        domain: agent.name, kind: "outcome", subject: task.text.slice(0, 200),
        body: result.verifiedOutcome.reason, importance: 5,
        createdBy: `agent:${agent.name}`, verdict: "not-achieved",
        sourceTaskId: task.id, sourceRunId: result.runId,
      });
```

```ts
      // plain success branch
      await rememberBestEffort(deps, {
        domain: agent.name, kind: "outcome", subject: task.text.slice(0, 200),
        body: result.summary, importance: 5, createdBy: `agent:${agent.name}`,
        verdict: result.verifiedOutcome?.verdict ?? "unclear",
        sourceTaskId: task.id, sourceRunId: result.runId,
      });
```

```ts
      // failure branch
      await rememberBestEffort(deps, {
        domain: agent.name, kind: "outcome", subject: task.text.slice(0, 200),
        body: reason, importance: 5, createdBy: `agent:${agent.name}`,
        verdict: "not-achieved", sourceTaskId: task.id, sourceRunId: result.runId,
      });
```

Add the imports:

```ts
import type { MemoryStore } from "../memory/memory-store.js";
import type { MemoryInput } from "../memory/types.js";
```

Then in `src/index.ts`, pass `memory` into the `Dispatcher` deps alongside `tasks`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/dispatcher.ts src/index.ts tests/dispatcher.test.ts
git commit -m "feat: record a memory outcome for every completed dispatched task"
```

---

### Task 8: Retention prunes the memory log

**Files:**
- Modify: `src/retention.ts` (`pruneOldData`)
- Modify: `src/triggers/retention.ts` (`startRetention` — the actual cron wrapper; `pruneOldData` alone is never called in production without going through this file)
- Modify: `src/index.ts` (the `startRetention({...})` call site)
- Test: `tests/retention.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.prune` (Task 1), `MemoryConfig` (Task 1).
- Produces: `RetentionResult` gains `removedMemoryRecords: number`. `pruneOldData` gains an optional `memory?: { store: MemoryStore; olderThan: Date; reflectionsOlderThan: Date }` option. `startRetention`'s opts gain optional `memory?: MemoryStore` and `memoryConfig?: MemoryConfig`, built into the `{ store, olderThan, reflectionsOlderThan }` shape internally before calling `pruneOldData`.

- [ ] **Step 0: Update one pre-existing test — required, not optional**

`tests/retention.test.ts`'s "does nothing, without throwing, when runs/ and workspaces/ don't exist yet" test asserts exact equality on the WHOLE return object:

```ts
await expect(pruneOldData({ dataDir: dir, olderThan: CUTOFF })).resolves.toEqual({
  removedRuns: [], removedWorkspaceFiles: [],
});
```

`toEqual` is exact — the moment `RetentionResult` gains `removedMemoryRecords`, this test fails on the extra key regardless of its value, with no code bug involved. This is the ONE pre-existing test in this file allowed to change for this task; every other existing test in the file accesses a single property (`.removedRuns` or `.removedWorkspaceFiles`) and is unaffected. Update it to:

```ts
await expect(pruneOldData({ dataDir: dir, olderThan: CUTOFF })).resolves.toEqual({
  removedRuns: [], removedWorkspaceFiles: [], removedMemoryRecords: 0,
});
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/retention.test.ts — add to the existing describe
  it("prunes raw memory records older than the cutoff", async () => {
    // Seed two records, one old one fresh. Expect removedMemoryRecords === 1.
  });

  it("keeps reflections past the raw-record cutoff", async () => {
    // A reflection older than `olderThan` but newer than `reflectionsOlderThan`
    // survives; raw records of the same age do not.
  });

  it("leaves the log untouched when no memory option is supplied", async () => {
    // Backwards compatibility: existing callers pass no memory option.
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- retention`
Expected: FAIL — `removedMemoryRecords` is undefined.

- [ ] **Step 3: Extend pruneOldData**

```ts
export interface RetentionResult {
  removedRuns: string[];
  removedWorkspaceFiles: string[];
  removedMemoryRecords: number;
}
```

At the end of `pruneOldData`, before the return:

```ts
  // Two cutoffs, not one: a reflection is already a compressed synthesis of
  // many raw records, so throwing it away on the raw schedule would discard
  // the most condensed thing in the log first.
  let removedMemoryRecords = 0;
  if (opts.memory) {
    removedMemoryRecords =
      (await opts.memory.store.prune({ olderThan: opts.memory.olderThan, keepKinds: ["reflection"] })) +
      (await opts.memory.store.prune({ olderThan: opts.memory.reflectionsOlderThan, keepKinds: [] }));
  }

  return { removedRuns, removedWorkspaceFiles, removedMemoryRecords };
```

Update the signature:

```ts
export async function pruneOldData(opts: {
  dataDir: string;
  olderThan: Date;
  memory?: { store: MemoryStore; olderThan: Date; reflectionsOlderThan: Date };
}): Promise<RetentionResult>
```

- [ ] **Step 3b: Thread it through the actual scheduled job**

`pruneOldData` is only ever invoked from `startRetention` in `src/triggers/retention.ts` — Step 3 alone leaves the new option dead code in production. Read that file in full (it is short); add to its `opts` type:

```ts
  memory?: MemoryStore;
  memoryConfig?: MemoryConfig;
```

Inside the scheduled callback, build the `memory` argument for `pruneOldData` only when both are present:

```ts
      const { removedRuns, removedWorkspaceFiles, removedMemoryRecords } = await pruneOldData({
        dataDir: opts.dataDir,
        olderThan,
        ...(opts.memory && opts.memoryConfig
          ? {
              memory: {
                store: opts.memory,
                olderThan: new Date(now().getTime() - opts.memoryConfig.retentionDays * 24 * 60 * 60 * 1000),
                reflectionsOlderThan: new Date(now().getTime() - opts.memoryConfig.reflectionRetentionDays * 24 * 60 * 60 * 1000),
              },
            }
          : {}),
      });
```

Add `removedMemoryRecords` to the existing `console.log` line and to the Discord message, following the exact same "only mention it if non-zero" pattern the file already uses for `removedRuns`/`removedWorkspaceFiles`/`orphanedRuns` — do not make the job noisier than it is today when memory is disabled or nothing was pruned. Add the two type imports (`MemoryStore` from `../memory/memory-store.js`, `MemoryConfig` from `../config.js`).

Then in `src/index.ts`, find the `startRetention({...})` call (it sits beside the `startDigest` call already grepped for Task 6) and add `memory` and `memoryConfig: config.memory` to its arguments, the same way `tasks`/`config.memory` are passed elsewhere.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retention.ts src/triggers/retention.ts src/index.ts tests/retention.test.ts
git commit -m "feat: prune the memory log on the retention schedule"
```

---

### Task 9: The successor pass

**Files:**
- Create: `src/memory/successor.ts`
- Modify: `src/control/dispatcher.ts` (call it from the success branch)
- Test: `tests/memory-successor.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (1), `assessNovelty` (4), `priorityScore`/`toPriority` (3), `TaskStore` (existing), `MemoryConfig` (1).
- Produces: `proposeSuccessors(input: SuccessorInput): Promise<string[]>` returning created task ids, where
  `SuccessorInput = { parentTask: Task; summary: string; parentDepth: number; agentName: string; tasks: TaskStore; memory: MemoryStore; config: MemoryConfig; suggest: SuccessorSuggester; now: Date }`,
  `SuccessorSuggestion = { text: string; domain: string; subject: string; importance: number; goalAlignment: number }`, and
  `SuccessorSuggester = (summary: string) => Promise<SuccessorSuggestion[]>`.

The suggester is injected rather than built here so the whole function is testable with plain data and no LLM. Production wires it to the same cheap-model call shape `LlmRouter` already uses.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memory-successor.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";
import { proposeSuccessors, type SuccessorSuggestion } from "../src/memory/successor.js";
import { TaskStore } from "../src/control/task-store.js";
import type { Task } from "../src/control/task-store.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");

const CONFIG = {
  enabled: true, retentionDays: 90, reflectionRetentionDays: 365,
  similarityThreshold: 0.75, stalenessDays: 30, recencyHalfLifeDays: 14,
  maxChainDepth: 3, maxAgentTasksPerDay: 20,
  weights: { goal: 0.5, novelty: 0.25, importance: 0.15, recency: 0.1 },
} as const;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "cai-successor-"));
  return { tasks: new TaskStore(dir), memory: new MemoryStore(dir) };
}

function suggestion(over: Partial<SuccessorSuggestion> = {}): SuccessorSuggestion {
  return { text: "investigate pricing tiers", domain: "research", subject: "investigate pricing tiers", importance: 5, goalAlignment: 0.6, ...over };
}

function parent(over: Partial<Task> = {}): Task {
  return { id: "task-parent", text: "original work", priority: 30, status: "done", createdBy: "agent:research", createdAt: NOW.toISOString(), ...over };
}

function input(over: Record<string, unknown> = {}) {
  const { tasks, memory } = harness();
  return {
    parentTask: parent(), summary: "found three candidates", parentDepth: 0,
    agentName: "research", tasks, memory, config: { ...CONFIG },
    suggest: async () => [suggestion()], now: NOW, ...over,
  } as Parameters<typeof proposeSuccessors>[0];
}

describe("proposeSuccessors", () => {
  it("creates a task per suggestion, recorded at depth parent+1", async () => {
    const args = input({ suggest: async () => [suggestion(), suggestion({ subject: "compare hosting costs", text: "compare hosting costs" })] });
    const created = await proposeSuccessors(args);
    expect(created).toHaveLength(2);
    const records = await args.memory.list();
    expect(records.every((r) => r.kind === "proposal" && r.chainDepth === 1)).toBe(true);
    expect((await args.tasks.list()).every((t) => t.parentId === "task-parent")).toBe(true);
  });

  it("proposes nothing once the depth cap is reached, without calling the suggester", async () => {
    const suggest = vi.fn(async () => [suggestion()]);
    const args = input({ parentDepth: CONFIG.maxChainDepth, suggest });
    expect(await proposeSuccessors(args)).toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  });

  it("drops a suggestion the novelty gate suppresses", async () => {
    const args = input({ suggest: async () => [suggestion(), suggestion({ subject: "compare hosting costs", text: "compare hosting costs" })] });
    await args.memory.append({
      domain: "research", kind: "outcome", subject: "investigate pricing tiers",
      body: "done", importance: 5, createdBy: "agent:research", verdict: "achieved",
    });
    expect(await proposeSuccessors(args)).toHaveLength(1);
  });

  it("stops at the daily cap on agent-originated tasks", async () => {
    const args = input({ config: { ...CONFIG, maxAgentTasksPerDay: 1 } });
    await args.tasks.create({ text: "already queued today", createdBy: "agent:research" });
    expect(await proposeSuccessors(args)).toEqual([]);
  });

  it("caps priority below the human default even for a maximal suggestion", async () => {
    const args = input({ suggest: async () => [suggestion({ goalAlignment: 1, importance: 10 })] });
    await proposeSuccessors(args);
    expect((await args.tasks.list())[0]!.priority).toBeLessThanOrEqual(49);
  });

  it("proposes at most three successors from one completed task", async () => {
    const args = input({ suggest: async () => [1, 2, 3, 4, 5].map((n) => suggestion({ subject: `distinct subject ${n}`, text: `distinct body ${n}` })) });
    expect(await proposeSuccessors(args)).toHaveLength(3);
  });

  it("returns [] rather than throwing when the suggester rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const args = input({ suggest: async () => { throw new Error("model unavailable"); } });
      expect(await proposeSuccessors(args)).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("proposes nothing when memory is disabled", async () => {
    expect(await proposeSuccessors(input({ config: { ...CONFIG, enabled: false } }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- memory-successor`
Expected: FAIL — cannot resolve `../src/memory/successor.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/successor.ts
import type { MemoryConfig } from "../config.js";
import type { Task, TaskStore } from "../control/task-store.js";
import type { MemoryStore } from "./memory-store.js";
import { assessNovelty } from "./novelty-gate.js";
import { priorityScore, toPriority } from "./scoring.js";

export interface SuccessorSuggestion {
  text: string;
  domain: string;
  subject: string;
  importance: number;
  goalAlignment: number;
}

export type SuccessorSuggester = (summary: string) => Promise<SuccessorSuggestion[]>;

export interface SuccessorInput {
  parentTask: Task;
  summary: string;
  parentDepth: number;
  agentName: string;
  tasks: TaskStore;
  memory: MemoryStore;
  config: MemoryConfig;
  suggest: SuccessorSuggester;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUCCESSORS = 3;

/**
 * Turns a finished run into the next piece of work — the edge that makes this
 * a loop rather than a queue. Three independent mechanical bounds, because
 * this is the one place the system can generate work for itself without limit:
 *
 *  1. depth — a successor chain stops at config.maxChainDepth.
 *  2. breadth — at most MAX_SUCCESSORS per completed task.
 *  3. rate — a rolling-day ceiling across ALL agent-originated tasks, which
 *     catches a wide shallow fan-out that no per-chain cap would.
 *
 * The Governor's daily budget remains the final backstop underneath all three.
 * Never throws: a successor pass failing must not disturb the parent task,
 * which has already succeeded.
 */
export async function proposeSuccessors(input: SuccessorInput): Promise<string[]> {
  if (!input.config.enabled) return [];
  if (input.parentDepth >= input.config.maxChainDepth) return [];

  try {
    const since = input.now.getTime() - DAY_MS;
    const todaysAgentTasks = (await input.tasks.list()).filter(
      (t) => t.createdBy.startsWith("agent:") && new Date(t.createdAt).getTime() >= since,
    ).length;
    if (todaysAgentTasks >= input.config.maxAgentTasksPerDay) return [];

    const suggestions = (await input.suggest(input.summary)).slice(0, MAX_SUCCESSORS);
    const records = await input.memory.list();
    const created: string[] = [];

    for (const suggestion of suggestions) {
      if (todaysAgentTasks + created.length >= input.config.maxAgentTasksPerDay) break;

      const verdict = assessNovelty(
        { domain: suggestion.domain, subject: suggestion.subject },
        records,
        { threshold: input.config.similarityThreshold, stalenessDays: input.config.stalenessDays, now: input.now },
      );
      if (verdict.kind === "suppressed") continue;

      const priority = toPriority(
        priorityScore(
          {
            goalAlignment: suggestion.goalAlignment,
            maxSimilarity: verdict.maxSimilarity,
            importance: suggestion.importance,
            proposedAt: input.now.toISOString(),
          },
          input.config.weights,
          input.now,
        ),
      );

      const task = await input.tasks.create({
        text: suggestion.text,
        priority,
        createdBy: `agent:${input.agentName}`,
        parentId: input.parentTask.id,
        wantsDetail: true,
      });
      await input.memory.append({
        domain: suggestion.domain,
        kind: "proposal",
        subject: suggestion.subject,
        body: suggestion.text,
        importance: suggestion.importance,
        createdBy: `agent:${input.agentName}`,
        sourceTaskId: task.id,
        chainDepth: input.parentDepth + 1,
      });
      created.push(task.id);
    }
    return created;
  } catch (error) {
    console.error("[successor] pass failed; parent task is unaffected", error);
    return [];
  }
}
```

- [ ] **Step 4: Call it from the dispatcher**

In `executeAndFinalize`'s plain-success branch only (not the retries-exhausted branch — that objective was never met, so a successor built on it would compound a failure), after the outcome record from Task 7:

```ts
      if (deps.memory && deps.memoryConfig && deps.suggestSuccessors) {
        // `task` is the task that JUST completed — it is the "parentTask" for
        // whatever proposeSuccessors creates next, so what's needed here is
        // task's OWN chain depth, not its parent's. That depth was recorded
        // on task's own proposal record at creation time (Task 5's queueTask,
        // or this same successor mechanism one level up), keyed by
        // sourceTaskId === task.id — NOT task.parentId, which would fetch
        // the depth of the task ONE LEVEL ABOVE this one and silently
        // undercount by one at every generation past the first.
        const parentDepth = (await deps.memory.list()).find((r) => r.sourceTaskId === task.id)?.chainDepth ?? 0;
        await proposeSuccessors({
          parentTask: task, summary: result.summary, parentDepth,
          agentName: agent.name, tasks: deps.tasks, memory: deps.memory,
          config: deps.memoryConfig, suggest: deps.suggestSuccessors, now: now(),
        });
      }
```

Add `memoryConfig?: MemoryConfig` and `suggestSuccessors?: SuccessorSuggester` to `DispatcherDeps`, and wire both in `src/index.ts`. Implement the production suggester next to `LlmRouter` in `src/control/`, using the same cheap-model call and the same 60-second abort `LlmRouter` uses; on any error or unparseable response it returns `[]`.

**Verify this wiring with a test, not just by inspection**: add one more case to `tests/dispatcher.test.ts` in this task (not Task 7) — a task created with a memory proposal record at `chainDepth: 2` (simulating it being a second-generation successor) completes successfully; assert the `proposeSuccessors`/`suggest` stub it was given receives a call (i.e., successors are attempted, since 2 < the default `maxChainDepth` of 3), proving the depth read back matches what was written rather than silently defaulting to 0 every time.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/successor.ts src/control/dispatcher.ts src/index.ts tests/memory-successor.test.ts
git commit -m "feat: turn a completed run into successor tasks, depth- and rate-capped"
```

---

### Task 10: The reflection pass

**Files:**
- Create: `src/memory/reflection.ts`
- Modify: `src/index.ts` (schedule it), `src/config.ts` (add `reflection` schedule fields to `MemorySchema`)
- Test: `tests/memory-reflection.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (1), `RunStore.listSince` (existing), `MemoryConfig` (1).
- Produces: `runReflection(input: ReflectionInput): Promise<MemoryRecord[]>` where
  `ReflectionInput = { memory: MemoryStore; runs: RunResult[]; synthesise: (digestText: string) => Promise<Array<{ domain: string; subject: string; body: string; importance: number }>>; now: Date }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/memory-reflection.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/memory/memory-store.js";
import { runReflection } from "../src/memory/reflection.js";
import type { RunResult } from "../src/run-store.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");

function memoryStore(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), "cai-reflection-")));
}

async function seedOutcome(memory: MemoryStore): Promise<void> {
  await memory.append({
    domain: "research", kind: "outcome", subject: "x", body: "done",
    importance: 5, createdBy: "agent:research", verdict: "achieved",
  });
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "r1", agent: "builder", status: "success",
    startedAt: NOW.toISOString(), endedAt: NOW.toISOString(),
    durationMs: 1000, costUsd: 0.01, inputTokens: 1, outputTokens: 1,
    turns: 1, summary: "tried something", ...overrides,
  };
}

describe("runReflection", () => {
  it("appends one reflection record per synthesised conclusion", async () => {
    const memory = memoryStore();
    await seedOutcome(memory);
    const synthesise = async () => [
      { domain: "research", subject: "pattern A", body: "conclusion A", importance: 6 },
      { domain: "research", subject: "pattern B", body: "conclusion B", importance: 4 },
    ];
    const written = await runReflection({ memory, runs: [], synthesise, now: NOW });
    expect(written).toHaveLength(2);
    expect(written.every((r) => r.kind === "reflection")).toBe(true);
    expect((await memory.list()).filter((r) => r.kind === "reflection")).toHaveLength(2);
  });

  it("supersedes by recency rather than rewriting an existing reflection", async () => {
    const memory = memoryStore();
    await seedOutcome(memory);
    const oldReflection = await memory.append({
      domain: "research", kind: "reflection", subject: "recurring pattern",
      body: "old conclusion", importance: 5, createdBy: "system:reflection",
    });
    const synthesise = async () => [
      { domain: "research", subject: "recurring pattern", body: "new conclusion", importance: 7 },
    ];
    await runReflection({ memory, runs: [], synthesise, now: NOW });
    const reflections = (await memory.list()).filter((r) => r.kind === "reflection");
    // Never rewritten in place: the old record survives unchanged, and the
    // new one is appended alongside it — a later reader supersedes by
    // recency, not by mutation.
    expect(reflections).toHaveLength(2);
    expect(reflections.find((r) => r.id === oldReflection.id)?.body).toBe("old conclusion");
    expect(reflections.some((r) => r.body === "new conclusion")).toBe(true);
  });

  it("passes both outcome records and run verdicts to the synthesiser", async () => {
    const memory = memoryStore();
    let capturedDigest = "";
    const synthesise = async (digestText: string) => {
      capturedDigest = digestText;
      return [];
    };
    const badRun = run({ verifiedOutcome: { verdict: "not-achieved", reason: "missed the mark" } });
    await runReflection({ memory, runs: [badRun], synthesise, now: NOW });
    expect(capturedDigest).toContain("not-achieved");
    expect(capturedDigest).toContain("missed the mark");
  });

  it("returns an empty array and writes nothing when there is no history", async () => {
    const memory = memoryStore();
    const synthesise = vi.fn(async () => [{ domain: "x", subject: "y", body: "z", importance: 5 }]);
    const written = await runReflection({ memory, runs: [], synthesise, now: NOW });
    expect(written).toEqual([]);
    expect(synthesise).not.toHaveBeenCalled();
    expect(await memory.list()).toEqual([]);
  });

  it("never throws when the synthesiser rejects", async () => {
    const memory = memoryStore();
    await seedOutcome(memory);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const synthesise = async () => {
        throw new Error("model unavailable");
      };
      const written = await runReflection({ memory, runs: [], synthesise, now: NOW });
      expect(written).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- memory-reflection`
Expected: FAIL — cannot resolve `../src/memory/reflection.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/reflection.ts
import type { RunResult } from "../run-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryRecord } from "./types.js";

export interface ReflectionInput {
  memory: MemoryStore;
  runs: RunResult[];
  synthesise: (digestText: string) => Promise<Array<{ domain: string; subject: string; body: string; importance: number }>>;
  now: Date;
}

/**
 * Generative Agents' second mechanism: periodically synthesise raw memories
 * into higher-level conclusions that then influence future behaviour.
 *
 * This is the closest thing in the system to cross-cutting judgment about what
 * to focus on — deliberately shaped as a periodic batch job whose output is
 * advisory DATA other components read, rather than a standing authority every
 * task must route through. See the spec's Non-goals for why not a manager
 * agent.
 *
 * Reflections are APPENDED. A newer reflection supersedes an older one by
 * recency; nothing is ever rewritten in place, because LLM-rewritten memory
 * degrades over successive updates.
 */
export async function runReflection(input: ReflectionInput): Promise<MemoryRecord[]> {
  try {
    const records = await input.memory.list();
    const outcomes = records.filter((r) => r.kind === "outcome");
    if (outcomes.length === 0 && input.runs.length === 0) return [];

    const digestText = [
      ...outcomes.map((r) => `[${r.domain}] ${r.subject} → ${r.verdict ?? "unknown"}: ${r.body}`),
      ...input.runs.map((r) => `[run:${r.agent}] ${r.status} (${r.verifiedOutcome?.verdict ?? "ungraded"}): ${r.summary}`),
    ].join("\n");

    const conclusions = await input.synthesise(digestText);
    const written: MemoryRecord[] = [];
    for (const conclusion of conclusions) {
      written.push(
        await input.memory.append({
          domain: conclusion.domain,
          kind: "reflection",
          subject: conclusion.subject,
          body: conclusion.body,
          importance: conclusion.importance,
          createdBy: "system:reflection",
          ts: input.now.toISOString(),
        }),
      );
    }
    return written;
  } catch (error) {
    console.error("[reflection] pass failed", error);
    return [];
  }
}
```

- [ ] **Step 4: Add the schedule and wire it**

Add to `MemorySchema` in `src/config.ts`:

```ts
    /** Weekly, Monday 03:00 by default — batch synthesis, not routine reporting. */
    reflectionSchedule: z.string().default("0 3 * * 1"),
    reflectionTimezone: IanaTimezone.default("UTC"),
    /** How far back a reflection pass reads. */
    reflectionWindowDays: z.number().int().positive().default(14),
```

Apply `.superRefine(validateCronSchedule)` equivalently to how `DigestSchema` validates its own schedule — a bad cron expression must fail boot, not silently never schedule. Since `MemorySchema` uses different field names, add an explicit check inside a `superRefine` calling `isValidCron(v.reflectionSchedule, v.reflectionTimezone)`.

In `src/index.ts`, schedule it with `Cron` exactly as the digest and retention jobs are scheduled, passing `runs: await runStore.listSince(...)` for the window and a `synthesise` implementation built on the same cheap-model call shape as `LlmRouter`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/reflection.ts src/config.ts src/index.ts tests/memory-reflection.test.ts
git commit -m "feat: weekly reflection pass synthesising outcomes into conclusions"
```

---

### Task 11: Retrieval into prompts, and digest reporting

**Files:**
- Create: `src/memory/retrieval.ts`
- Modify: `src/control/dispatcher.ts` (prepend retrieved context to `promptContext`)
- Modify: `src/digest.ts` (`buildDigestText`), `src/triggers/digest.ts` (`startDigest` — the actual cron wrapper that calls `buildDigestText`; `src/digest.ts` alone is dead code in production without this)
- Modify: `src/index.ts` (the `startDigest({...})` call site)
- Modify: `agents/opportunity-scout/prompt.md`, `agents/improvement-scout/prompt.md`, `agents/cleanup-scout/prompt.md`, `agents/dependency-scout/prompt.md`
- Test: `tests/memory-retrieval.test.ts`, `tests/digest.test.ts`

**Interfaces:**
- Consumes: `similarity` (2), `retrievalScore` (3), `MemoryRecord` (1).
- Produces: `retrieveContext(subject: string, domain: string, records: MemoryRecord[], opts: { limit: number; halfLifeDays: number; now: Date }): string` — returns `""` when nothing is relevant.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/memory-retrieval.test.ts
import { describe, expect, it } from "vitest";
import { retrieveContext } from "../src/memory/retrieval.js";

describe("retrieveContext", () => {
  it("returns the most relevant records first", async () => {
    // Two records, one clearly related → related one appears first.
  });

  it("returns an empty string when nothing is relevant", async () => {
    // No records above the floor → "" so nothing is appended to the prompt.
  });

  it("respects the limit", async () => {
    // 10 relevant records, limit 3 → 3 lines.
  });

  it("only draws from the same domain", async () => {
    // A same-subject record in another domain is excluded.
  });

  it("includes reflections, unlike the novelty gate", async () => {
    // A reflection IS useful context to hand an agent, even though it is
    // never something to suppress a proposal against.
  });
});
```

For `tests/digest.test.ts`, add a case asserting the digest body includes memory counts (records written, duplicates suppressed) for the window, and that it omits the section entirely when there is no memory activity — matching how the digest already handles empty sections.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- memory-retrieval digest`
Expected: FAIL on the new cases.

- [ ] **Step 3: Write the retrieval helper**

```ts
// src/memory/retrieval.ts
import { retrievalScore } from "./scoring.js";
import { similarity } from "./similarity.js";
import type { MemoryRecord } from "./types.js";

/** Below this, a record is noise rather than context, and padding a prompt with noise costs tokens and attention. */
const RELEVANCE_FLOOR = 0.2;

/**
 * Builds the "what do I already know about this?" block prepended to a
 * dispatched agent's prompt. Unlike the novelty gate, similarity is a BONUS
 * here and reflections are included — a synthesised conclusion is exactly the
 * kind of thing an agent should start a run knowing.
 */
export function retrieveContext(
  subject: string,
  domain: string,
  records: MemoryRecord[],
  opts: { limit: number; halfLifeDays: number; now: Date },
): string {
  const scored = records
    .filter((r) => r.domain === domain)
    .map((r) => ({ record: r, sim: similarity({ subject }, r) }))
    .filter((s) => s.sim >= RELEVANCE_FLOOR)
    .map((s) => ({
      record: s.record,
      score: retrievalScore({ similarity: s.sim, importance: s.record.importance, ts: s.record.ts }, opts.now, opts.halfLifeDays),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);

  if (scored.length === 0) return "";
  const lines = scored.map((s) => `- (${s.record.kind}, ${s.record.ts.slice(0, 10)}) ${s.record.subject}: ${s.record.body}`);
  return `\n\nWhat this system already knows about this area:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Prepend it in the dispatcher**

In `executeAndFinalize`, extend the existing `promptContext` construction (line ~181) — keep `DETAIL_INSTRUCTION` and `verificationNote` exactly as they are and append the retrieved block:

```ts
    const memoryContext =
      deps.memory && deps.memoryConfig?.enabled
        ? retrieveContext(task.text.slice(0, 200), agent.name, await deps.memory.list(), {
            limit: 5,
            halfLifeDays: deps.memoryConfig.recencyHalfLifeDays,
            now: now(),
          })
        : "";
    const promptContext = `${task.text}${task.wantsDetail ? `\n\n${DETAIL_INSTRUCTION}` : ""}${verificationNote}${memoryContext}`;
```

- [ ] **Step 5: Add a `recallMemory` tool for cron agents**

Step 4 only reaches *dispatched* agents — cron scouts are triggered through the
Orchestrator, never the dispatcher, so they would get no retrieved context at
all. They are protected from proposing duplicates either way (Task 5's gate
refuses at `queueTask`), but a scout that can read the log first wastes fewer
turns proposing things that will be refused.

Add a third tool to the existing `taskQueueServer` in `src/runner/sdk-runner.ts`,
beside `listMyTasks` and `recentFailures` (which it mirrors exactly — no
outward effect, so no grant, available at every tier), registered only when
`memoryDep` is present:

```ts
            ...(memoryDep
              ? [
                  tool(
                    "recallMemory",
                    "Search what this system already knows about a subject — prior findings, outcomes, and reflections. Call this BEFORE proposing work, so you don't propose something that has already been done and will be refused.",
                    { subject: z.string().min(1).max(200), domain: z.string().min(1) },
                    async ({ subject, domain }) => {
                      const text = retrieveContext(subject, domain, await memoryDep.list(), {
                        limit: 8,
                        halfLifeDays: memoryConfigDep?.recencyHalfLifeDays ?? 14,
                        now: new Date(),
                      });
                      return { content: [{ type: "text" as const, text: text || "Nothing recorded on this subject yet." }] };
                    },
                  ),
                ]
              : []),
```

Then add one line to each of the four scout prompts (`agents/opportunity-scout/prompt.md`, `agents/improvement-scout/prompt.md`, `agents/cleanup-scout/prompt.md`, `agents/dependency-scout/prompt.md`), in the same place each already mentions `listMyTasks`: *"Call `recallMemory` for each idea before you queue it — work already recorded as achieved will be refused."*

- [ ] **Step 6: Add the digest section**

`buildDigestText` (`src/digest.ts`) is pure text-building over stores it's handed directly — it does not read config or construct anything itself, matching its existing `{ store, tasks, since }` shape. Add an optional fourth field:

```ts
export async function buildDigestText(opts: { store: RunStore; tasks: TaskStore; since: Date; memory?: MemoryStore }): Promise<string> {
```

Near the end, before the final `lines.join("\n")`, compute counts scoped to `opts.since` (reuse `new Date(r.ts) >= opts.since` as the window filter, matching how `finishedTasks` already filters by `since` a few lines up) and append a line only when at least one is non-zero:

```ts
  if (opts.memory) {
    const recentMemory = (await opts.memory.list()).filter((r) => new Date(r.ts) >= opts.since);
    const byKind = new Map<string, number>();
    for (const r of recentMemory) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const suppressed = recentMemory.filter((r) => r.kind === "proposal" && r.body.startsWith("suppressed as a duplicate")).length;
    if (recentMemory.length > 0) {
      const kindSummary = [...byKind.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
      lines.push(`🧠 Memory: ${kindSummary}${suppressed > 0 ? ` (${suppressed} duplicate proposal(s) suppressed)` : ""}`);
    }
  }
```

This must not change the function's existing "nothing happened" early return (line ~37) — that check stays exactly as it reads today; a memory-only day with no runs/tasks does not currently trigger the digest firing at all, and this task does not change when the digest fires, only what it says once it does.

- [ ] **Step 6b: Thread `memory` through to production**

`buildDigestText` is only ever called from `startDigest` in `src/triggers/digest.ts` — add `memory?: MemoryStore` to its `opts` type and pass it straight through to the `buildDigestText({...})` call inside the scheduled callback. Then in `src/index.ts`, find the `startDigest({...})` call (grepped for Task 6) and add `memory` to its arguments, the same way `tasks` is already passed.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Update the docs**

`README.md` — extend the "The system can queue its own tasks, not just yours" section to describe the novelty gate, computed priority, and successor pass. `docs/system-context.md` — add the memory log to "What this system is". Both should read as describing shipped behaviour, matching how outcome verification was documented after it landed.

- [ ] **Step 9: Commit**

```bash
git add src/memory/retrieval.ts src/runner/sdk-runner.ts src/control/dispatcher.ts src/digest.ts src/triggers/digest.ts src/index.ts agents/*/prompt.md README.md docs/system-context.md tests/memory-retrieval.test.ts tests/digest.test.ts
git commit -m "feat: retrieve prior context into agent prompts and report memory in the digest"
```

---

## Natural checkpoint

Tasks 1-8 are a coherent shippable increment: the system remembers what it did, refuses to re-propose finished work, and ranks proposals instead of treating them equally. Tasks 9-11 close the loop and make it observable. If work is paused, pause after Task 8.
