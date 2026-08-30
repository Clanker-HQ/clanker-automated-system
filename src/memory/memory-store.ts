import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { MemoryInput, MemoryKind, MemoryRecord } from "./types.js";

/**
 * Append-only JSONL, the same shape (and for the same reason) as a run's
 * transcript.jsonl: written as events arrive, so it survives a crash.
 *
 * Nothing here ever rewrites an existing record in place. The memory
 * literature is specific that LLM-rewritten memory degrades over time
 * ("Useful Memories Become Faulty When Continuously Updated by LLMs"), so
 * consolidation produces derived output rather than mutating the raw log.
 * `prune` is the single exception — it only ever DELETES whole records, never
 * edits one, and only runs from the retention job.
 */
export class MemoryStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "memory");
  }

  private path(): string {
    return join(this.dir(), "log.jsonl");
  }

  async append(input: MemoryInput): Promise<MemoryRecord> {
    await mkdir(this.dir(), { recursive: true });
    const record: MemoryRecord = {
      ...input,
      id: `mem_${randomUUID().slice(0, 12)}`,
      ts: input.ts ?? new Date().toISOString(),
      chainDepth: input.chainDepth ?? 0,
    };
    await appendFile(this.path(), JSON.stringify(record) + "\n");
    return record;
  }

  async list(): Promise<MemoryRecord[]> {
    const raw = await readFile(this.path(), "utf8").catch(() => "");
    const records: MemoryRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as MemoryRecord);
      } catch (err) {
        // Never silent: a corrupt line vanishing from every novelty check
        // forever is exactly the quiet loss this project's posture forbids.
        console.error("[memory-store] skipping unparseable log line", err);
      }
    }
    return records;
  }

  /** Returns how many records were removed. Rewrites the whole file — retention only. */
  async prune(opts: { olderThan: Date; keepKinds: MemoryKind[] }): Promise<number> {
    const all = await this.list();
    const kept = all.filter((r) => opts.keepKinds.includes(r.kind) || new Date(r.ts) >= opts.olderThan);
    if (kept.length === all.length) return 0;
    await writeFileAtomic(this.path(), kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
    return all.length - kept.length;
  }
}
