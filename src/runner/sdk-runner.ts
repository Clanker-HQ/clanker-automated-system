import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryConfig } from "../config.js";
import type { ConfigOverridesStore } from "../config-overrides.js";
import { touchesExcludedPath } from "../control/excluded-paths.js";
import type { FindingReviewer } from "../control/finding-reviewer.js";
import type { GitCloner } from "../control/git-cloner.js";
import type { GitPusher } from "../control/git-pusher.js";
import type { GithubTransport } from "../control/github-transport.js";
import { PendingStore } from "../control/pending.js";
import { evaluateSelfBuildPr, isSelfBuildChange } from "../control/self-build-gate.js";
import type { TaskReviewer } from "../control/task-reviewer.js";
import { MAX_TASK_TEXT_LENGTH, TaskStore } from "../control/task-store.js";
import { decide, detectOutwardEffect, matchGrant, type Grant } from "../grants.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { assessNovelty } from "../memory/novelty-gate.js";
import { retrieveContext } from "../memory/retrieval.js";
import { priorityScore, toPriority } from "../memory/scoring.js";
import type { DiscordOutbox } from "../outbox/discord.js";
import type { AgentDef } from "../registry.js";
import type { BreakerStore } from "../state/breaker.js";
import type { StrategyStore } from "../world/strategy.js";
import type { WorldModel } from "../world/world-model.js";
import { resolveCredentials } from "./credentials.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

/**
 * A named subagent type registered on every query() call, for one reason:
 * pr-reviewer is the only agent holding `Task`, and its prompt spawns up to
 * four parallel sub-reviews (correctness, security, quality, claim-check).
 * `agent.run.maxTurns` (below) is passed as the query()-level `maxTurns`
 * option only — the SDK's own AgentDefinition type shows a subagent can
 * carry its own separate `maxTurns`, and a Task call whose subagent_type
 * matches nothing registered here falls back to the SDK's built-in
 * "general-purpose" type, which this codebase does not bound at all. A
 * review's real turn/token cost was therefore the top-level cap PLUS up to
 * four uncapped sub-conversations. This registers a type pr-reviewer's
 * prompt is told to name explicitly, capping each sub-review well below the
 * top-level ceiling so the worst case (all four running) is a real number,
 * not unbounded.
 *
 * `tools` is set for a second, independent reason: AgentDefinition.tools
 * "inherits all tools from parent" when omitted, which would hand every
 * sub-review the parent's mergePR/postReviewComment/Task tools too — a
 * sub-review could merge the PR itself, or spawn further sub-reviews,
 * bypassing the very "wait for every angle, then decide" flow the top-level
 * prompt describes. Restricted to read/inspect tools only, matching what a
 * focused review angle actually needs.
 *
 * Registered unconditionally rather than only for pr-reviewer: it is inert
 * for any agent whose prompt never calls Task with this subagent_type, and
 * conditioning it on the calling agent would be one more thing to keep in
 * sync with allowedTools for no real benefit.
 */
const PR_REVIEW_SUBAGENT_TYPE = "pr-review-angle";
const PR_REVIEW_SUBAGENT: {
  description: string;
  prompt: string;
  tools: string[];
  maxTurns: number;
} = {
  description:
    "One bounded angle of review on a pull request already checked out in the workspace (correctness, security, code quality, or whether the diff does what it claims) — used by pr-reviewer to parallelize its own review.",
  prompt:
    "You are one focused sub-review of a larger pull-request review already underway. The task you were given names the specific angle to check. Investigate only that angle using the code already checked out in this workspace, and report concrete findings — or their deliberate absence — clearly back to the review that spawned you. You do not decide whether to merge and you have no way to: you never call mergePR or postReviewComment, and you cannot spawn further sub-reviews.",
  tools: ["Read", "Grep", "Glob", "Bash"],
  // Four of these can run in parallel; capped well below the top-level
  // review's own maxTurns so the worst case stays bounded rather than open.
  maxTurns: 20,
};

/**
 * Keeps the pages `research` reads out of `research`'s own context.
 *
 * A run's cost is round trips multiplied by the context each one carries, and
 * that context grows with every page read — so reading five sources inline
 * means the fifth turn re-sends the first four pages, and so does every turn
 * after it. A Task-spawned subagent runs in its OWN context window and returns
 * only its final report, so the parent pays for the report and never for the
 * reading. That is the same "summarise before continuing" the SDK's built-in
 * compaction would do, except compaction only fires near the model's context
 * limit — around 200k tokens — which a research run never approaches.
 *
 * `model` is the cheap one deliberately: reading a page and quoting it back is
 * bulk work, while weighing sources against each other is where a research run
 * actually goes wrong (see agents/research/prompt.md's "Proving a negative").
 * The parent keeps the better model for that judgement.
 *
 * Bounded and tool-restricted for the reasons the PR sub-review above already
 * documents: an unregistered Task type falls back to the SDK's uncapped
 * "general-purpose" agent, and an AgentDefinition with `tools` omitted
 * inherits the parent's entire toolset. `disallowedTools` strips every MCP
 * tool — a reader must not record findings or queue tasks, and carrying
 * schemas it can never call is exactly the per-turn weight this exists to
 * avoid.
 */
const RESEARCH_SOURCE_SUBAGENT_TYPE = "research-source";
const RESEARCH_SOURCE_SUBAGENT: {
  description: string;
  prompt: string;
  tools: string[];
  disallowedTools: string[];
  model: string;
  maxTurns: number;
} = {
  description:
    "Reads a named set of web sources for one specific question and reports what they say, with direct quotes and URLs — used by research to keep page-reading out of its own context.",
  prompt:
    "You are reading sources for one specific question on behalf of a research run already underway. Read what the task names, plus anything it points you to, and report what each source actually says — a direct quote and the URL it came from, for every claim you pass back. Say plainly when a source does not answer the question, and say so too when a page was too large to read in full, naming what you did see: the run that spawned you cannot tell the difference between 'not there' and 'not visible to you' unless you tell it. Do not conclude and do not recommend. The run that spawned you weighs the evidence and decides; it needs your evidence, not your verdict.",
  tools: ["WebSearch", "WebFetch"],
  // Server-level spec: removes every tool from every MCP server at once, so
  // this stays correct as servers are added.
  disallowedTools: ["mcp__*"],
  model: "haiku",
  // Well under the parent's own budget: a reader that needs more than this is
  // reading too much for one question, and four of these can run at once.
  maxTurns: 8,
};

/**
 * The only subagent types a `Task` call may name. Enforced in `canUseTool`,
 * because an unregistered type silently becomes the SDK's uncapped
 * general-purpose agent with the parent's own tools.
 */
const REGISTERED_SUBAGENT_TYPES: ReadonlySet<string> = new Set([PR_REVIEW_SUBAGENT_TYPE, RESEARCH_SOURCE_SUBAGENT_TYPE]);

/**
 * Agents whose own prompt.md actually calls a githubPr tool (mergePR,
 * postReviewComment, createRepo, pushBranch, or openPR) — grep
 * `agents/*\/prompt.md` for those names to keep this in sync as prompts
 * change.
 *
 * Every other agent this system runs (research, the scouts, overseer) never
 * references any of these tools, so mounting the server for them bought
 * nothing: `githubPrServer` used to be built whenever `this.deps.github` was
 * present at all, a constructor-level dependency shared by every agent this
 * one SdkRunner instance runs, not a per-agent decision — so an agent that
 * will never call mergePR still paid its and its three siblings' tool
 * schemas (mergePR's description alone runs several hundred characters,
 * before its zod-derived JSON schema) on every single turn it made, for a
 * tool it structurally could never have used (no grant, no mention in its
 * own prompt).
 *
 * This is a narrower mechanism than an earlier, reverted attempt at gating
 * this same server: gating it on GRANT possession would also have hidden
 * `postReviewComment` and `openPR` — both explicitly "Never gated" by
 * design in their own tool descriptions — from any agent that needs to
 * comment or open a PR without holding a merge grant. Keying the gate on
 * the agent's NAME instead leaves both ungated tools available to every
 * agent whose prompt was ever going to call them, and simply never offers
 * the server to one that wasn't.
 */
const GITHUB_PR_AGENTS: ReadonlySet<string> = new Set(["builder", "pr-reviewer", "repair"]);

/**
 * Agents whose own prompt.md references at least one taskQueue tool -- grep
 * every agents/*\/prompt.md for queueTask/listMyTasks/recentFailures/
 * recallMemory to keep this in sync. builder, pr-reviewer, repair, and
 * e2e-approval-test reference none of them: they build/review/repair tasks
 * already assigned to them rather than discovering or tracking their own,
 * so mounting this server for them paid four tool schemas' worth of
 * per-turn weight for a capability they structurally never call into.
 * Gated the same way githubPr is -- by agent name, not by narrowing what
 * the server offers the agents that actually use it (see the per-tool
 * exclusions for research below, which this allowlist does not replace).
 */
const TASK_QUEUE_AGENTS: ReadonlySet<string> = new Set([
  "research",
  "improvement-scout",
  "opportunity-scout",
  "dependency-scout",
  "overseer",
  "cleanup-scout",
]);

/**
 * Consecutive failing tool calls — with nothing succeeding in between — after
 * which a run is stopped rather than left to retry until it exhausts its
 * turns. Five, because four is still plausibly a stubborn-but-recoverable
 * sequence while five with zero successes is a broken dependency.
 */
