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

  private windowsPath(): string {
    return join(this.dataDir, "state", "rate-limit-windows.json");
  }

  async record(info: Omit<RateLimitSnapshot, "recordedAt">, now: Date = new Date()): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    const snapshot: RateLimitSnapshot = { ...info, recordedAt: now.toISOString() };
    await writeFile(this.path(), JSON.stringify(snapshot, null, 2) + "\n");
    // Distinct windows (five_hour vs seven_day) each report their own events
    // independently — keeping a per-type reading alongside the single
    // "latest" snapshot above lets callers show both at once instead of
    // whichever window's event happened to arrive most recently.
    if (info.rateLimitType) {
      const windows = await this.readWindows();
      windows[info.rateLimitType] = snapshot;
      await writeFile(this.windowsPath(), JSON.stringify(windows, null, 2) + "\n");
    }
  }

  /** Empty object means no typed reading has ever been recorded — never null, since there's no "unreadable file" state worth distinguishing here (callers already treat a missing type as "no data" for that window). */
  async readWindows(): Promise<Record<string, RateLimitSnapshot>> {
    try {
      return JSON.parse(await readFile(this.windowsPath(), "utf8")) as Record<string, RateLimitSnapshot>;
    } catch {
      return {};
    }
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
