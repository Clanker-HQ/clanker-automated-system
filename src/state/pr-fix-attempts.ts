import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * How many times pr-reviewer may queue a builder fix for the same PR before
 * it must stop and hand the PR to a human instead. Matches the "3
 * consecutive failures" convention BreakerStore already uses elsewhere in
 * this file's family — bounded so a PR whose findings a builder can't
 * actually resolve doesn't loop indefinitely through the queue, each pass
 * spending real turns and money for no forward progress.
 */
export const MAX_FIX_ATTEMPTS_PER_PR = 3;

/**
 * Tracks, per (repo, PR number), how many automatic fix attempts pr-reviewer
 * has already queued for it — the hard, code-level boundary behind
 * MAX_FIX_ATTEMPTS_PER_PR (see requestFix in sdk-runner.ts). Deliberately a
 * flat count rather than anything richer: the only question this needs to
 * answer is "has this PR already had its automatic chances," not why past
 * attempts failed.
 */
export class PrFixAttemptStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "pr-fix-attempts.json");
  }

  private async readAll(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, number>): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFile(this.path(), JSON.stringify(data, null, 2) + "\n");
  }

  async get(key: string): Promise<number> {
    return (await this.readAll())[key] ?? 0;
  }

  async increment(key: string): Promise<number> {
    const data = await this.readAll();
    const next = (data[key] ?? 0) + 1;
    data[key] = next;
    await this.writeAll(data);
    return next;
  }

  /** Called once a PR this store was tracking merges — no reason to keep counting against a PR that's done. */
  async reset(key: string): Promise<void> {
    const data = await this.readAll();
    if (!(key in data)) return;
    delete data[key];
    await this.writeAll(data);
  }

  /**
   * Every `(repo, PR)` key that has already used up all of
   * MAX_FIX_ATTEMPTS_PER_PR — the same PRs `requestFix` (sdk-runner.ts) is
   * now refusing and telling pr-reviewer to hand to a human instead, via a
   * comment left on the PR itself. That comment is the only trace today:
   * nothing reads this file back to say which PRs are actually waiting on a
   * human, so this store — despite already holding the exact answer — never
   * surfaced it anywhere a human would see it without going and checking
   * every repo's every PR by hand. Backs digest.ts's "needing human
   * attention" section.
   */
  async listExhausted(): Promise<string[]> {
    const data = await this.readAll();
    return Object.entries(data)
      .filter(([, count]) => count >= MAX_FIX_ATTEMPTS_PER_PR)
      .map(([key]) => key);
  }
}
