import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import type { Config, GovernorConfig, QuietHours } from "./config.js";
import { KeyedMutex } from "./keyed-mutex.js";

/** All calls share this one key: there's exactly one config-overrides.json per data dir, unlike TaskStore's per-id file. */
const OVERRIDES_KEY = "config-overrides";

export interface ConfigOverrides {
  quietHours?: QuietHours | null;
  dailyBudgetUsd?: number;
  maxConcurrent?: number;
  disabledAgents?: string[];
  /** Unset/true = normal (breaker trips a "trigger" admit after 3 consecutive failures). False = a tripped breaker no longer refuses admission. */
  breakerEnabled?: boolean;
}

export class ConfigOverridesStore {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "config-overrides.json");
  }

  async read(): Promise<ConfigOverrides> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as ConfigOverrides;
    } catch {
      return {};
    }
  }

  /**
   * Serialized: two `!budget`/`!quiet`/`!breaker`/... commands landing at once
   * would otherwise read the same "before" state and one's write would
   * silently clobber the other's. The write itself is also atomic (temp file
   * + rename) — read() isn't routed through this mutex (Governor.status()/
   * admit() call it freely), so without that a concurrent read could still
   * observe a torn write and, on this store's catch-all read() error
   * handling, silently see "no overrides at all" instead of a clear failure.
   */
  async set<K extends keyof ConfigOverrides>(key: K, value: ConfigOverrides[K], setBy: string): Promise<void> {
    return this.mutex.run(OVERRIDES_KEY, async () => {
      await mkdir(join(this.dataDir, "state"), { recursive: true });
      const current = await this.read();
      const previous = current[key];
      const next = { ...current, [key]: value };
      await writeFileAtomic(this.path(), JSON.stringify(next, null, 2) + "\n");
      const line = `${new Date().toISOString()} ${setBy} set ${String(key)} = ${JSON.stringify(value)} (was ${JSON.stringify(previous)})\n`;
      await appendFile(join(this.dataDir, "state", "audit.log"), line);
    });
  }
}

/** override → config.yaml → built-in default. An override key that is `undefined` (never set) falls through; an explicit `null` on quietHours wins as "off". */
export function resolveGovernorSettings(config: Config, overrides: ConfigOverrides): GovernorConfig {
  return {
    maxConcurrent: overrides.maxConcurrent ?? config.governor.maxConcurrent,
    dailyBudgetUsd: overrides.dailyBudgetUsd ?? config.governor.dailyBudgetUsd,
    pendingTimeoutHours: config.governor.pendingTimeoutHours,
    quietHours: "quietHours" in overrides ? (overrides.quietHours ?? null) : config.governor.quietHours,
  };
}
