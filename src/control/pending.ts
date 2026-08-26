import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendingEntry {
  id: string;
  runId: string;
  agentName: string;
  sessionId: string;
  kind: "approval" | "question";
  effect?: string;
  grantRef?: string;
  question?: string;
  askedAt: string;
}

export class PendingStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "pending");
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  async create(entry: Omit<PendingEntry, "id" | "askedAt">): Promise<PendingEntry> {
    await mkdir(this.dir(), { recursive: true });
    const full: PendingEntry = { ...entry, id: randomUUID(), askedAt: new Date().toISOString() };
    await writeFile(this.path(full.id), JSON.stringify(full, null, 2) + "\n");
    return full;
  }

  async get(id: string): Promise<PendingEntry | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as PendingEntry;
    } catch {
      return null;
    }
  }

  async list(): Promise<PendingEntry[]> {
    const files = await readdir(this.dir()).catch(() => [] as string[]);
    const entries: PendingEntry[] = [];
    for (const file of files) {
      const entry = await this.get(file.replace(/\.json$/, ""));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async resolve(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  async reconcile(opts: { timeoutHours: number; now?: Date }): Promise<{ expired: PendingEntry[]; active: PendingEntry[] }> {
    const now = opts.now ?? new Date();
    const cutoffMs = opts.timeoutHours * 60 * 60 * 1000;
    const all = await this.list();
    const expired: PendingEntry[] = [];
    const active: PendingEntry[] = [];
    for (const entry of all) {
      const ageMs = now.getTime() - new Date(entry.askedAt).getTime();
      if (ageMs > cutoffMs) {
        expired.push(entry);
        await this.resolve(entry.id);
      } else {
        active.push(entry);
      }
    }
    return { expired, active };
  }
}
