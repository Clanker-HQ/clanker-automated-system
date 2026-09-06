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
    if (info.rateLimitType) await this.writeWindow(info.rateLimitType, snapshot);
  }

  /**
   * Writes several windows' readings at once — e.g. a proactive, multi-window
   * snapshot from a source other than the live rate_limit_event stream (see
   * Governor.recordRateLimitWindows). Deliberately separate from `record()`
   * above: this NEVER touches the single "latest" snapshot admit() gates on,
   * so a source feeding this can only ever affect display, never admission.
   */
  async recordWindows(windows: Record<string, Omit<RateLimitSnapshot, "recordedAt">>, now: Date = new Date()): Promise<void> {
    for (const [type, info] of Object.entries(windows)) {
      await this.writeWindow(type, { ...info, recordedAt: now.toISOString() });
    }
  }

  private async writeWindow(type: string, snapshot: RateLimitSnapshot): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    const windows = await this.readWindows();
    windows[type] = snapshot;
    await writeFile(this.windowsPath(), JSON.stringify(windows, null, 2) + "\n");
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