const MAX_CONSECUTIVE_TOOL_FAILURES = 5;

/**
 * Overrides the SDK's default auto-compaction ceiling (the model's context
 * limit, ~200k tokens for Sonnet -- see settings.autoCompactWindow in
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) for research only.
 *
 * research's own accumulated conversation -- not the fixed per-turn baseline
 * the other constants in this file bound -- is the dominant term in what a
 * run costs: every turn resends everything before it, so content added at
 * turn 3 is paid for again on every one of the ~20 turns after it. A 200k
 * ceiling never engages for a run whose peak context lands around 75-85k
 * tokens (back-computed from a verified $1.02/515k-token run), so today
 * research pays that full quadratic cost with no relief.
 *
 * 60,000 is a first, deliberately moderate cut: high enough to preserve most
 * of the "search and dispatch readers" phase (see prompt.md) before the
 * "synthesize and write" phase begins, low enough to plausibly fire at least
 * once on a normal run and trim the tail that phase boundary creates. This
 * is the one change in this file that can lose fidelity in older
 * conversation content (compaction summarizes; it does not just drop
 * redundant filler), which is exactly the axis agents/research/prompt.md's
 * "Proving a negative" section is written to protect -- so it is scoped to
 * research alone, not applied system-wide, and its actual effect (does the
 * SDK's own compact_boundary event even fire, and does the run's summary
 * still hold up) needs to be read off the next real run via the "compacted"
 * RunEvent this same change adds observability for (see toRunEvents' "system"
 * case), not assumed from this reasoning alone.
 */
const RESEARCH_AUTO_COMPACT_WINDOW = 60_000;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A non-empty string, else "unknown". */
function str(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
  );
}

/**
 * A tool_result content block normally carries only tool_use_id, not a tool
 * name — fall back to that, and only then to "unknown".
 */
function toolResultName(block: Record<string, unknown>): string {
  if (typeof block.name === "string" && block.name) return block.name;
  if (typeof block.tool_use_id === "string" && block.tool_use_id) return block.tool_use_id;
  return "unknown";
}

/**
 * Rough $/million-token rates for the fixed model set this system runs.
 * Used ONLY to estimate cost on a run aborted before the SDK's own
 * total_cost_usd figure (which arrives solely on the terminal `result`
 * message) was ever computed — subscription runs aren't billed by this
 * number, but a $0.0000 report for a run that burned its whole timeout is
 * worse than an estimate.
 */
const COST_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = COST_PER_MILLION_TOKENS[model];
  if (!rate) return 0;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export interface PartialUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Accumulates the per-turn `usage` block every SDKAssistantMessage carries
 * (message.usage, standard Anthropic Messages API shape) — present on EVERY
 * assistant message, not only the terminal one. This is what lets a run
 * aborted mid-stream still report a truthful token count instead of losing
 * all accounting.
 */
export function accumulateUsage(existing: PartialUsage, message: unknown): PartialUsage {
  if (typeof message !== "object" || message === null) return existing;
  const m = message as Record<string, unknown>;
  if (m.type !== "assistant") return existing;
  const inner = m.message as Record<string, unknown> | undefined;
  const usage = inner?.usage as Record<string, unknown> | undefined;
  if (!usage) return existing;
  return {
    inputTokens: existing.inputTokens + num(usage.input_tokens),
    outputTokens: existing.outputTokens + num(usage.output_tokens),
    cacheReadTokens: existing.cacheReadTokens + num(usage.cache_read_input_tokens),
    cacheCreationTokens: existing.cacheCreationTokens + num(usage.cache_creation_input_tokens),
  };
}

/**
 * Maps one SDK message to zero or more RunEvents.
 *
 * `SDKMessage` has no standalone tool_use/tool_result/usage message types:
 * tool calls arrive as content blocks inside an `assistant` message
 * (`message.message.content`), tool results arrive as content blocks inside
 * a `user` message, and token/cost usage arrives on the terminal `result`
 * message alongside a `subtype` that says why the run stopped. One assistant
 * message can carry text and several tool_use blocks at once, so a single
 * SDK message can map to several RunEvents — hence the array return.
 *
 * Never throws: anything unrecognised or malformed returns [], so an SDK
 * version change degrades reporting rather than breaking a run.
 */
export function toRunEvents(message: unknown): RunEvent[] {
  if (typeof message !== "object" || message === null) return [];
  const m = message as Record<string, unknown>;

  switch (m.type) {
    case "assistant": {
      const events: RunEvent[] = [];
      const inner = m.message as Record<string, unknown> | undefined;
      const content = inner?.content;

      if (typeof content === "string") {
        if (content.trim()) events.push({ type: "assistant", text: content });
      } else {
        for (const block of blocksOf(content)) {
          if (block.type === "text" && typeof block.text === "string") {
            if (block.text.trim()) events.push({ type: "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            events.push({ type: "tool_use", name: str(block.name) });
          }
          // "thinking" and any other block type is intentionally ignored.
        }
      }

      // SDKAssistantMessage.error carries conditions like
      // authentication_failed, rate_limit, billing_error, etc. — surface
      // them so a run doesn't silently look clean.
      if (typeof m.error === "string" && m.error) {
        events.push({ type: "error", message: `assistant message reported error: ${m.error}` });
      }
      return events;
    }

    case "user": {
      const events: RunEvent[] = [];
      const inner = m.message as Record<string, unknown> | undefined;
      for (const block of blocksOf(inner?.content)) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool_result",
            name: toolResultName(block),
            ok: block.is_error !== true,
          });
        }
      }
      return events;
    }

    case "result": {
      const usage = (m.usage as Record<string, unknown> | undefined) ?? {};
      // The SDK's own type declarations (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts,
      // SDKResultSuccess) document `usage` as "MAIN AGENT LOOP ONLY ...
      // per-turn in streaming-input sessions" and say to "prefer modelUsage
      // for token/cost accounting" — modelUsage is "cumulative across
      // turns", sharing total_cost_usd's lifecycle. Reading `usage` alone
      // reports only the final turn's tokens next to a cost that correctly
      // bills every turn: a 20-turn run recorded $0.56 next to 92 input
      // tokens, a run that actually moved roughly half a million cumulative
      // tokens. Sum every model's contribution — normally one, but a
      // mid-run fallback adds a second key — rather than assuming exactly
      // one. Falls back to `usage` when modelUsage is absent or every entry
      // is zeroed, which the SDK's own docs say a crashed/startup-error
      // result may do, and which an older SDK build predating the field
      // also looks like.
      // ModelUsage carries FOUR token counts, not two: inputTokens is only the
      // UNCACHED input. Summing the first two alone reported 515,212 input for
      // a run whose cache reads and cache writes went unrecorded entirely — so
      // the one number anybody tuned against was a fraction of the traffic,
      // and every estimate made from it was wrong. The rolling rate-limit
      // window is what actually constrains this system, so what it costs to
      // re-read a cached prefix is exactly the thing worth seeing.
      const modelUsage = (m.modelUsage as Record<string, Record<string, unknown>> | undefined) ?? {};
      let modelInputTokens = 0;
      let modelOutputTokens = 0;
      let modelCacheReadTokens = 0;
      let modelCacheCreationTokens = 0;
      for (const entry of Object.values(modelUsage)) {
        modelInputTokens += num(entry.inputTokens);
        modelOutputTokens += num(entry.outputTokens);
        modelCacheReadTokens += num(entry.cacheReadInputTokens);
        modelCacheCreationTokens += num(entry.cacheCreationInputTokens);
      }
      const hasModelUsage = modelInputTokens > 0 || modelOutputTokens > 0;

      const events: RunEvent[] = [
        {
          type: "usage",
          inputTokens: hasModelUsage ? modelInputTokens : num(usage.input_tokens),
          outputTokens: hasModelUsage ? modelOutputTokens : num(usage.output_tokens),
          // Falls back to the terminal `usage` block's own cache fields when
          // modelUsage is absent, the same way the two counts above do.
          cacheReadTokens: hasModelUsage ? modelCacheReadTokens : num(usage.cache_read_input_tokens),
          cacheCreationTokens: hasModelUsage ? modelCacheCreationTokens : num(usage.cache_creation_input_tokens),
          costUsd: num(m.total_cost_usd),
          durationMs: num(m.duration_ms),
        },
      ];

      // subtype is the only record of *why* the SDK stopped ("success" vs.
      // error_during_execution / error_max_turns / error_max_budget_usd /
      // error_max_structured_output_retries); is_error can also be true on
      // an otherwise "success" subtype when the turn ended on an API error.
      // Preserve the subtype verbatim — mapping it to a distinct RunStatus
      // is out of scope here and belongs with the governor in a later plan.
      const subtype = typeof m.subtype === "string" ? m.subtype : "unknown";
      if (subtype !== "success" || m.is_error === true) {
        events.push({
          type: "error",
          message: `SDK run ended with subtype "${subtype}" (is_error=${m.is_error === true})`,
        });
      }
      return events;
    }

    case "rate_limit_event": {
      const info = (m.rate_limit_info as Record<string, unknown> | undefined) ?? {};
      const status = info.status;
      if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return [];
      const event: RunEvent = { type: "rate_limit_event", status };
      if (typeof info.rateLimitType === "string") (event as Record<string, unknown>).rateLimitType = info.rateLimitType;
      if (typeof info.utilization === "number") (event as Record<string, unknown>).utilization = info.utilization;
      if (typeof info.resetsAt === "number") (event as Record<string, unknown>).resetsAt = info.resetsAt;
      return [event];
    }

    case "system": {
      if (m.subtype !== "compact_boundary") return [];
      const meta = (m.compact_metadata as Record<string, unknown> | undefined) ?? {};
      const trigger = meta.trigger === "manual" ? "manual" : "auto";
      const postTokens = typeof meta.post_tokens === "number" ? meta.post_tokens : undefined;
      return [{ type: "compacted", trigger, preTokens: num(meta.pre_tokens), postTokens }];
    }

    default:
      return [];
  }
}

