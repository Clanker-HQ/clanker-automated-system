import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Supervisor } from "../scripts/supervise.js";

class FakeChild extends EventEmitter {
  killed = false;
  killedWith: NodeJS.Signals | undefined;
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed = true;
    this.killedWith = signal;
  }
  exit(code: number | null = 1): void {
    this.emit("exit", code, null);
  }
}

describe("Supervisor", () => {
  it("restarts the child when it exits", () => {
    const children: FakeChild[] = [];
    const spawnChild = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const onRestart = vi.fn();
    const supervisor = new Supervisor({ spawnChild, maxRestarts: 5, windowMs: 60_000, onRestart });

    supervisor.start();
    expect(spawnChild).toHaveBeenCalledTimes(1);

    children[0]!.exit(1);

    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("gives up once more than maxRestarts exits happen inside windowMs", () => {
    const children: FakeChild[] = [];
    let clock = 0;
    const spawnChild = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const onGiveUp = vi.fn();
    const supervisor = new Supervisor({
      spawnChild,
      maxRestarts: 2,
      windowMs: 60_000,
      now: () => clock,
      onGiveUp,
    });

    supervisor.start();
    // Three rapid exits: 1st and 2nd restart (within the cap), 3rd gives up.
    clock += 1000;
    children[0]!.exit(1);
    clock += 1000;
    children[1]!.exit(1);
    clock += 1000;
    children[2]!.exit(1);

    expect(spawnChild).toHaveBeenCalledTimes(3); // no 4th spawn after giving up
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("does not count restarts outside the sliding window toward the cap", () => {
    const children: FakeChild[] = [];
    let clock = 0;
    const spawnChild = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const onGiveUp = vi.fn();
    const supervisor = new Supervisor({
      spawnChild,
      maxRestarts: 2,
      windowMs: 60_000,
      now: () => clock,
      onGiveUp,
    });

    supervisor.start();
    clock += 1000;
    children[0]!.exit(1);
    clock += 1000;
    children[1]!.exit(1);
    // Well outside the 60s window — earlier restarts should have aged out.
    clock += 120_000;
    children[2]!.exit(1);
    clock += 1000;
    children[3]!.exit(1);

    expect(onGiveUp).not.toHaveBeenCalled();
    expect(spawnChild).toHaveBeenCalledTimes(5);
  });

  it("stop() kills the current child and does not restart after it exits", () => {
    const children: FakeChild[] = [];
    const spawnChild = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const supervisor = new Supervisor({ spawnChild, maxRestarts: 5, windowMs: 60_000 });

    supervisor.start();
    supervisor.stop("SIGTERM");

    expect(children[0]!.killed).toBe(true);
    expect(children[0]!.killedWith).toBe("SIGTERM");

    children[0]!.exit(0);
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });
});
