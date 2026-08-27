import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";
import type { Router, Specialist } from "./router.js";

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
  async route(taskText: string, specialists: Specialist[]): Promise<string | null> {
    if (specialists.length === 0) return null;

    const menu = specialists.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const prompt =
      `A task needs to be routed to exactly one specialist agent, or none if nothing fits.\n\n` +
      `Task: ${taskText}\n\nAvailable specialists:\n${menu}\n\n` +
      `Reply with ONLY the chosen specialist's name exactly as listed above, or the single word "none" if no specialist fits. No other text.`;

    const { childEnv } = resolveCredentials();
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
        abortController: new AbortController(),
      },
    });

    let answer = "";
    for await (const message of stream) {
      for (const event of toRunEvents(message)) {
        if (event.type === "assistant" && event.text.trim()) answer = event.text.trim();
      }
    }

    const normalized = answer.toLowerCase();
    if (normalized === "none" || normalized === "") return null;
    return specialists.find((s) => s.name.toLowerCase() === normalized)?.name ?? null;
  }
}
