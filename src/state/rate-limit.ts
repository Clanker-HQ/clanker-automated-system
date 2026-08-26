import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RateLimitSnapshot {
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  recordedAt: string;
}

export class RateLimitTracker {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "rate-limit.json");
  }

  async record(info: Omit<RateLimitSnapshot, "recordedAt">, now: Date = new Date()): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    const snapshot: RateLimitSnapshot = { ...info, recordedAt: now.toISOString() };
    await writeFile(this.path(), JSON.stringify(snapshot, null, 2) + "\n");
  }

  /** null means "no reading yet" or "unreadable" — callers must fail OPEN on null, never treat it as rejected. */
  async read(): Promise<RateLimitSnapshot | null> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as RateLimitSnapshot;
    } catch {
      return null;
    }
  }
}
