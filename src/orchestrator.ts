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
  async executeRun(agent: AgentDef, now: Date = new Date(), promptContext?: string): Promise<RunResult | undefined> {
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

    try {
      const runId = newRunId(agent.name, now);
      const basePrompt = await readFile(agent.promptPath, "utf8");
      const prompt = promptContext ? `${basePrompt}\n\n${promptContext}` : basePrompt;
      const result = await this.runAndRecord(agent, runId, { runId, workspace: agent.workspace, prompt });
      // Only a *trigger* feeds the breaker. A resume is a human deliberately
      // pushing an already-parked run forward, and Governor.admit already
      // skips the breaker check entirely for kind === "resume" — counting its
      // outcome here would let the operator's own intervention trip the very
      // switch that gates automatic runs.
      await this.breaker.recordResult(agent.name, result.status);
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
          status = "failed";
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
        if (event.type === "rate_limit_event") {
          await this.governor.recordRateLimit({
            status: event.status, rateLimitType: event.rateLimitType,
            utilization: event.utilization, resetsAt: event.resetsAt,
          });
        }
        if (event.type === "error" && event.message.includes("rate_limit")) {
          await this.governor.recordRateLimitError();
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
