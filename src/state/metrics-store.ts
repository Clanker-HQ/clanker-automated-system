import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

export interface NotAchievedByAgent {
  agent: string;
  /** 0-1. */
  rate: number;
  successRunCount: number;
}

export interface Metrics {
  computedAt: string;
  windowDays: number;
  /**
   * Gross revenue in the window — the sum of every completed sale's
   * amountUsd, nothing subtracted. Reads as true net income only because
   * external spend is currently always $0 (no spend-card grant exists
   * yet); once the spend pot is funded this stops being "net" and the
   * field will need renaming. See the weekly-metrics-job plan's Global
   * Constraints for why revenue-per-spend isn't computed here yet.
   */
  netIncomeUsd: number;
  /** null when no run graded "success" fell in the window — the rate has no denominator. */
  notAchievedRate: number | null;
  notAchievedByAgent: NotAchievedByAgent[];
  /** null when no task finished "done" in the window. */
  costPerCompletedTaskUsd: number | null;
  /** null when no proposal was attempted in the window. */
  noveltySharePercent: number | null;
  suppressedProposalCount: number;
  /** null when no task is currently pending. */
  queueStarvationHours: number | null;
  /**
   * True when the revenue transport failed and `netIncomeUsd` is therefore a
   * data gap rather than a measured $0. Optional because snapshots written
   * before this field existed have no way to say either — absent reads as
   * "the revenue figure is trustworthy", which is correct for them: they were
   * all computed against FakeRevenueTransport, whose $0 was real.
   */
  revenueUnavailable?: boolean;
}

const FILENAME = /^metrics-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * One file per calendar date (UTC, taken from `computedAt`), not one file
 * overwritten in place like SpendStore — a delta needs history, and the
 * weekly cadence means one file per run is naturally bounded (retention is
 * out of scope for this plan; nothing here prunes old snapshots).
 */
export class MetricsStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "state");
  }

  private path(dateStamp: string): string {
    return join(this.dir(), `metrics-${dateStamp}.json`);
  }

  async write(metrics: Metrics): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    const dateStamp = metrics.computedAt.slice(0, 10);
    await writeFileAtomic(this.path(dateStamp), JSON.stringify(metrics, null, 2) + "\n");
  }

  /** Every persisted snapshot, oldest first. A file that fails to parse is logged and skipped, not thrown — one corrupt snapshot must never take down the whole digest that reads latestTwo(). */
  async listAll(): Promise<Metrics[]> {
    const names = await readdir(this.dir()).catch(() => [] as string[]);
    const all: Metrics[] = [];
    for (const name of names.filter((n) => FILENAME.test(n))) {
      try {
        all.push(JSON.parse(await readFile(join(this.dir(), name), "utf8")) as Metrics);
      } catch (error) {
        console.error(`[metrics-store] skipping unparseable snapshot "${name}"`, error);
      }
    }
    all.sort((a, b) => (a.computedAt < b.computedAt ? -1 : a.computedAt > b.computedAt ? 1 : 0));
    return all;
  }

  /** The most recent snapshot and the one before it. Either or both are null when fewer exist. */
  async latestTwo(): Promise<{ latest: Metrics | null; previous: Metrics | null }> {
    const all = await this.listAll();
    return { latest: all[all.length - 1] ?? null, previous: all[all.length - 2] ?? null };
  }
}
