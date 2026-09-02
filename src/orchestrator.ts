import { mkdir, readFile } from "node:fs/promises";
import type { OutcomeVerifier } from "./control/outcome-verifier.js";
import type { PendingEntry } from "./control/pending.js";
import type { Governor } from "./governor.js";
import type { DiscordOutbox } from "./outbox/discord.js";
import type { AgentDef } from "./registry.js";
import { RunStore, newRunId, type RunResult, type RunStatus } from "./run-store.js";
import type { RunContext, Runner } from "./runner/types.js";
import type { ApprovedGrantsStore } from "./state/approved-grants.js";
import type { BreakerStore } from "./state/breaker.js";

/**
 * Tells an agent, in its own prompt, exactly where its workspace is.
 *
 * Every agent prompt already says "your workspace", and nothing made that
 * true. `SdkRunner` passes `cwd: ctx.workspace` to the SDK, but file tools
 * resolve a RELATIVE path against the process working directory — so an agent
 * asked to write `findings-x.md` put it in the repo root, and one that took
 * "workspace" literally created a `workspace/` directory there. An earlier run
 * wrote to `/tmp` for the same reason.
 *
 * That matters beyond tidiness: `docs/decisions.md` gives "agents separated by
 * workspace directory" as a reason per-run container isolation was not needed.
 * The separation only holds if agents know the path, so naming it here is what
 * makes the claim true rather than aspirational.
 *
 * Appended by the orchestrator rather than written into each prompt.md so it
 * cannot drift per agent, and so a self-built agent gets it automatically.
 */
export function workspaceNote(workspace: string): string {
  return (
    `Your workspace is \`${workspace}\`.\n\n` +
    `Write every file you create there, using that absolute path. A bare or relative filename ` +
    `does NOT land in your workspace — it lands wherever this process happens to be running, ` +
    `which is not yours to write to.`
  );
}

/**
 * Whether a run's error came from the subscription's rate limit rather than
 * from anything the agent did. Shared by the status classification and the
 * governor's backoff so the two can never disagree about what counts.
 */
function isRateLimitError(message: string): boolean {
  return message.includes("rate_limit");
}

export class Orchestrator {
  private readonly runner: Runner;
  private readonly store: RunStore;
  private readonly outbox: DiscordOutbox;
  private readonly dataDir: string;
  private readonly governor: Governor;
  private readonly breaker: BreakerStore;
  private readonly approvedGrants: ApprovedGrantsStore;
  private readonly onParked?: (pendingId: string, kind: "approval" | "question") => Promise<void>;
  private readonly verifier?: OutcomeVerifier;

  constructor(opts: {
    runner: Runner;
    store: RunStore;
    outbox: DiscordOutbox;
    dataDir: string;
    governor: Governor;
    breaker: BreakerStore;
    approvedGrants: ApprovedGrantsStore;
    /**
     * Announces a park/question the moment it happens, rather than leaving the
     * operator to discover it at the next process restart. Optional so tests
     * (and any embedding without a control surface) need not supply one; a
     * failure inside it is caught and logged, never allowed to fail the run.
     */
    onParked?: (pendingId: string, kind: "approval" | "question") => Promise<void>;
    /**
     * Grades a status "success" run's own objective, not just that the SDK
     * finished without erroring. Optional so tests that don't care about
     * verification need not supply one — no verifier means no grading, not a
     * default "unclear" for every run.
     */
    verifier?: OutcomeVerifier;
  }) {
    this.runner = opts.runner;
    this.store = opts.store;
    this.outbox = opts.outbox;
    this.dataDir = opts.dataDir;
    this.governor = opts.governor;
    this.breaker = opts.breaker;
    this.approvedGrants = opts.approvedGrants;
    this.onParked = opts.onParked;
    this.verifier = opts.verifier;
  }

