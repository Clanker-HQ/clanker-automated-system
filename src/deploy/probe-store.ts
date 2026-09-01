import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

export interface ProbeResult {
  slug: string;
  /** The public URL actually requested — recorded so a warning can be acted on without re-deriving it. */
  url: string;
  lastProbeAt: string;
  ok: boolean;
  /** Consecutive failing passes up to and including lastProbeAt; 0 whenever ok. */
  consecutiveFailures: number;
  /** Short reason for the current failure, or null when ok. */
  detail: string | null;
}

/**
 * One writer (the prober), whole-set writes, no merge. Bounded by the number
 * of declared deployments, which deploy.maxLiveDeployments already caps — so
 * this file cannot grow without an operator raising that cap.
 */
export class ProbeStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "probes.json");
  }

  /** A missing or corrupt file reads as empty and never throws: the digest and the overseer must survive a bad probes.json, not go quiet because of one. */
  async read(): Promise<ProbeResult[]> {
    const text = await readFile(this.path(), "utf8").catch(() => "");
    if (text === "") return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as ProbeResult[]) : [];
    } catch (error) {
      console.error("[probe] probes.json is unreadable; treating as empty", error);
      return [];
    }
  }

  async write(results: ProbeResult[]): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFileAtomic(this.path(), `${JSON.stringify(results, null, 2)}\n`);
  }
}
