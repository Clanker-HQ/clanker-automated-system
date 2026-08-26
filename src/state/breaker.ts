import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunStatus } from "../run-store.js";

export interface BreakerState {
  consecutiveFailures: number;
  disabledAt?: string;
}

const FAILURE_STATUSES: ReadonlySet<RunStatus> = new Set(["failed", "timeout"]);
const TRIP_THRESHOLD = 3;

export class BreakerStore {
  constructor(private readonly dataDir: string) {}

  private path(agentName: string): string {
    return join(this.dataDir, "state", agentName, "breaker.json");
  }

  private async read(agentName: string): Promise<BreakerState> {
    try {
      return JSON.parse(await readFile(this.path(agentName), "utf8")) as BreakerState;
    } catch {
      return { consecutiveFailures: 0 };
    }
  }

  private async write(agentName: string, state: BreakerState): Promise<void> {
    await mkdir(join(this.dataDir, "state", agentName), { recursive: true });
    await writeFile(this.path(agentName), JSON.stringify(state, null, 2) + "\n");
  }

  async recordResult(agentName: string, status: RunStatus, now: Date = new Date()): Promise<BreakerState> {
    const current = await this.read(agentName);
    const next: BreakerState = FAILURE_STATUSES.has(status)
      ? { consecutiveFailures: current.consecutiveFailures + 1 }
      : { consecutiveFailures: 0 };
    if (next.consecutiveFailures >= TRIP_THRESHOLD) next.disabledAt = now.toISOString();
    await this.write(agentName, next);
    return next;
  }

  async isTripped(agentName: string): Promise<boolean> {
    return (await this.read(agentName)).consecutiveFailures >= TRIP_THRESHOLD;
  }

  async reset(agentName: string): Promise<void> {
    await this.write(agentName, { consecutiveFailures: 0 });
  }
}