/**
 * Propagates an abort from `signal` to `controller`. A listener attached to
 * an AbortSignal that is already aborted never fires (per the AbortSignal
 * spec), so the already-aborted case must be checked explicitly rather than
 * relying solely on the "abort" event — the same pattern FakeRunner already
 * uses at src/runner/fake-runner.ts:23-25. Without this, a timeout that
 * fires before SdkRunner.execute's async generator body starts running
 * would never reach the SDK's own abortController, and the run would
 * continue to completion past its deadline.
 */
export function linkAbort(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

export class SdkRunner implements Runner {
  constructor(
    private readonly deps: {
      grants: Grant[];
      pending: PendingStore;
      github?: GithubTransport;
      gitPusher?: GitPusher;
      gitCloner?: GitCloner;
      /** Wired in production (src/index.ts); optional so tests/scripts that don't care about task-queueing can skip it, the same shape `github` already uses. */
      tasks?: TaskStore;
      /** Wakes the dispatcher after queueTask adds work, so it's picked up on this tick rather than waiting for the next periodic one. */
      wake?: () => Promise<void>;
      /** Optional: without it, queueTask queues exactly what's given, no automated rationale check — same fallback posture as findingReviewer below. */
      taskReviewer?: TaskReviewer;
      /** docs/system-context.md's contents, read once at boot (src/index.ts). Optional so tests/scripts that don't care can skip it — the systemContext tool is simply not registered without it. */
      systemContext?: string;
      /** Optional, same shape as `tasks`: without it queueTask keeps its old flat-priority behaviour and writes no memory records. */
      memory?: MemoryStore;
      memoryConfig?: MemoryConfig;
      /** Optional, same shape as `tasks`/`memory`: without it recordFinding/updatePortfolioEntry are simply not registered. */
      world?: WorldModel;
      /** Optional: without it, recordFinding writes the finding exactly as given, no automated confidence check. */
      findingReviewer?: FindingReviewer;
      /** Optional: without it, writeStrategy is simply not registered (see Task C3). */
      strategyStore?: StrategyStore;
      /**
       * The three deps setAgentEnabled needs together — the same override
       * `!disable`/`!enable` write, the breaker `!enable` resets, and the
       * loaded agent list to validate a name against and to list on refusal.
       * All three are required for the tool to appear at all (see Task C3);
       * `outbox` is separately optional, since posting the change is
       * best-effort, exactly like Task A1's auto-disable alert.
       */
      overrides?: ConfigOverridesStore;
      breaker?: BreakerStore;
      agents?: AgentDef[];
      outbox?: DiscordOutbox;
    } = {
      grants: [],
      pending: new PendingStore(process.cwd()),
    },
  ) {}

  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    linkAbort(signal, controller);

    let sessionId = "";
    // canUseTool/AskHuman run on the SDK's own concurrent task, not driven by
    // the `for await` loop below — a decision can land before the loop has
    // pulled the first message carrying `session_id`. A deferred promise lets
    // either side await the session id instead of racing a plain variable
    // (which could otherwise be persisted into a pending entry as "").
    let resolveSessionId!: (id: string) => void;
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    // Set by canUseTool or the AskHuman tool handler when a decision parks
    // or denies the run — those code paths abort `controller` directly
    // (not `signal`, which they don't own) to stop the SDK from continuing,
    // and stash the RunEvent to yield here once the stream loop notices.
    let terminalEvent: RunEvent | undefined;

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string; interrupt?: boolean }> => {
      // `Task` carries no outward effect, so decide() below allows it — but
      // the SDK falls back to its built-in "general-purpose" agent for any
      // subagent_type it does not recognise, and that agent is uncapped and
      // INHERITS THE PARENT'S TOOLS. Every bound the subagent definitions
      // above place on a spawned agent — turns, tool list, model, no MCP
      // access — is therefore only as strong as the type name being one this
      // system actually registered. For `research`, whose missing `Read` is
      // the only thing standing between a wildcard web grant and an
      // exfiltration path, an unregistered type would hand back exactly the
      // tool it was denied.
      //
      // Denied softly rather than aborting the run: naming the wrong type is
      // a correctable mistake, and the message names the right ones.
      if (toolName === "Task") {
        // The SDK runs subagents in the BACKGROUND by default and notifies the
        // parent when they finish. There is no "later" in this system: nothing
        // is waiting to hand the agent other work, so a parent that dispatches
        // and stops has simply ended its turn. The query then terminates and
        // every call after it — the background subagent's included — fails on
        // a closed stream. Seen on 2026-09-02: a reader returned ok in 10ms
        // (launch acknowledged, not finished), a terminal result landed three
        // seconds later, then five straight WebFetch failures at 8ms each,
        // which reads as a network outage and is nothing of the kind.
        if (input.run_in_background !== false) {
          return {
            behavior: "deny",
            message:
              "Pass run_in_background: false. Subagents default to running in the background, and this agent has " +
              "nothing else to do while one runs — dispatching without waiting ends the turn and closes the stream " +
              "the subagent itself is using. Several Task calls in ONE message still run in parallel.",
          };
        }

        const requested = typeof input.subagent_type === "string" ? input.subagent_type : "";
        if (!REGISTERED_SUBAGENT_TYPES.has(requested)) {
          return {
            behavior: "deny",
            message:
              `subagent_type "${requested || "(none given)"}" is not available here. Use one of: ` +
              `${[...REGISTERED_SUBAGENT_TYPES].join(", ")}. The built-in general-purpose agent is ` +
              `uncapped and inherits this agent's own tools, so it is never available.`,
          };
        }
      }

      const decision = decide(agent, this.deps.grants, toolName, input);
      if (decision.kind === "allow") return { behavior: "allow" };

      if (decision.kind === "deny") {
        terminalEvent = { type: "denied", reason: decision.reason };
        controller.abort();
        return { behavior: "deny", message: decision.reason, interrupt: true };
      }

      // A human already approved this exact grant earlier in this same run
      // (possibly in a previous park/resume cycle) — bypass the park path
      // entirely. Without this, a resumed agent that retries the outward
      // effect it was just approved for re-parks from scratch every time,
      // looping approve -> resume -> retry -> park forever. This is a pure
      // runtime override living here (where `ctx` is in scope), not in
      // `decide()`, which stays a static, per-call decision function with no
      // knowledge of approval history.
      if (ctx.approvedGrantRefs?.includes(decision.grantRef)) {
        // The only trace of this decision: no pending entry is written (there
        // is nothing to park for) and no RunEvent carries it either, so this
        // log line is what lets someone reading operational logs alongside
        // data/runs/<runId>/transcript.jsonl tell "auto-allowed under a prior
        // approval" apart from "no outward effect was ever detected" for the
        // matching tool_use entry.
        console.log(
          `[grants] ${toolName} auto-allowed under previously-approved grant "${decision.grantRef}" (run ${ctx.runId})`,
        );
        return { behavior: "allow" };
      }

      // Abort first — synchronously, before the disk write — so the
      // underlying agent process is told to stop as soon as possible rather
      // than after `pending.create()`'s await widens the window in which the
      // model could still act (and the stream could end naturally before
      // `terminalEvent` is even set).
      controller.abort();
      const entry = await this.deps.pending.create({
        runId: ctx.runId,
        agentName: agent.name,
        sessionId: await sessionIdPromise,
        kind: "approval",
        effect: decision.effect,
        grantRef: decision.grantRef,
      });
      terminalEvent = { type: "parked", kind: "approval", pendingId: entry.id };
      return { behavior: "deny", message: `parked for approval: ${decision.effect}`, interrupt: true };
    };

    const askHumanServer = createSdkMcpServer({
      name: "askHuman",
      tools: [
        tool(
          "AskHuman",
          "Ask the owner a free-text question and stop this run until they answer. Use this when you're blocked on information only the owner can provide.",
          { question: z.string().min(1) },
          async ({ question }) => {
            controller.abort();
            const entry = await this.deps.pending.create({
              runId: ctx.runId,
              agentName: agent.name,
              sessionId: await sessionIdPromise,
              kind: "question",
              question,
            });
            terminalEvent = { type: "parked", kind: "question", pendingId: entry.id };
            return { content: [{ type: "text", text: "Waiting for the owner's answer." }] };
          },
        ),
      ],
    });

    // Only registered when systemContext was actually loaded (src/index.ts
    // reads docs/system-context.md at boot) AND the running agent is
    // "research" — every other agent either holds Read (and so has no need
    // for this) or, if it doesn't, never calls this tool from its own
    // prompt (grep every agents/*/prompt.md to confirm), so mounting it for
    // them paid a full tool schema for nothing they could call.
    // Exists specifically for agents like `research` that hold no `Read`
    // tool at all (a deliberate restriction: research also holds a broad
    // web-read grant, and Read + broad outbound access would be a plain
    // exfiltration path) — this hands back a fixed, curated string with no
    // path argument, so it can't be turned into an arbitrary file read.
    const systemContext = this.deps.systemContext;
    const systemContextServer = systemContext && agent.name === "research"
      ? createSdkMcpServer({
          name: "systemContext",
          tools: [
            tool(
              "systemContext",
              "Returns a short primer on how claude-agent-infrastructure (the project you're one of the agents in) works, plus possible future additions to keep in mind. Call this before researching, comparing, or recommending anything related to this project's own architecture, hosting, or configuration, so your answer accounts for what might be coming, not just what exists today.",
              {},
              async () => ({ content: [{ type: "text" as const, text: systemContext }] }),
            ),
          ],
        })
      : undefined;

    // The githubPr MCP server, only registered when a GithubTransport
    // dependency was provided AND the running agent is one that actually
    // calls one of its tools (see GITHUB_PR_AGENTS above) — agents that
    // don't touch GitHub never see it, and never pay its schemas' per-turn
    // weight for tools they hold no grant for and never call. It now hosts
    // five tools, not just mergePR:
    //   - mergePR — the one gated by all three checks described below.
    //   - postReviewComment — ungated; commenting has no outward consequence
    //     beyond ordinary communication.
    //   - createRepo — the first step before pushBranch/openPR can be used
    //     for a product with no repo yet. No unconditional gate the way
    //     pushBranch's branch-namespace check is: a provision grant's
    //     `scope` (the org) is the only real boundary here, since there is
    //     no equivalent excluded/protected set for repo names, and the
    //     backing token's own reach is already structurally confined to one
    //     org (see grants.yaml's products-provision comment). Gated the same
    //     two-step way as pushBranch otherwise: decide()/detectOutwardEffect/
    //     matchGrant, then the matched grant is looked up directly for its
    //     secret.
    //   - cloneRepo — registered only when `gitCloner` is also present (only
    //     `builder` holds both dependencies today). Gated the same
    //     decide()/detectOutwardEffect/matchGrant way as pushBranch, reusing
    //     "git-push" as its effect kind (see grants.ts's cloneRepo case) so
    //     the same grant that authorises pushing to a repo also authorises
    //     reading from it — no separate grant needed. Exists specifically so
    //     a private repo can be cloned with the credential embedded in the
    //     URL up front (RealGitCloner, src/control/git-cloner.ts), the same
    //     way pushBranch already pushes — a bare, credential-less `git
    //     clone` against a private repo doesn't fail cleanly, it falls back
    //     to whatever credential helper is on the machine, interactively.
    //   - pushBranch — registered only when `gitPusher` is also present (only
    //     `builder` holds both dependencies today). Its own two gates run in
    //     the same unconditional, order-matters style as mergePR's: (1) an
    //     `agent/builder/` namespace regex no grant or tier can override, then
    //     (2) a grant check via decide()/detectOutwardEffect/matchGrant. The
    //     regex only validates the `branch` argument that reaches this
    //     handler — RealGitPusher (`src/control/git-pusher.ts`) is the code
    //     that turns that validated argument into the actual pushed git ref,
    //     which is why that file is excluded-path-protected the same as this
    //     one.
    //   - openPR — ungated; by the time it runs, pushBranch has already
    //     confirmed the branch is in the agent/builder/ namespace, so its own
    //     namespace check here is defense in depth, not a security boundary on
    //     its own.
    //
    // mergePR's three gates run in this order, each unconditionally, and none
    // can be bypassed by an earlier gate's outcome:
    //   1. excluded-path check — a PR touching a security-sensitive path can
    //      never merge through this pipeline, no matter what grant or review
    //      exists. Checked against `getPullRequest`'s own authoritative
    //      `changedFiles`, NOT anything the calling model supplies — a
    //      `changedFiles` tool argument would be exactly the kind of value
    //      "trusted from an earlier step" that Lock 4 exists to rule out
    //      (prompt injection in the PR diff/body, a truncated file list, or
    //      plain model error could all under-report what a PR touches), so
    //      the tool doesn't accept one at all. EXCEPTION: a PR whose changed
    //      files are exactly the self-build shape (grants.yaml, or
    //      agents/*/{agent.yaml,prompt.md} in isolation — see
    //      isSelfBuildChange in ../control/self-build-gate.js) gets the
    //      mechanical four-rule self-build gate (evaluateSelfBuildPr) instead
    //      of this unconditional refusal; everything else is unaffected.
    //   2. grant check — does this agent hold a github-pr grant covering this
    //      repo, via decide()/detectOutwardEffect/matchGrant.
    //   3. stale-SHA check — the freshly-fetched head is compared against
    //      what the agent believed it reviewed, then GithubTransport.
    //      mergePullRequest re-verifies the same thing itself immediately
    //      before merging (defense in depth against a commit landing in the
    //      gap between the fetch above and the merge call).
    const github = this.deps.github;
    const gitPusher = this.deps.gitPusher;
    const gitCloner = this.deps.gitCloner;
    const githubPrServer = github && GITHUB_PR_AGENTS.has(agent.name)
      ? createSdkMcpServer({
          name: "githubPr",
          tools: [
            tool(
              "mergePR",
              "Merge a pull request that has passed review. Only succeeds if the repo is granted, the PR's head hasn't moved since you reviewed it, and the diff either doesn't touch a security-sensitive path or is a self-build change (grants.yaml or agents/*/{agent.yaml,prompt.md} alone), which is checked against four mechanical rules instead.",
              {
                repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'),
                number: z.number().int().positive(),
                expectedHeadSha: z.string().min(1),
              },
              async ({ repo, number, expectedHeadSha }) => {
                const info = await github.getPullRequest(repo, number);

                // Gate 1 — self-build changes (grants.yaml, or agents/*/{agent.yaml,
                // prompt.md} in isolation — see isSelfBuildChange) get the mechanical
                // four-rule self-build gate instead of an unconditional refusal;
                // everything else still gets the unconditional excluded-path refusal,
                // exactly as before this gate existed. This runs first: no grant, no
                // review verdict, nothing later in this handler can override either branch.
                if (isSelfBuildChange(info.changedFiles)) {
                  const verdict = await evaluateSelfBuildPr(github, repo, info, process.env);
                  if (!verdict.allowed) {
                    return {
                      content: [
                        { type: "text" as const, text: `Refused: self-build rule ${verdict.rule} failed — ${verdict.reason}` },
                      ],
                    };
                  }
                  // Passed all four rules — fall through to gates 2/3 below, same as
                  // any other merge: a self-build change still needs a grant and a
                  // fresh SHA.
                } else if (touchesExcludedPath(info.changedFiles)) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: "Refused: this PR touches a security-sensitive excluded path and can never merge through this pipeline. Changes to that code must be made directly by a human, outside this pipeline.",
                      },
                    ],
                  };
                }

                // Gate 2 — does this agent hold a github-pr grant covering this repo?
                const decision = decide(agent, this.deps.grants, "mergePR", { repo });
                if (decision.kind !== "allow") {
                  // A "park" decision means a grant DID match but needs human
                  // approval — this tool has no mechanism (unlike canUseTool)
                  // to suspend mid-call and wait for that, so it still
                  // refuses, but the message must not claim no grant exists.
                  const text =
                    decision.kind === "park"
                      ? `Refused: merging "${repo}" requires human approval of grant "${decision.grantRef}", which this tool cannot wait for.`
                      : `Refused: no grant authorises merging pull requests in "${repo}".`;
                  return { content: [{ type: "text" as const, text }] };
                }

                // Gate 3 — has a newer commit landed since this PR was reviewed?
                if (info.headSha !== expectedHeadSha) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Refused: PR head moved (expected ${expectedHeadSha}, now ${info.headSha}) — a newer commit landed since review started.`,
                      },
                    ],
                  };
                }
                const result = await github.mergePullRequest(repo, number, expectedHeadSha);
                if (!result.merged) {
                  return { content: [{ type: "text" as const, text: `Refused: ${result.reason}` }] };
                }
                return { content: [{ type: "text" as const, text: `Successfully merged ${repo}#${number}.` }] };
              },
            ),
            tool(
              "postReviewComment",
              "Post a comment on a pull request — findings, an explanation of why a merge was refused, or general review feedback. Never gated: commenting has no outward consequence beyond ordinary communication.",
              { repo: z.string(), number: z.number().int().positive(), body: z.string().min(1) },
              async ({ repo, number, body }) => {
                await github.postReviewComment(repo, number, body);
                return { content: [{ type: "text" as const, text: `Comment posted on ${repo}#${number}.` }] };
              },
            ),
            tool(
              "createRepo",
              "Create a new GitHub repository for a product this system is building. Use this before pushBranch/openPR when the task names a product with no repo yet — those tools require a repo that already exists. Only succeeds when a provision grant covers the target org.",
              {
                org: z.string().min(1).regex(/^[\w.-]+$/, "must be a valid GitHub org/user login"),
                name: z.string().min(1).regex(/^[\w.-]+$/, "must be a valid GitHub repo name"),
                private: z.boolean(),
                description: z.string().optional(),
              },
              async ({ org, name, private: isPrivate, description }) => {
                // Gate — does this agent hold a provision grant covering this org?
                const decision = decide(agent, this.deps.grants, "createRepo", { org, name });
                if (decision.kind !== "allow") {
                  const text =
                    decision.kind === "park"
                      ? `Refused: creating a repo in "${org}" requires human approval of grant "${decision.grantRef}", which this tool cannot wait for.`
                      : `Refused: no grant authorises creating a repo in "${org}".`;
                  return { content: [{ type: "text" as const, text }] };
                }

                // decide()'s "allow" carries no grantRef (only "park" does), so
                // the matched Grant is looked up directly here via matchGrant —
                // this is the one spot this tool needs the grant object itself
                // (for its `secret`), not just the yes/no decision.
                const effect = detectOutwardEffect("createRepo", { org, name })!;
                const relevantGrants = this.deps.grants.filter((g) => agent.grantRefs.includes(g.id));
                const grant = matchGrant(relevantGrants, effect);
                const token = grant ? process.env[grant.secret] : undefined;
                if (!grant || !token) {
                  return {
                    content: [
                      { type: "text" as const, text: `Refused: grant "${grant?.id}" has no ${grant?.secret} set.` },
                    ],
                  };
                }

                try {
                  const created = await github.createRepo(org, name, { private: isPrivate, description });
                  return { content: [{ type: "text" as const, text: `Created ${created.fullName} at ${created.url}.` }] };
                } catch (error) {
                  // Unlike pushBranch's GitPusher error, GithubApiTransport's
                  // thrown Error never embeds the token (it goes in a header,
                  // not a credential-bearing URL) — safe to surface verbatim,
                  // and the operator needs to know exactly what GitHub said.
                  return {
                    content: [
                      { type: "text" as const, text: `Refused: repo creation failed — ${error instanceof Error ? error.message : String(error)}` },
                    ],
                  };
                }
              },
            ),
            ...(gitCloner
              ? [
                  tool(
                    "cloneRepo",
                    "Clone a repo into the current workspace, with the credential embedded so git never falls back to an interactive prompt. Also the safe way to check whether a repo exists yet: a clean refusal means it doesn't (or another problem occurred) — never probe existence any other way.",
                    { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"') },
                    async ({ repo }: { repo: string }) => {
                      const decision = decide(agent, this.deps.grants, "cloneRepo", { repo });
                      if (decision.kind !== "allow") {
                        const text =
                          decision.kind === "park"
                            ? `Refused: cloning "${repo}" requires human approval of grant "${decision.grantRef}", which this tool cannot wait for.`
                            : `Refused: no grant authorises cloning "${repo}".`;
                        return { content: [{ type: "text" as const, text }] };
                      }

                      const effect = detectOutwardEffect("cloneRepo", { repo })!;
                      const relevantGrants = this.deps.grants.filter((g) => agent.grantRefs.includes(g.id));
                      const grant = matchGrant(relevantGrants, effect);
                      const token = grant ? process.env[grant.secret] : undefined;
                      if (!grant || !token) {
                        return {
                          content: [
                            { type: "text" as const, text: `Refused: grant "${grant?.id}" has no ${grant?.secret} set.` },
                          ],
                        };
                      }

                      try {
                        await gitCloner.clone({
                          remoteUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
                          targetDir: ctx.workspace,
                        });
                      } catch {
                        // Never interpolate the caught error: RealGitCloner shells out via
                        // execFile, and a failing `git clone` rejects with an Error whose
                        // .message very likely echoes the full remote URL back — including
                        // the credential-bearing token embedded in it above. Surfacing that
                        // verbatim would leak the live token in plaintext. This collapses
                        // "doesn't exist" and "some other failure" into one message
                        // deliberately, the same tradeoff pushBranch's own catch makes.
                        return {
                          content: [
                            {
                              type: "text" as const,
                              text: `Refused: clone of ${repo} failed — it may not exist yet, or another error occurred.`,
                            },
                          ],
                        };
                      }
                      return { content: [{ type: "text" as const, text: `Cloned ${repo} into the workspace.` }] };
                    },
                  ),
                ]
              : []),
            ...(gitPusher
              ? [
                  tool(
                    "pushBranch",
                    "Push the current branch to a new remote branch and prepare it for a PR. Refuses any branch outside the agent/builder/ namespace, and refuses if no grant authorises pushing to the target repo.",
                    { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'), branch: z.string().min(1) },
                    async ({ repo, branch }: { repo: string; branch: string }) => {
                      // Gate 1 — unconditional, same pattern as mergePR's excluded-path
                      // lock. No grant, no tier, nothing below this can override it.
                      if (!/^agent\/builder\//.test(branch)) {
                        return {
                          content: [
                            {
                              type: "text" as const,
                              text: `Refused: branch "${branch}" is outside the agent/builder/ namespace this tool will ever push to.`,
                            },
                          ],
                        };
                      }

                      // Gate 2 — does this agent hold a git-push grant covering this repo+branch?
                      const decision = decide(agent, this.deps.grants, "pushBranch", { repo, branch });
                      if (decision.kind !== "allow") {
                        const text =
                          decision.kind === "park"
                            ? `Refused: pushing to "${repo}" requires human approval of grant "${decision.grantRef}", which this tool cannot wait for.`
                            : `Refused: no grant authorises pushing to "${repo}".`;
                        return { content: [{ type: "text" as const, text }] };
                      }

                      // decide()'s "allow" carries no grantRef (only "park" does), so
                      // the matched Grant is looked up directly here via matchGrant —
                      // this is the one spot this tool needs the grant object itself
                      // (for its `secret`), not just the yes/no decision.
                      const effect = detectOutwardEffect("pushBranch", { repo, branch })!;
                      const relevantGrants = this.deps.grants.filter((g) => agent.grantRefs.includes(g.id));
                      const grant = matchGrant(relevantGrants, effect);
                      const token = grant ? process.env[grant.secret] : undefined;
                      if (!grant || !token) {
                        return {
                          content: [
                            { type: "text" as const, text: `Refused: grant "${grant?.id}" has no ${grant?.secret} set.` },
                          ],
                        };
                      }

                      try {
                        await gitPusher.push({
                          cwd: ctx.workspace,
                          remoteUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
                          branch,
                        });
                      } catch {
                        // Never interpolate the caught error: RealGitPusher shells out via
                        // execFile, and a failing `git push` rejects with an Error whose
                        // .message includes the full argv — including the credential-bearing
                        // remoteUrl built above. Surfacing that back to the model/transcript
                        // would leak the live push token in plaintext.
                        return { content: [{ type: "text" as const, text: `Refused: push to ${repo}:${branch} failed.` }] };
                      }
                      return { content: [{ type: "text" as const, text: `Pushed HEAD to ${repo}:${branch}.` }] };
                    },
                  ),
                ]
              : []),
            tool(
              "openPR",
              "Open a pull request for a branch that was already pushed via pushBranch. Never gated: by the time this runs, the code is already public on a branch that can only ever be outside the default branch — merging, the actual point of risk, stays behind mergePR's own gates.",
              {
                repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'),
                head: z.string().min(1),
                base: z.string().min(1),
                title: z.string().min(1),
                body: z.string(),
              },
              async ({ repo, head, base, title, body }) => {
                // Defense in depth, not a security boundary on its own —
                // pushBranch already refused any branch outside this
                // namespace before code could reach GitHub at all.
                if (!/^agent\/builder\//.test(head)) {
                  return {
                    content: [{ type: "text" as const, text: `Refused: "${head}" is outside the agent/builder/ namespace.` }],
                  };
                }
                const pr = await github.createPullRequest(repo, { head, base, title, body });
                return { content: [{ type: "text" as const, text: `Opened ${pr.url}.` }] };
              },
            ),
          ],
        })
      : undefined;

    const DEFAULT_SELF_QUEUED_PRIORITY = 30;
    const MAX_QUEUE_TASK_CALLS_PER_RUN = 3;
    const LIST_MY_TASKS_LIMIT = 20;
    const LIST_MY_TASKS_TEXT_TRUNCATE = 200;
    const RECENT_FAILURES_WINDOW_DAYS = 14;
    const RECENT_FAILURES_TOP_N = 10;
    const RECENT_FAILURES_REASON_TRUNCATE = 80;
    let queueTaskCalls = 0;
    const tasksDep = this.deps.tasks;
    const wakeDep = this.deps.wake;
    const taskReviewerDep = this.deps.taskReviewer;
    // Scoped to research alone: its own prompt.md is the only one instructed
    // to call queueTask off a "something concrete is worth building" research
    // conclusion — the one path that flows straight to `builder` and
    // eventually real spend (hosting, registration fees). The scouts/overseer
    // propose narrower, more reversible work (this system's own code, or a
    // research question), so review is not applied to them here.
    const TASK_REVIEW_AGENTS: ReadonlySet<string> = new Set(["research"]);
    const memoryDep = this.deps.memory;
    const memoryConfigDep = this.deps.memoryConfig;
    /**
     * None of these three tools has an outward effect (they only touch this
     * process's own task queue, not the network), so none of them needs a
     * grant and all are available at every tier, the same as `askHuman`
     * above. `listMyTasks` and `recentFailures` need only `tasksDep` — they
     * never touch the dispatcher. `queueTask` additionally needs `wakeDep`,
     * so it's included conditionally within this same server rather than
     * gating the whole server on both, the way it did before this tool
     * existed.
     */
    const taskQueueServer = tasksDep && TASK_QUEUE_AGENTS.has(agent.name)
      ? createSdkMcpServer({
          name: "taskQueue",
          tools: [
            ...(wakeDep
              ? [
                  tool(
                    "queueTask",
                    "Queue a new task for the system to work on later — the same durable queue a human's !task command adds to. Use this to propose research or an improvement rather than doing it yourself in this run. Give a `domain` and a one-line `subject` so the system can tell whether this repeats work it already did.",
                    {
                      text: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
                      priority: z.number().int().nonnegative().optional(),
                      domain: z.string().min(1).default("general"),
                      subject: z.string().min(1).max(200).optional(),
                      key: z.string().max(200).optional(),
                      importance: z.number().int().min(1).max(10).default(5),
                      goalAlignment: z.number().min(0).max(1).default(0.5),
                      // Matches TaskCategory in task-store.ts. Defaulted here too
                      // (not just in TaskStore.create()) so the tool's own schema
                      // documents the default to the model, the same as every
                      // other optional field on this tool.
                      category: z.enum(["exploration", "exploitation", "maintenance"]).default("exploitation"),
                    },
                    async ({ text, priority, domain, subject, key, importance, goalAlignment, category }) => {
                      // A hard cap enforced here, not just in the prompt: the code is
                      // the boundary, the same posture detectOutwardEffect already
                      // uses for outward effects — an over-eager or confused model
                      // must not be able to flood the queue in a single run.
                      if (queueTaskCalls >= MAX_QUEUE_TASK_CALLS_PER_RUN) {
                        return {
                          content: [
                            {
                              type: "text" as const,
                              text: `Refused: already queued ${MAX_QUEUE_TASK_CALLS_PER_RUN} tasks this run, the maximum allowed in one run.`,
                            },
                          ],
                        };
                      }

                      const memory = memoryDep;
                      const cfg = memoryConfigDep;
                      let annotation = "";
                      let computedPriority = Math.min(priority ?? DEFAULT_SELF_QUEUED_PRIORITY, DEFAULT_SELF_QUEUED_PRIORITY);

                      if (memory && cfg?.enabled) {
                        const now = new Date();
                        const candidate = { domain, subject: subject ?? text.slice(0, 200), ...(key ? { key } : {}) };
                        const verdict = assessNovelty(candidate, await memory.list(), {
                          threshold: cfg.similarityThreshold,
                          stalenessDays: cfg.stalenessDays,
                          now,
                        });

                        if (verdict.kind === "suppressed") {
                          // Counted against the per-run cap deliberately: a run
                          // that keeps proposing duplicates should run out of
                          // attempts rather than retry forever.
                          queueTaskCalls += 1;
                          // Best-effort, exactly like the dispatcher's
                          // rememberBestEffort: a memory write that throws must
                          // never turn a decided tool call into a generic SDK
                          // error, which a well-behaved agent would read as
                          // "that didn't go through" and retry.
                          try {
                            await memory.append({
                              domain, kind: "proposal", subject: candidate.subject, body: `suppressed as a duplicate of ${verdict.priorId}`,
                              importance, createdBy: `agent:${agent.name}`,
                            });
                          } catch (error) {
                            console.error(`[queueTask] failed to record suppressed duplicate for agent ${agent.name}`, error);
                          }
                          return {
                            content: [{ type: "text" as const, text: `Refused: this already covers work recorded as achieved (${verdict.priorId}, similarity ${verdict.maxSimilarity.toFixed(2)}). Propose something else.` }],
                          };
                        }

                        if (verdict.kind === "retry" && verdict.priorReason) {
                          annotation = `\n\n(A previous attempt at closely related work recorded: "${verdict.priorReason}". Take that into account.)`;
                        }

                        computedPriority = toPriority(
                          priorityScore(
                            { goalAlignment, maxSimilarity: verdict.maxSimilarity, importance, proposedAt: now.toISOString() },
                            cfg.weights,
                            now,
                          ),
                        );
                      }

                      // After the free novelty check, before the paid review
                      // call: no reason to spend on grading a proposal that
                      // would already have been refused as a duplicate.
                      if (taskReviewerDep && TASK_REVIEW_AGENTS.has(agent.name)) {
                        try {
                          const review = await taskReviewerDep.review({
                            text, domain, subject, createdBy: `agent:${agent.name}`,
                          });
                          if (!review.allowed) {
                            // Counted against the per-run cap, same as the
                            // duplicate-refusal above: a run that keeps
                            // proposing ungrounded ideas should run out of
                            // attempts rather than retry forever.
                            queueTaskCalls += 1;
                            return {
                              content: [
                                {
                                  type: "text" as const,
                                  text: `Refused: automated review found this rationale not adequately grounded — ${review.reason}. Strengthen the sourcing or drop this proposal.`,
                                },
                              ],
                            };
                          }
                        } catch (error) {
                          // Never allowed to block queueTask itself: a grading
                          // call that errors or hangs is a lost review, not a
                          // lost proposal — same posture Orchestrator takes
                          // toward a failed OutcomeVerifier call.
                          console.error(`[queueTask] review failed for agent ${agent.name}`, error);
                        }
                      }

                      queueTaskCalls += 1;
                      const created = await tasksDep.create({
                        // `text` alone was already bounded by the schema's
                        // .max(MAX_TASK_TEXT_LENGTH) above, but `annotation`
                        // (built from a prior record's full body) is appended
                        // afterwards, so only the combined string is what
                        // actually has to respect the cap.
                        text: `${text}${annotation}`.slice(0, MAX_TASK_TEXT_LENGTH),
                        priority: computedPriority,
                        createdBy: `agent:${agent.name}`,
                        wantsDetail: true,
                        category,
                      });
                      if (memory && cfg?.enabled) {
                        // Best-effort for the same reason as the suppressed
                        // branch above — the task is already created, and
                        // losing its proposal record is far better than
                        // reporting a failure that invites a duplicate.
                        try {
                          await memory.append({
                            domain, kind: "proposal", subject: subject ?? text.slice(0, 200), ...(key ? { key } : {}),
                            body: text, importance, createdBy: `agent:${agent.name}`, sourceTaskId: created.id,
                          });
                        } catch (error) {
                          console.error(`[queueTask] failed to record proposal ${created.id} for agent ${agent.name}`, error);
                        }
                      }
                      void wakeDep().catch((err: unknown) => {
                        console.error(`[queueTask] dispatcher wake failed after queuing ${created.id} (agent ${agent.name})`, err);
                      });
                      return { content: [{ type: "text" as const, text: `Queued task ${created.id} at priority ${created.priority}.` }] };
                    },
                  ),
                ]
              : []),
            // research is a pure web-research specialist, categorically
            // different from the self-improving scouts and overseer these
            // three tools exist for — its own prompt.md calls queueTask
            // and nothing else on this server. Excluding it here doesn't
            // touch the "available at every tier" design the rest of this
            // server keeps (see the doc comment above): every other agent
            // with tasksDep wired in still gets them exactly as before.
            ...(agent.name !== "research"
              ? [
                  tool(
                    "listMyTasks",
                    "List the tasks you've queued yourself via queueTask, most recent first — use this before proposing new work so you don't repeat an idea you already queued.",
                    {},
                    async () => {
                const mine = (await tasksDep.list())
                  .filter((t) => t.createdBy === `agent:${agent.name}`)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .slice(0, LIST_MY_TASKS_LIMIT)
                  .map((t) => ({
                    id: t.id,
                    text: t.text.length > LIST_MY_TASKS_TEXT_TRUNCATE ? `${t.text.slice(0, LIST_MY_TASKS_TEXT_TRUNCATE)}…` : t.text,
                    status: t.status,
                    createdAt: t.createdAt,
                  }));
                return { content: [{ type: "text" as const, text: JSON.stringify(mine, null, 2) }] };
              },
            ),
            tool(
              "recentFailures",
              "See aggregate patterns in recently failed tasks across the whole system — which specialist, what kind of failure, how often — over the last 14 days. Never includes the original task text.",
              {},
              async () => {
                const cutoff = Date.now() - RECENT_FAILURES_WINDOW_DAYS * 24 * 60 * 60 * 1000;
                const failed = (await tasksDep.list()).filter(
                  (t) => t.status === "failed" && t.finishedAt !== undefined && new Date(t.finishedAt).getTime() >= cutoff,
                );
                const buckets = new Map<string, { specialistAgent: string; reason: string; count: number; exampleTaskId: string }>();
                for (const t of failed) {
                  const specialistAgent = t.specialistAgent ?? "unrouted";
                  const reason = (t.failureReason ?? "(no reason recorded)").slice(0, RECENT_FAILURES_REASON_TRUNCATE);
                  const key = `${specialistAgent}\u0000${reason}`;
                  const existing = buckets.get(key);
                  if (existing) existing.count += 1;
                  else buckets.set(key, { specialistAgent, reason, count: 1, exampleTaskId: t.id });
                }
                const top = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, RECENT_FAILURES_TOP_N);
                return { content: [{ type: "text" as const, text: JSON.stringify(top, null, 2) }] };
              },
            ),
                ]
              : []),
            ...(memoryDep && memoryConfigDep?.enabled && agent.name !== "research"
              ? [
                  tool(
                    "recallMemory",
                    "Search what this system already knows about a subject — prior findings, outcomes, and reflections. Call this BEFORE proposing work, so you don't propose something that has already been done and will be refused.",
                    { subject: z.string().min(1).max(200), domain: z.string().min(1) },
                    async ({ subject, domain }) => {
                      const text = retrieveContext(subject, domain, await memoryDep.list(), {
                        limit: 8,
                        halfLifeDays: memoryConfigDep.recencyHalfLifeDays,
                        now: new Date(),
                      });
                      return { content: [{ type: "text" as const, text: text || "Nothing recorded on this subject yet." }] };
                    },
                  ),
                ]
              : []),
          ],
        })
      : undefined;

    const worldDep = this.deps.world;
    const findingReviewerDep = this.deps.findingReviewer;
    /**
     * The world model's write side — agents/research and the scouts read it
     * via `world.summaryForPrompt()` baked into their prompt (see
     * Dispatcher), but until now had no way to write back, so every run's
     * conclusion terminated in a Discord message. Gated on `worldDep` alone,
     * same pattern as `taskQueueServer` above: not registered at all when the
     * dependency isn't wired in, rather than registered-but-erroring.
     */
    // recordFinding and updatePortfolioEntry each go to exactly one agent —
    // research's prompt.md is the only one that ever calls recordFinding,
    // and updatePortfolioEntry is a product-portfolio concept only
    // overseer's prompt touches (grep every agents/*/prompt.md to confirm).
    // Unlike taskQueue above, this server makes no "every tier" claim, so
    // each tool — and the server itself, when an agent calls neither — is
    // scoped to its one real caller rather than mounted for everyone with
    // `worldDep` wired in.
    const RECORD_FINDING_AGENTS: ReadonlySet<string> = new Set(["research"]);
    const UPDATE_PORTFOLIO_ENTRY_AGENTS: ReadonlySet<string> = new Set(["overseer"]);
    const worldModelServer =
      worldDep && (RECORD_FINDING_AGENTS.has(agent.name) || UPDATE_PORTFOLIO_ENTRY_AGENTS.has(agent.name))
        ? createSdkMcpServer({
            name: "worldModel",
            tools: [
              ...(RECORD_FINDING_AGENTS.has(agent.name)
                ? [
                    tool(
                      "recordFinding",
                      "Record what you concluded about a topic in the shared world model, so other agents see it before repeating the same research. Call this at the end of every run, INCLUDING when the conclusion is that something is not worth pursuing and why — a recorded dead end is what stops the same ground being covered again in three months.",
                      {
                        topic: z.string().min(1).max(200),
                        conclusion: z.string().min(1),
                        confidence: z.enum(["low", "medium", "high"]),
                        sources: z.array(z.string()).default([]),
                      },
                      async ({ topic, conclusion, confidence, sources }) => {
                        let finalConclusion = conclusion;
                        let finalConfidence = confidence;
                        // Never allowed to block recordFinding itself: a grading
                        // call that errors or hangs is a lost review, not a lost
                        // finding — same posture Orchestrator takes toward
                        // OutcomeVerifier failing.
                        if (findingReviewerDep) {
                          try {
                            const review = await findingReviewerDep.review({ topic, conclusion, confidence, sources });
                            if (review.confidence !== confidence) {
                              finalConfidence = review.confidence;
                              finalConclusion = `${conclusion}\n\n[Automated review downgraded confidence from ${confidence} to ${review.confidence}: ${review.note ?? "no reason given"}]`;
                            }
                          } catch (error) {
                            console.error(`[recordFinding] review failed for topic "${topic}"`, error);
                          }
                        }
                        await worldDep.writeFinding(topic, {
                          topic,
                          conclusion: finalConclusion,
                          confidence: finalConfidence,
                          sources,
                          updatedAt: new Date().toISOString(),
                        });
                        return { content: [{ type: "text" as const, text: `Recorded finding for "${topic}".` }] };
                      },
                    ),
                  ]
                : []),
              ...(UPDATE_PORTFOLIO_ENTRY_AGENTS.has(agent.name)
                ? [
                    tool(
                      "updatePortfolioEntry",
                      "Replace this product's entry in the shared portfolio — its status, next review date, the bar it must clear, running cost, and leading-indicator notes. Replaces the whole entry (not a merge), so pass every field even when only one changed.",
                      {
                        slug: z.string().min(1).max(200),
                        purpose: z.string().min(1),
                        status: z.enum(["building", "live", "paused", "killed"]),
                        nextReviewAt: z.string().min(1),
                        bar: z.string().min(1),
                        monthlyCostUsd: z.number().nonnegative(),
                        notes: z.array(z.string()).default([]),
                        extensionCount: z.number().int().nonnegative().default(0),
                      },
                      async (entry) => {
                        await worldDep.upsertPortfolioEntry(entry);
                        return { content: [{ type: "text" as const, text: `Updated portfolio entry "${entry.slug}".` }] };
                      },
                    ),
                  ]
                : []),
            ],
          })
        : undefined;

    const ExpectationCheckSchema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("netIncomeUsd"), atLeast: z.number() }).strict(),
      z.object({ kind: z.literal("productRevenueUsd"), product: z.string().min(1), atLeast: z.number() }).strict(),
      z.object({ kind: z.literal("portfolioStatus"), slug: z.string().min(1), is: z.literal("live") }).strict(),
    ]);
    const ExpectationSchema = z.object({
      id: z.string().min(1),
      dueAt: z.string().min(1),
      check: ExpectationCheckSchema,
    }).strict();

    const strategyDep = this.deps.strategyStore;
    const overridesDep = this.deps.overrides;
    const breakerDep = this.deps.breaker;
    const knownAgents = this.deps.agents;
    const outboxDep = this.deps.outbox;
    /**
     * The overseer's own write tools (Task C3) — a separate MCP server from
     * `worldModel` above because these two capabilities are unrelated
     * (StrategyStore vs. the disabledAgents override + breaker) and each is
     * gated on its own deps, exactly like `queueTask` is gated on `wakeDep`
     * within the already-gated `taskQueueServer`.
     *
     * Also gated on `agent.name === "overseer"`, unlike every other MCP
     * server in this file: those deps are wired once into this SdkRunner
     * instance and then apply to every agent that runs through it (the same
     * reason `recordFinding`/`queueTask` are already available to research
     * and the scouts, not just one agent), but `writeStrategy` and
     * `setAgentEnabled` are the two tools Design §3 of the
     * autonomous-operation plan is built on the premise that only the
     * overseer holds — a re-enable that bypasses probation, or a rewrite of
     * the system's stated strategy, from `builder` or `research` would be
     * exactly the "manager in the execution path" escalation that plan
     * explicitly rejects. Neither tool has an outward effect `decide()`
     * would otherwise gate, so this registration-time check is the only
     * mechanical boundary available — refusing at registration (the tool
     * simply does not exist for another agent) rather than inside the
     * handler, so there is nothing to call in the first place.
     */
    const overseerServer =
      agent.name === "overseer" && (strategyDep || (overridesDep && breakerDep && knownAgents))
        ? createSdkMcpServer({
            name: "overseer",
            tools: [
              ...(strategyDep
                ? [
                    tool(
                      "writeStrategy",
                      "Write this cycle's strategy — the only way to record what the system is trying to do and why. StrategyStore rejects an allocation that does not sum to 100 with a tool error rather than renormalising it, so correct and retry rather than guessing. Call this once, near the end of your run.",
                      {
                        intent: z.string().min(1),
                        allocation: z
                          .object({
                            research: z.number().min(0).max(100),
                            build: z.number().min(0).max(100),
                            maintain: z.number().min(0).max(100),
                          })
                          .strict(),
                        expectations: z.array(ExpectationSchema),
                        changeReason: z.string(),
                      },
                      async ({ intent, allocation, expectations, changeReason }) => {
                        try {
                          await strategyDep.write({
                            writtenAt: new Date().toISOString(),
                            intent,
                            allocation,
                            expectations,
                            changeReason,
                          });
                        } catch (error) {
                          return {
                            content: [
                              { type: "text" as const, text: `Refused: ${error instanceof Error ? error.message : String(error)}` },
                            ],
                          };
                        }
                        return { content: [{ type: "text" as const, text: "Strategy written for this cycle." }] };
                      },
                    ),
                  ]
                : []),
              ...(overridesDep && breakerDep && knownAgents
                ? [
                    tool(
                      "setAgentEnabled",
                      'Enable or disable an agent, writing the same override `!disable`/`!enable` use. Use this ONLY to undo an automatic probation disable (Task A1) on an agent other than yourself, with a reason. Refuses to disable "overseer" — it is the only thing that writes strategy, so disabling it would be unrecoverable without the operator. Re-enabling also resets that agent\'s circuit breaker, since either mechanism alone can halt an agent.',
                      {
                        agent: z.string().min(1),
                        enabled: z.boolean(),
                        reason: z.string().min(1),
                      },
                      async ({ agent: targetName, enabled, reason }) => {
                        if (!knownAgents.some((a) => a.name === targetName)) {
                          const known = knownAgents.map((a) => a.name).join(", ") || "(none loaded)";
                          return {
                            content: [
                              { type: "text" as const, text: `Refused: no agent named "${targetName}" is loaded. Known agents: ${known}` },
                            ],
                          };
                        }
                        if (targetName === "overseer" && !enabled) {
                          return {
                            content: [
                              {
                                type: "text" as const,
                                text: "Refused: the overseer cannot disable itself — it is the only thing that writes strategy, and disabling it would be unrecoverable without the operator.",
                              },
                            ],
                          };
                        }

                        const current = await overridesDep.read();
                        const disabled = new Set(current.disabledAgents ?? []);
                        if (enabled) disabled.delete(targetName);
                        else disabled.add(targetName);
                        await overridesDep.set("disabledAgents", [...disabled], `agent:${agent.name}`);
                        if (enabled) await breakerDep.reset(targetName);

                        // Best-effort, same posture as Task A1's auto-disable
                        // alert: a silent change here is the exact
                        // silent-failure class this whole mechanism exists to
                        // close, but a failed post must never fail the tool
                        // call — the override is already durably written.
                        await outboxDep
                          ?.postAlert(
                            "ops",
                            `${enabled ? "▶️" : "⏸️"} ${targetName} ${enabled ? "enabled" : "disabled"} by the overseer: ${reason}`,
                          )
                          .catch((error: unknown) => {
                            console.error(`[setAgentEnabled] failed to post alert for ${targetName}`, error);
                          });

                        return { content: [{ type: "text" as const, text: `${targetName} ${enabled ? "enabled" : "disabled"}.` }] };
                      },
                    ),
                  ]
                : []),
            ],
          })
        : undefined;

    const stream = query({
      prompt: ctx.prompt,
      options: {
        model: agent.run.model,
        effort: agent.run.effort,
        maxTurns: agent.run.maxTurns,
        maxBudgetUsd: agent.run.maxBudgetUsd,
        agents: {
          [PR_REVIEW_SUBAGENT_TYPE]: PR_REVIEW_SUBAGENT,
          [RESEARCH_SOURCE_SUBAGENT_TYPE]: RESEARCH_SOURCE_SUBAGENT,
        },
        cwd: ctx.workspace,
        // Deliberately NOT passing `allowedTools`: the SDK auto-approves any
        // tool named there without ever consulting `canUseTool` (it only
        // routes a call through the "ask" path — where canUseTool lives —
        // when the tool isn't already on that auto-allow list). Since every
        // tool `canUseTool` needs to gate (WebFetch, Bash, ...) is also on
        // the agent's own allowedTools list, setting both would let the SDK
        // auto-approve exactly the calls this boundary exists to intercept.
        // `tools` (below) still controls what's loaded/available — that's
        // unrelated to auto-approval — and `disallowedTools` is still a hard
        // block, also unrelated. Leaving `allowedTools` unset means every
        // tool call routes through `canUseTool`, where `decide()` is the
        // actual arbiter: non-outward-effect calls (Read, Glob, ...) still
        // get `{kind: "allow"}` immediately, just with one extra async
        // round-trip.
        disallowedTools: agent.permissions.disallowedTools,
        tools: agent.permissions.allowedTools,
        permissionMode: "default",
        settingSources: [],
        // Explicitly request the 1-hour cache TTL rather than relying on
        // the SDK's own default: absent this, the resolver falls back to 5
        // minutes unless ENABLE_PROMPT_CACHING_1H is set in the environment
        // (nothing in this repo sets it) -- verified against the installed
        // SDK's own resolution function, not just its (inconsistent) doc
        // string. 5 minutes is long enough for a healthy run's own
        // turn-to-turn gaps, but not for a governor-paced retry or
        // rate-limit backoff longer than that -- exactly the condition this
        // system is built around, and exactly when a cold cache costs the
        // most. No content-fidelity risk (unlike autoCompactWindow below),
        // so this applies to every agent, not just research.
        settings: {
          promptCacheTtl: "1h",
          subagentPromptCacheTtl: "1h",
          ...(agent.name === "research" ? { autoCompactWindow: RESEARCH_AUTO_COMPACT_WINDOW } : {}),
        },
        env: childEnv,
        abortController: controller,
        canUseTool,
        mcpServers: {
          askHuman: askHumanServer,
          ...(githubPrServer ? { githubPr: githubPrServer } : {}),
          ...(taskQueueServer ? { taskQueue: taskQueueServer } : {}),
          ...(systemContextServer ? { systemContext: systemContextServer } : {}),
          ...(worldModelServer ? { worldModel: worldModelServer } : {}),
          ...(overseerServer ? { overseer: overseerServer } : {}),
        },
        ...(ctx.resume ? { resume: ctx.resume } : {}),
      },
    });

    let partial: PartialUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let sawTerminalUsage = false;
    // Counted across ALL tools, with any success resetting it, rather than
    // per-tool: the run this exists because of alternated WebFetch and
    // WebSearch failures, so a per-tool counter would never have tripped.
    // The reset is also what keeps this away from `builder`, whose red-green
    // loop fails Bash on purpose — an Edit or Read between two failing test
    // runs clears the count, so tripping it takes five consecutive failures
    // with no tool succeeding at all, which is not a working loop by then.
    let consecutiveToolFailures = 0;

    // Invariant: a message already pulled off the stream is NEVER discarded,
    // aborted or not — it may be the only place a run's token usage shows up.
    // So every message is processed unconditionally (accumulate its usage,
    // map it to events, yield those events); the abort signal is checked only
    // AFTER processing, and only to decide whether to stop asking the stream
    // for more messages. Checking the abort state BEFORE mapping a message
    // that was already pulled would silently drop its usage/events, which is
    // the exact bug this file exists to fix (see accumulateUsage's doc
    // comment) — just for the specific message that races the abort.
    //
    // Checked here against `controller.signal`, not the outer `signal`
    // parameter: `linkAbort` only propagates outer -> inner, so an outer
    // abort/timeout always shows up on `controller.signal` too, but
    // canUseTool/AskHuman abort `controller` directly (they don't own
    // `signal`) — checking the outer `signal` here would never observe a
    // park/deny decision, and the terminalEvent below would never be
    // reached. `controller.signal.aborted` is true in every case that
    // matters, so it's the single condition both paths share.
    //
    // Wrapped in try/catch: the real SDK's transport REJECTS the async
    // iterator when `controller.abort()` is called mid-stream (it does not
    // just stop yielding), so `canUseTool`/`AskHuman` calling
    // `controller.abort()` makes this `for await` throw, not exit quietly.
    // Without the catch, that throw would propagate out of `execute()`
    // instead of reaching the post-loop block below — the caller would see
    // the run as crashed and never learn it was parked/denied. A rejection
    // that happens for any OTHER reason (a genuine transport failure) must
    // still propagate, so it's only swallowed when `controller.signal` is
    // the reason we know something aborted it.
    try {
      for await (const message of stream) {
        const record = message as Record<string, unknown>;
        if (typeof record.session_id === "string") {
          sessionId = record.session_id;
          resolveSessionId(record.session_id);
        }

        partial = accumulateUsage(partial, message);
        const events = toRunEvents(message);
        if (events.some((e) => e.type === "usage")) sawTerminalUsage = true;
        yield* events;

        for (const event of events) {
          if (event.type !== "tool_result") continue;
          consecutiveToolFailures = event.ok ? 0 : consecutiveToolFailures + 1;
        }
        if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          // "interrupted", not "error": the agent did nothing wrong, and an
          // "error" would count toward its circuit breaker — so three
          // unrelated outages in a row would disable the agent until a human
          // reset it. That is the same shape as the rate-limit deadlock: a
          // transient external fault turned into a permanent lockout.
          terminalEvent = {
            type: "interrupted",
            reason:
              `Stopped after ${consecutiveToolFailures} consecutive tool failures with nothing succeeding in between. ` +
              `The tools this run depends on are not working, and retrying a broken tool costs the same as using a working one.`,
          };
          controller.abort();
          break;
        }

        if (controller.signal.aborted) break;
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
      // else: this is the abort-caused rejection from the transport — fall
      // through to the post-loop block below, same as a clean break.
    }

    // Safety valve: resolve sessionIdPromise (a no-op if a message already
    // did) once the stream has been fully consumed either way. Without this,
    // a canUseTool/AskHuman call that lands after the stream has already
    // ended without ever carrying a session_id — e.g. a stream that closes
    // before any message reports one — would leave that handler's
    // `await sessionIdPromise` unsettled forever instead of falling back to
    // whatever (possibly still "") sessionId was captured.
    resolveSessionId(sessionId);

    // Fallback synthesis, reached either by the `break` above (aborted
    // mid-loop, after the last-pulled message was fully processed) or by the
    // stream simply ending on its own once aborted (the SDK may just stop
    // yielding without ever handing back another message to trigger the
    // check inside the loop) — either way, if the terminal `result` message
    // never arrived but per-turn usage was accumulated, that's the only
    // record of what the run actually spent. Gated on controller.signal.aborted
    // (see the loop comment above for why): a stream that ends early for some
    // OTHER reason (crash, unexpected close, protocol hiccup) with no `result`
    // message is not this fix's concern — synthesizing here is specifically
    // the abort fallback, not a generic "stream ended without a result"
    // fallback. Single call site: this used to be duplicated at two points
    // inside the loop, and now also covers yielding the parked/denied
    // terminalEvent set by canUseTool/AskHuman, for the same reason.
    if (controller.signal.aborted) {
      if (!sawTerminalUsage && (partial.inputTokens > 0 || partial.outputTokens > 0)) {
        yield {
          type: "usage",
          inputTokens: partial.inputTokens,
          outputTokens: partial.outputTokens,
          cacheReadTokens: partial.cacheReadTokens,
          cacheCreationTokens: partial.cacheCreationTokens,
          costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens),
          durationMs: 0,
        };
      }
      if (terminalEvent) yield terminalEvent;
    }
  }
}
