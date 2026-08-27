import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class ApprovedGrantsStore {
  constructor(private readonly dataDir: string) {}

  private path(runId: string): string {
    return join(this.dataDir, "runs", runId, "approved-grants.json");
  }

  /** Grant ids approved so far for this run. Empty (not throwing) when none exist yet. */
  async read(runId: string): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(runId), "utf8"));
      // A shape guard, not just a cast: a corrupted or hand-edited file that
      // isn't an array of strings (e.g. a bare JSON string) must not flow
      // into `.includes()` as if it were the list — a JSON *string* is
      // itself array-like enough that `.includes()` would silently become a
      // substring match, the same bug class `matchGrant` was fixed for.
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /** Idempotent: approving an already-approved grant is a no-op. Returns the updated list. */
  async approve(runId: string, grantRef: string): Promise<string[]> {
    const current = await this.read(runId);
    if (current.includes(grantRef)) return current;
    const updated = [...current, grantRef];
    await mkdir(join(this.dataDir, "runs", runId), { recursive: true });
    await writeFile(this.path(runId), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  }
}
