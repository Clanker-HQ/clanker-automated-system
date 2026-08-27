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
      return JSON.parse(await readFile(this.path(runId), "utf8")) as string[];
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