  /**
   * @param promptContext Extra per-invocation content appended to the
   * file-read prompt. `agent.promptPath` alone is enough for a `cron` agent
   * (the same task every day), but a `webhook` agent needs to say which PR
   * this particular run is about — that's what this parameter carries.
   */
  /**
   * @param onAdmitted Fires once Governor.admit() actually resolves "admit" —
   * i.e. the moment this run has a real concurrency slot and execution is
   * about to begin, not when the caller merely asked to start one. admit()
   * itself can block for a long time here: acquireSlot queues behind every
   * other run sharing config.yaml's maxConcurrent, and there is no other
   * signal for "still waiting its turn" vs. "now actually running". Callers
   * that need that distinction (Dispatcher, to keep a Task's status honest —
   * see TaskStore's "queued" vs "running") pass this; callers that don't
   * (cron, webhook) simply omit it. Best-effort: a failure here must never
   * fail the run itself, so it is caught and logged, not awaited-and-thrown.
   */
  async executeRun(
    agent: AgentDef,
    now: Date = new Date(),
    promptContext?: string,
    onAdmitted?: () => void | Promise<void>,
  ): Promise<RunResult | undefined> {
    const admitted = await this.governor.admit(agent, "trigger");
    if (admitted.kind === "refuse") {
      console.log(`[governor] refused ${agent.name}: ${admitted.reason}`);
      if (admitted.alert) {
        await this.outbox.postAlert(agent.outbox.discord, `⚠️ **${agent.name}** was refused a run: ${admitted.reason}`).catch((err: unknown) => {
          console.error(`[orchestrator] failed to post refusal alert for ${agent.name}`, err);
        });
      }
      return undefined;
    }

    if (onAdmitted) {
      await Promise.resolve(onAdmitted()).catch((err: unknown) => {
        console.error(`[orchestrator] onAdmitted callback failed for ${agent.name}`, err);
      });
    }

    try {
      const runId = newRunId(agent.name, now);
      const basePrompt = await readFile(agent.promptPath, "utf8");
      const prompt = [basePrompt, promptContext, workspaceNote(agent.workspace)]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      const result = await this.runAndRecord(agent, runId, { runId, workspace: agent.workspace, prompt });
      // Only a *trigger* feeds the breaker. A resume is a human deliberately
      // pushing an already-parked run forward, and Governor.admit already
      // skips the breaker check entirely for kind === "resume" — counting its
      // outcome here would let the operator's own intervention trip the very
      // switch that gates automatic runs.
      //
      // Read the prior state first so the trip can be announced exactly once,
      // as the event it is. Governor.admit's own refusal is deliberately
      // silent (alert: false): it fires on every subsequent dispatch, and with
      // a queue of pending tasks that turned one tripped breaker into an
      // endless stream of identical Discord messages describing a state
      // nobody had changed.
      const wasTripped = await this.breaker.isTripped(agent.name);
      const breakerState = await this.breaker.recordResult(agent.name, result.status);
      if (!wasTripped && breakerState.disabledAt) {
        await this.outbox
          .postAlert(
            agent.outbox.discord,
            `⛔ **${agent.name}** disabled: circuit breaker tripped after ${breakerState.consecutiveFailures} consecutive failures. ` +
              `No further runs will start until you clear it with \`!enable ${agent.name}\`.`,
          )
          .catch((err: unknown) => console.error(`[orchestrator] failed to announce breaker trip for ${agent.name}`, err));
      }
      return result;
    } finally {
      this.governor.releaseSlot();
    }
  }

