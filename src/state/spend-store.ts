import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // A torn write or corrupt file is not the same as "nothing written
        // yet" — silently returning the zero-default here would make the
        // next write permanently erase the real balance. Log it so a
        // genuine loss is visible instead of vanishing.
        console.error("[spend-store] failed to read spend.json, treating as empty", err);
      }
      return { balanceUsd: 0, commitments: [] };
    }
  }

  async write(state: SpendState): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFileAtomic(this.path(), JSON.stringify(state, null, 2) + "\n");
  }
}
