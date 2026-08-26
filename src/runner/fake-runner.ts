import type { AgentDef } from "../registry.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

export interface FakeScript {
  events: RunEvent[];
  /** Throw once this many events have been yielded. */
  throwAfter?: number;
  /** Yield nothing and wait until aborted — for exercising timeout handling. */
  hangForever?: boolean;
}

export class FakeRunner implements Runner {
  constructor(private readonly script: FakeScript) {}

  async *execute(
    _agent: AgentDef,
    _ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    if (this.script.hangForever) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    let yielded = 0;
    for (const event of this.script.events) {
      if (signal.aborted) return;
      if (this.script.throwAfter !== undefined && yielded >= this.script.throwAfter) {
        throw new Error("scripted failure");
      }
      yield event;
      yielded += 1;
    }
  }
}
