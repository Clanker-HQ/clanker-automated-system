import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";
import type { Router, Specialist } from "./router.js";

/**
 * Generous for a single-turn classification call with maxTurns: 1, but a
 * bound: without one, a stalled network call here (not an error — a genuine
 * hang) blocks the whole dispatcher, not just this one task. Dispatcher.wake()
 * claims and routes tasks one at a time in a tight loop (see claimAndStart in
 * dispatcher.ts) — only actually RUNNING a routed task happens concurrently —
 * so a routing call that never settles stalls every other queued task behind
 * it too, indefinitely, with no recovery short of a process restart.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Real routing decision: one small, cheap, single-turn call — no tools, no
 * workspace, no agentic loop, and deliberately NOT run through
 * Orchestrator/Governor/RunStore. This is a classification decision, not a
 * task execution.
 *
 * The answer is read from the last `assistant` text event `toRunEvents`
 * (already tested against the SDK's real message shapes in
 * tests/sdk-runner.test.ts) extracts from the stream, rather than an
 * unverified field on the terminal `result` message — reusing an
 * already-proven extraction path instead of assuming a new one.
 */
export class LlmRouter implements Router {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async route(taskText: string, specialists: Specialist[]): Promise<string | null> {
    if (specialists.length === 0) return null;

    const menu = specialists.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const prompt =
      `A task needs to be routed to exactly one specialist agent, or none if nothing fits.\n\n` +
      `Task: ${taskText}\n\nAvailable specialists:\n${menu}\n\n` +
      `Reply with ONLY the chosen specialist's name exactly as listed above, or the single word "none" if no specialist fits. No other text.`;

    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const stream = query({
      prompt,
      options: {
        model: "claude-haiku-4-5",
        effort: "low",
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        cwd: process.cwd(),
        allowedTools: [],
        disallowedTools: [],
        tools: [],
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: controller,
      },
    });

    let answer = "";
    try {
      for await (const message of stream) {
        for (const event of toRunEvents(message)) {
          if (event.type === "assistant" && event.text.trim()) answer = event.text.trim();
        }
      }
    } catch (err) {
      // The real SDK's transport REJECTS the async iterator when
      // controller.abort() is called mid-stream (sdk-runner.ts's stream loop
      // relies on the same behavior) — so a timeout surfaces here as a throw,
      // not a quiet end to iteration. Whatever `answer` was already captured
      // before the timeout fired is kept, same as sdk-runner.ts never
      // discarding an already-pulled message; a rejection for any OTHER
      // reason still propagates.
      if (!controller.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
    }

    const normalized = answer.toLowerCase();
    if (normalized === "none" || normalized === "") return null;
    return specialists.find((s) => s.name.toLowerCase() === normalized)?.name ?? null;
  }
}