  async resumeRun(
    entry: PendingEntry,
    decision: { approved: boolean } | { answer: string },
    agent: AgentDef,
  ): Promise<RunResult | undefined> {
    // An entry with no session id has nothing to resume. PendingStore records
    // an empty sessionId when the SDK stream ended before it ever carried a
    // session_id; passing that through would make SdkRunner drop the `resume`
    // option and start a *fresh, contextless* session whose only prompt is
    // "Approved. Continue." — and because runAndRecord reuses the original
    // runId, nothing afterwards would look wrong. Refuse it instead, in the
    // same shape as a governor refusal so the caller's existing
    // undefined-means-refused handling covers this too.
    if (!entry.sessionId) {
      console.error(
        `[orchestrator] cannot resume pending entry ${entry.id} (run ${entry.runId}, agent "${entry.agentName}"): ` +
          `it has no sessionId, so there is no session to continue. Resuming would silently start a new, contextless run`,
      );
      return undefined;
    }

    const admitted = await this.governor.admit(agent, "resume");
    if (admitted.kind === "refuse") {
      console.log(`[governor] refused resume of ${entry.runId}: ${admitted.reason}`);
      return undefined;
    }
    const prompt = "approved" in decision
      ? (decision.approved ? "Approved. Continue." : "Denied. Do not attempt that action; continue with anything else you can, or stop.")
      : decision.answer;

    // Persist the approval BEFORE reading the accumulated list back, so that
    // if THIS resume is itself an approval, the newly-approved grant is
    // included in what gets passed to the resumed run — not just what was
    // approved on previous resumes. This is what stops the park -> resume ->
    // retry -> park loop: the resumed agent can retry the same outward
    // effect and have canUseTool bypass the park path this time.
    if ("approved" in decision && decision.approved && entry.grantRef) {
      await this.approvedGrants.approve(entry.runId, entry.grantRef);
    }
    const approvedGrantRefs = await this.approvedGrants.read(entry.runId);

    try {
      return await this.runAndRecord(agent, entry.runId, {
        runId: entry.runId,
        workspace: agent.workspace,
        prompt,
        resume: entry.sessionId,
        approvedGrantRefs,
      });
    } finally {
      this.governor.releaseSlot();
    }
  }

  private async runAndRecord(agent: AgentDef, runId: string, ctx: RunContext): Promise<RunResult> {
    const writer = await this.store.open(runId, agent.name);

    await mkdir(agent.workspace, { recursive: true });

    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.round(agent.run.timeoutMinutes * 60_000));
    let status: RunStatus = "success";
    let error: string | undefined;

    const timer = setTimeout(() => {
      status = "timeout";
      controller.abort();
    }, timeoutMs);

