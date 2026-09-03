import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ChildLike {
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface SupervisorOptions {
  spawnChild: () => ChildLike;
  /** Restarts allowed inside `windowMs` before giving up. */
  maxRestarts: number;
  windowMs: number;
  now?: () => number;
  onRestart?: (restartCount: number) => void;
  onGiveUp?: (restartCount: number) => void;
}

/**
 * Relaunches a crashed child indefinitely, the same job Docker's own
 * `restart: unless-stopped` does for the container this runs in once deployed
 * — this exists for the gap before then, when the process is just a bare
 * `npm start` with nothing watching it. Bounded by a sliding-window restart
 * cap so a persistent crash-on-boot bug degrades to "stays down", not an
 * infinite respawn loop burning CPU and API spend.
 */
export class Supervisor {
  private stopped = false;
  private restartTimes: number[] = [];
  private child: ChildLike | undefined;

  constructor(private readonly opts: SupervisorOptions) {}

  start(): void {
    this.stopped = false;
    this.spawnAndWatch();
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.stopped = true;
    this.child?.kill(signal);
  }

  private spawnAndWatch(): void {
    const child = this.opts.spawnChild();
    this.child = child;
    child.once("exit", () => {
      if (this.stopped) return;

      const now = (this.opts.now ?? Date.now)();
      this.restartTimes.push(now);
      this.restartTimes = this.restartTimes.filter((t) => now - t <= this.opts.windowMs);

      if (this.restartTimes.length > this.opts.maxRestarts) {
        this.opts.onGiveUp?.(this.restartTimes.length);
        return;
      }

      this.opts.onRestart?.(this.restartTimes.length);
      this.spawnAndWatch();
    });
  }
}

/**
 * Resolves tsx's own CLI entry point on disk instead of spawning `tsx` via a
 * shell. `shell: true` on Windows runs the command through cmd.exe, and
 * killing that shell does not reliably kill the tsx/node process it spawned
 * underneath — exactly the process-tree leak that would leave a previous
 * instance still holding the dashboard's port after a "restart". Spawning
 * the resolved CLI file directly with `node` means the child *is* the real
 * process, so `child.kill()` actually terminates it.
 */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("tsx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: string };
  return join(dirname(pkgPath), pkg.bin);
}

async function main(): Promise<void> {
  const tsxCli = resolveTsxCli();
  const supervisor = new Supervisor({
    spawnChild: () =>
      spawn(process.execPath, [tsxCli, "--env-file-if-exists=.env", "src/index.ts"], {
        stdio: "inherit",
      }),
    maxRestarts: 5,
    windowMs: 60_000,
    onRestart: (count) => console.error(`[supervise] child exited, restarting (restart ${count} in the last 60s)`),
    onGiveUp: (count) =>
      console.error(`[supervise] child exited ${count} times within 60s — giving up, not restarting again`),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      supervisor.stop(signal);
      process.exit(0);
    });
  }

  supervisor.start();
}

// Guarded so tests can import `Supervisor` without also spawning a real
// child process and installing real signal handlers as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
