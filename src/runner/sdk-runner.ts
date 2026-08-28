import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { touchesExcludedPath } from "../control/excluded-paths.js";
import type { GitPusher } from "../control/git-pusher.js";
import type { GithubTransport } from "../control/github-transport.js";
import { PendingStore } from "../control/pending.js";
import { MAX_TASK_TEXT_LENGTH, TaskStore } from "../control/task-store.js";
import { decide, detectOutwardEffect, matchGrant, type Grant } from "../grants.js";
import type { AgentDef } from "../registry.js";
import { resolveCredentials } from "./credentials.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

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
      const events: RunEvent[] = [
        {
          type: "usage",
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
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
      /** Wired in production (src/index.ts); optional so tests/scripts that don't care about task-queueing can skip it, the same shape `github` already uses. */
      tasks?: TaskStore;
      /** Wakes the dispatcher after queueTask adds work, so it's picked up on this tick rather than waiting for the next periodic one. */
      wake?: () => Promise<void>;
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

    // The mergePR tool, only registered when a GithubTransport dependency was
    // provided (agents that don't merge PRs never see it). Three gates run in
    // this order, each unconditionally, and none can be bypassed by an
    // earlier gate's outcome:
    //   1. excluded-path check — a PR touching a security-sensitive path can
    //      never merge through this pipeline, no matter what grant or review
    //      exists. Checked against `getPullRequest`'s own authoritative
    //      `changedFiles`, NOT anything the calling model supplies — a
    //      `changedFiles` tool argument would be exactly the kind of value
    //      "trusted from an earlier step" that Lock 4 exists to rule out
    //      (prompt injection in the PR diff/body, a truncated file list, or
    //      plain model error could all under-report what a PR touches), so
    //      the tool doesn't accept one at all.
    //   2. grant check — does this agent hold a github-pr grant covering this
    //      repo, via decide()/detectOutwardEffect/matchGrant.
    //   3. stale-SHA check — the freshly-fetched head is compared against
    //      what the agent believed it reviewed, then GithubTransport.
    //      mergePullRequest re-verifies the same thing itself immediately
    //      before merging (defense in depth against a commit landing in the
    //      gap between the fetch above and the merge call).
    const github = this.deps.github;
    const gitPusher = this.deps.gitPusher;
    const githubPrServer = github
      ? createSdkMcpServer({
          name: "githubPr",
          tools: [
            tool(
              "mergePR",
              "Merge a pull request that has passed review. Only succeeds if the repo is granted, the diff doesn't touch a security-sensitive path, and the PR's head hasn't moved since you reviewed it.",
              {
                repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'),
                number: z.number().int().positive(),
                expectedHeadSha: z.string().min(1),
              },
              async ({ repo, number, expectedHeadSha }) => {
                const info = await github.getPullRequest(repo, number);

                // Gate 1 — the excluded-path check, against the PR's real,
                // GitHub-reported changed files. This runs first and
                // unconditionally: no grant, no review verdict, nothing
                // later in this handler can override it.
                if (touchesExcludedPath(info.changedFiles)) {
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
    const taskQueueServer = tasksDep
      ? createSdkMcpServer({
          name: "taskQueue",
          tools: [
            ...(wakeDep
              ? [
                  tool(
                    "queueTask",
                    "Queue a new task for the system to work on later — the same durable queue a human's !task command adds to. Use this to propose research or an improvement rather than doing it yourself in this run.",
                    { text: z.string().min(1).max(MAX_TASK_TEXT_LENGTH), priority: z.number().int().nonnegative().optional() },
                    async ({ text, priority }) => {
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
                      queueTaskCalls += 1;
                      const created = await tasksDep.create({
                        text,
                        priority: Math.min(priority ?? DEFAULT_SELF_QUEUED_PRIORITY, DEFAULT_SELF_QUEUED_PRIORITY),
                        createdBy: `agent:${agent.name}`,
                        wantsDetail: true,
                      });
                      void wakeDep().catch((err: unknown) => {
                        console.error(`[queueTask] dispatcher wake failed after queuing ${created.id} (agent ${agent.name})`, err);
                      });
                      return { content: [{ type: "text" as const, text: `Queued task ${created.id}.` }] };
                    },
                  ),
                ]
              : []),
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
        env: childEnv,
        abortController: controller,
        canUseTool,
        mcpServers: {
          askHuman: askHumanServer,
          ...(githubPrServer ? { githubPr: githubPrServer } : {}),
          ...(taskQueueServer ? { taskQueue: taskQueueServer } : {}),
        },
        ...(ctx.resume ? { resume: ctx.resume } : {}),
      },
    });

    let partial: PartialUsage = { inputTokens: 0, outputTokens: 0 };
    let sawTerminalUsage = false;

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
          costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens),
          durationMs: 0,
        };
      }
      if (terminalEvent) yield terminalEvent;
    }
  }
}