    try {
      const stream = this.runner.execute(agent, ctx, controller.signal);
      for await (const event of stream) {
        await writer.append(event);
        // The same race the catch block below guards: once the timer has
        // fired, "timeout" is the truthful classification and must win. A
        // runner may still emit a terminal error event *caused by* the abort
        // (SdkRunner maps the last message it pulled so the run's cost
        // accounting is not lost) — that must not re-label the run "failed".
        if (event.type === "error" && (status as RunStatus) !== "timeout") {
          // A rate-limited run is the environment saying "not now", not the
          // agent failing at its task — so it is "interrupted", which
          // BreakerStore's FAILURE_STATUSES deliberately excludes. Recorded as
          // "failed" it took three limit hits to disable an agent that had
          // done nothing wrong, and every dispatch afterwards re-posted
          // "circuit breaker tripped" to Discord. Same reasoning as the
          // tool-failure stop in sdk-runner.ts.
          status = isRateLimitError(event.message) ? "interrupted" : "failed";
          error = event.message;
        }
        // Recorded and reported like any other outcome, but deliberately NOT
        // "failed": BreakerStore counts only failed/timeout, and a run stopped
        // because its tools were broken says nothing about the agent.
        if (event.type === "interrupted" && (status as RunStatus) !== "timeout") {
          status = "interrupted";
          error = event.reason;
        }
        if (event.type === "denied" && (status as RunStatus) !== "timeout") {
          status = "denied";
          error = event.reason;
        }
        if (event.type === "parked" && (status as RunStatus) !== "timeout") {
          status = event.kind === "question" ? "question" : "parked";
          // Announce it now. Before this hook existed, postApproval/postQuestion
          // were only ever called by boot reconciliation, so a run that parked
          // during live operation reached the operator no earlier than the next
          // process restart. Deliberately fire-and-report: a Discord outage must
          // never turn a parked run into a failed one.
          if (this.onParked) {
            try {
              await this.onParked(event.pendingId, event.kind);
            } catch (err) {
              console.error(
                `[orchestrator] failed to announce parked run ${runId} (pending ${event.pendingId})`,
                err,
              );
            }
          }
        }
        // Feed the governor's shared rate-limit snapshot live, from every
        // run's stream, not only the triggering agent's own admission check
        // — it's one subscription-wide limit (spec §4.5).
        // Both governor calls below are side-channel bookkeeping, and neither
        // may decide this run's outcome: they sit inside the same try as the
        // event loop, so a throw here lands in the catch and relabels an
        // already-classified run "failed". A rate-limited run classified as
        // "interrupted" two lines earlier became "failed" again for exactly
        // that reason, which then fed the agent's circuit breaker.
        if (event.type === "rate_limit_event") {
          await this.governor
            .recordRateLimit({
              status: event.status, rateLimitType: event.rateLimitType,
              utilization: event.utilization, resetsAt: event.resetsAt,
            })
            .catch((err: unknown) => console.error("[orchestrator] failed to record rate-limit snapshot", err));
        }
        if (event.type === "error" && isRateLimitError(event.message)) {
          await this.governor
            .recordRateLimitError()
            .catch((err: unknown) => console.error("[orchestrator] failed to record rate-limit backoff", err));
        }
      }
    } catch (thrown) {
      // `status` may already have been set to "timeout" by the setTimeout
      // callback above, racing this catch block. TypeScript's control-flow
      // narrowing cannot see across that closure boundary, so the comparison
      // is cast back to the full RunStatus union rather than left to be
      // (incorrectly) flagged as always-false.
      if ((status as RunStatus) !== "timeout") {
        status = "failed";
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      await writer.append({ type: "error", message: error ?? "aborted" });
    } finally {
      clearTimeout(timer);
    }

    if ((status as RunStatus) === "timeout") {
      error = `Run exceeded its ${agent.run.timeoutMinutes} minute limit and was aborted`;
    }

    let result = await writer.close({ status, summary: "", ...(error ? { error } : {}) });

    // Only a clean "success" is worth grading — every other status already
    // carries a more specific signal of its own (an error, a timeout reason,
    // a denial). Never allowed to fail the run itself: a grading call that
    // errors or hangs is a lost verdict, not a lost result.
    if (result.status === "success" && this.verifier) {
      try {
        const tail = await writer.tail(20);
        const verifiedOutcome = await this.verifier.verify({ prompt: ctx.prompt, summary: result.summary, tail });
        result = await this.store.recordVerification(runId, verifiedOutcome);
      } catch (err) {
        console.error(`[orchestrator] outcome verification failed for run ${runId}`, err);
      }
    }

    await this.report(agent, result, writer);
    return result;
  }

  private async report(
    agent: AgentDef,
    result: RunResult,
    writer: { tail(n: number): Promise<string[]> },
  ): Promise<void> {
    const category = result.status === "success" ? "success" : "failure";
    if (!agent.outbox.notifyOn.includes(category as "success" | "failure")) return;
    try {
      // A "not-achieved" verdict earns the same tail-fetch a real failure
      // gets — see formatRunMessage's showTail, which is what actually
      // decides whether to render it.
      const needsTail = result.status !== "success" || result.verifiedOutcome?.verdict === "not-achieved";
      const tail = needsTail ? await writer.tail(20) : undefined;
      await this.outbox.post(agent.outbox.discord, result, tail);
    } catch (thrown) {
      // The run is already durably recorded (result.json was written before
      // this call). A reporting failure must never make a completed run
      // look like a crash to the caller — log it and move on.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.error(
        `[orchestrator] failed to report run ${result.runId} for agent "${agent.name}": ${message}`,
      );
    }
  }
}
