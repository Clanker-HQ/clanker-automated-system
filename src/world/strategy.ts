import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

export interface Expectation {
  id: string;
  /** ISO date by which this should be true. */
  dueAt: string;
  check:
    | { kind: "netIncomeUsd"; atLeast: number }
    | { kind: "productRevenueUsd"; product: string; atLeast: number }
    | { kind: "portfolioStatus"; slug: string; is: "live" };
}

export interface Strategy {
  writtenAt: string;
  /** What the system is trying to do about goals.yaml this cycle, in prose. */
  intent: string;
  /** Effort split for the cycle. Must sum to 100. */
  allocation: { research: number; build: number; maintain: number };
  expectations: Expectation[];
  /** Why this differs from the previous cycle. Empty on the first ever cycle. */
  changeReason: string;
}

const FILENAME = /^strategy-.+\.json$/;

/**
 * One JSON file per cycle, append-only, never rewritten — a past strategy
 * stays exactly as written even when it turns out to have been wrong. The
 * history is the only evidence of whether the overseer's judgment is
 * improving over time (see Design §3), so nothing here ever edits or deletes
 * an existing file. Modelled on MetricsStore (src/state/metrics-store.ts).
 */
export class StrategyStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "world", "strategy");
  }

  private path(writtenAt: string): string {
    return join(this.dir(), `strategy-${writtenAt.replace(/[:.]/g, "-")}.json`);
  }

  /**
   * Rejects an allocation that does not sum to 100 rather than
   * renormalising it — a renormalised allocation is a decision nobody made,
   * attributed to something that will be graded on it later.
   */
  async write(strategy: Strategy): Promise<void> {
    const { research, build, maintain } = strategy.allocation;
    const total = research + build + maintain;
    if (total !== 100) {
      throw new Error(`Strategy allocation must sum to 100, got ${total} (research=${research}, build=${build}, maintain=${maintain})`);
    }
    await mkdir(this.dir(), { recursive: true });
    await writeFileAtomic(this.path(strategy.writtenAt), JSON.stringify(strategy, null, 2) + "\n");
  }

  /** Every persisted strategy, oldest first by writtenAt. A file that fails to parse is logged and skipped, not thrown. */
  async all(): Promise<Strategy[]> {
    const names = await readdir(this.dir()).catch(() => [] as string[]);
    const strategies: Strategy[] = [];
    for (const name of names.filter((n) => FILENAME.test(n))) {
      try {
        strategies.push(JSON.parse(await readFile(join(this.dir(), name), "utf8")) as Strategy);
      } catch (error) {
        console.error(`[strategy-store] skipping unparseable strategy "${name}"`, error);
      }
    }
    strategies.sort((a, b) => (a.writtenAt < b.writtenAt ? -1 : a.writtenAt > b.writtenAt ? 1 : 0));
    return strategies;
  }

  /** The most recently written strategy, or null before any cycle has run. */
  async latest(): Promise<Strategy | null> {
    const all = await this.all();
    return all[all.length - 1] ?? null;
  }
}
