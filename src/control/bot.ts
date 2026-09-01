import { join } from "node:path";
import type { PendingEntry } from "./pending.js";
import type { PendingStore } from "./pending.js";
import type { AgentDef } from "../registry.js";
import { QuietHoursSchema } from "../config.js";
import type { ConfigOverridesStore } from "../config-overrides.js";
import { formatZodError } from "../errors.js";
import type { GovernorStatus } from "../governor.js";
import type { RunResult, RunStore } from "../run-store.js";
import type { BreakerStore } from "../state/breaker.js";
import { MAX_TASK_TEXT_LENGTH, type Task, type TaskStore } from "./task-store.js";

export interface IncomingMessage {
  channelId: string;
  authorId: string;
  content: string;
}

export interface BotTransport {
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  send(channelId: string, text: string): Promise<{ messageId: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Test double: records everything sent, and lets a test inject an incoming message without a real Discord connection. */
export class FakeBotTransport implements BotTransport {
  sent: { channelId: string; text: string }[] = [];
  /** Set by a test to make the next start() reject, simulating a failed Discord connection (bad token, network drop, outage). */
  startError: Error | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(channelId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ channelId, text });
    return { messageId: `fake-${this.sent.length}` };
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
  }
  async stop(): Promise<void> {}

  async simulateMessage(msg: IncomingMessage): Promise<void> {
    if (this.handler) await this.handler(msg);
  }
}

interface ResumeCapableOrchestrator {
  /** Resolves to `undefined` when the resume was refused and never ran (governor refusal, or a pending entry with no session to continue). */
  resumeRun(entry: PendingEntry, decision: { approved: boolean } | { answer: string }, agent: AgentDef): Promise<RunResult | undefined>;
}

interface WakeableDispatcher {
  wake(): Promise<void>;
}

interface StatusCapableGovernor {
  status(): Promise<GovernorStatus>;
  /** Immediately admits any runs already queued behind the old, lower limit — see Governor.adjustConcurrency. */
  adjustConcurrency(maxConcurrent: number): void;
}

const RESUME_REFUSED =
  "the pending entry is still open, so you can try again later.";

/**
 * `!tasks` only lists what's still active, so a finished task's completion
 * message in the channel is the only other record of it — easy to lose in
 * scrollback. `!result <id>` exists specifically to look one back up
 * regardless of status, so this shows the full picture, not a truncated one.
 */
function formatTaskDetail(task: Task): string {
  const lines = [`\`${task.id}\` — **${task.status}**`, `Request: ${task.text}`, `Requested by: ${task.createdBy}`, `Created: ${task.createdAt}`];
  switch (task.status) {
    case "done":
      lines.push(`Result: ${task.result?.summary ?? "(no summary recorded)"}`);
      break;
    case "failed":
      lines.push(`Failed: ${task.failureReason ?? "(no reason recorded)"}`);
      break;
    case "waiting":
      lines.push("Waiting on you to approve/deny/answer — check for an earlier prompt in this channel.");
      break;
    case "running":
      lines.push(`Still running (started ${task.startedAt ?? "?"}).`);
      break;
    case "pending":
      lines.push("Still queued.");
      break;
  }
  return lines.join("\n");
}

export class DiscordBot {
  private readonly transport: BotTransport;
  private readonly pending: PendingStore;
  private readonly orchestrator: ResumeCapableOrchestrator;
  private readonly agents: AgentDef[];
  private readonly channelFor: (agentName: string) => string;
  private readonly store: RunStore;
  private readonly overrides: ConfigOverridesStore;
  private readonly breaker: BreakerStore;
  private readonly dataDir: string;
  private readonly ownerId: string;
  private readonly tasks: TaskStore;
  private readonly dispatcher: WakeableDispatcher;
  private readonly governor: StatusCapableGovernor;
  /** Pending ids currently mid-resume, so a repeated `approve <id>` cannot start a second resume of the same entry while the first is still running. */
  private readonly resuming = new Set<string>();

  constructor(opts: {
    transport: BotTransport; pending: PendingStore; orchestrator: ResumeCapableOrchestrator;
    agents: AgentDef[]; channelFor: (agentName: string) => string;
    store: RunStore; overrides: ConfigOverridesStore; breaker: BreakerStore; dataDir: string;
    /** The one Discord user id allowed to approve/deny/answer or run any `!` admin command. */
    ownerId: string;
    tasks: TaskStore; dispatcher: WakeableDispatcher; governor: StatusCapableGovernor;
  }) {
    this.transport = opts.transport;
    this.pending = opts.pending;
    this.orchestrator = opts.orchestrator;
    this.agents = opts.agents;
    this.channelFor = opts.channelFor;
    this.store = opts.store;
    this.overrides = opts.overrides;
    this.breaker = opts.breaker;
    this.dataDir = opts.dataDir;
    this.ownerId = opts.ownerId;
    this.tasks = opts.tasks;
    this.governor = opts.governor;
    this.dispatcher = opts.dispatcher;
  }

  async postApproval(entry: PendingEntry): Promise<void> {
    await this.transport.send(
      this.channelFor(entry.agentName),
      `🔔 **${entry.agentName}** wants to: ${entry.effect}\nGrant: \`${entry.grantRef}\`\n\n` +
        `Approving allows the \`${entry.grantRef}\` grant for the rest of this run — not just this one call.\n\n` +
        `Reply \`approve ${entry.id}\` or \`deny ${entry.id}\`.`,
    );
  }

  async postQuestion(entry: PendingEntry): Promise<void> {
    await this.transport.send(
      this.channelFor(entry.agentName),
      `❓ **${entry.agentName}** asks: ${entry.question}\n\nReply \`answer ${entry.id} <your answer>\`.`,
    );
  }

  async start(): Promise<void> {
    this.transport.onMessage(async (msg) => {
      // The single authorization gate for the whole control surface. Every
      // admin command and — far more importantly — every approve/deny/answer
      // is the human decision the tier/grant system exists to require, so
      // anyone who can see the channel must not be able to supply it.
      // Deliberately silent: replying "unauthorized" would confirm to a prober
      // that they had reached the bot, and would let them binary-search for
      // the owner id. An unauthorized message is treated exactly like an
      // unrecognised one — nothing happens.
      if (msg.authorId !== this.ownerId) return;

      if (msg.content.startsWith("!")) return this.handleCommand(msg);

      const approve = msg.content.match(/^approve\s+(\S+)/i);
      const deny = msg.content.match(/^deny\s+(\S+)/i);
      const answer = msg.content.match(/^answer\s+(\S+)\s+([\s\S]+)/i);

      const id = approve?.[1] ?? deny?.[1] ?? answer?.[1];
      if (!id) return;

      const entry = await this.pending.get(id);
      if (!entry) return;

      // Guard against a command that doesn't match the entry's kind (e.g. "approve"
      // on a question entry, which has no grantRef/effect to approve). Not a crash
      // either way — Orchestrator.resumeRun only branches on "approved" in decision —
      // but resuming it would be semantically wrong, so we ignore the mismatched command.
      if ((approve || deny) && entry.kind !== "approval") return;
      if (answer && entry.kind !== "question") return;

      const agent = this.agents.find((a) => a.name === entry.agentName);
      if (!agent) return;

      // A resume can be refused (STOP file, quiet hours, daily budget, a
      // rate-limit rejection, or an entry with no session to continue), in
      // which case resumeRun returns undefined and nothing ran. Resolving the
      // entry *first* used to destroy it — sessionId and all — on exactly
      // those occasions, with no feedback to the operator. So: resume first,
      // resolve only once the resume was actually attempted, and say so in the
      // channel when it wasn't.
      //
      // Never let a failed resolve/resume become an unhandled rejection: a real
      // EventEmitter-based transport (Task 15) won't await this listener, so a
      // thrown/rejected promise here would otherwise risk crashing the process
      // and would definitely stop this handler from processing future messages.
      if (this.resuming.has(id)) return;
      this.resuming.add(id);
      try {
        let outcome: RunResult | undefined;
        if (approve) {
          outcome = await this.orchestrator.resumeRun(entry, { approved: true }, agent);
        } else if (deny) {
          outcome = await this.orchestrator.resumeRun(entry, { approved: false }, agent);
        } else if (answer) {
          outcome = await this.orchestrator.resumeRun(entry, { answer: answer[2]!.trim() }, agent);
        }

        if (outcome === undefined) {
          await this.transport.send(
            msg.channelId,
            `⚠️ Resume of \`${id}\` was refused — check the governor (quiet hours, daily budget, the STOP file, ` +
              `a rate-limit rejection) or the run's session id. Nothing ran and ${RESUME_REFUSED}`,
          );
          return;
        }

        await this.reconcileTaskForResumedRun(entry, outcome);
        await this.pending.resolve(id);
      } catch (error) {
        console.error(`[bot] failed to resolve/resume pending entry ${id}:`, error);
      } finally {
        this.resuming.delete(id);
      }
    });
    await this.transport.start();
  }

  /**
   * A parked/question run remembers which task it belongs to (Task.runId,
   * set by the dispatcher when it first marks the task "waiting"). Without
   * this, a task whose run gets approved/denied/answered to completion never
   * finds out — `!tasks`/`!result`/the digest would keep reporting it as
   * "waiting" forever, even though the run itself finished normally minutes
   * or hours later.
   *
   * Not every parked run came from a dispatched task — cron/webhook agents
   * park too — so finding no match here is the common, expected case, not
   * an error.
   *
   * An entry that instead expires and is auto-denied on restart never
   * reaches this method (it never goes through resumeRun at all) — see
   * failTasksForExpiredEntries below for that path.
   */
  private async reconcileTaskForResumedRun(entry: PendingEntry, result: RunResult): Promise<void> {
    const task = (await this.tasks.list()).find((t) => t.status === "waiting" && t.runId === entry.runId);
    if (!task) return;

    if (result.status === "success") {
      await this.tasks.update(task.id, {
        status: "done",
        finishedAt: new Date().toISOString(),
        result: { summary: result.summary, path: join(this.dataDir, "runs", result.runId) },
      });
      await this.transport.send(this.channelFor(entry.agentName), `✅ Task \`${task.id}\` done: ${result.summary}`);
    } else if (result.status === "parked" || result.status === "question") {
      // Parked again (a second approval needed further into the same
      // resumed session) — still waiting on the same runId, nothing to update.
    } else {
      const reason = result.error ?? `run ended with status "${result.status}"`;
      await this.tasks.update(task.id, { status: "failed", finishedAt: new Date().toISOString(), failureReason: reason });
      await this.transport.send(this.channelFor(entry.agentName), `❌ Task \`${task.id}\` failed: ${reason}`);
    }
  }

  /**
   * The counterpart to reconcileTaskForResumedRun for entries that never get
   * resumed at all: `PendingStore.reconcile` (called from boot-wiring at
   * startup) auto-denies any approval/question older than
   * `governor.pendingTimeoutHours` by simply deleting its pending-store
   * entry — it never calls resumeRun, so a dispatched task waiting on that
   * run's id would otherwise stay "waiting" in `!tasks`/`!result`/the digest
   * forever, even though nothing is ever coming for it. Called unconditionally
   * from boot-wiring, independent of whether the Discord connection itself
   * succeeds — the task record's correctness doesn't depend on that.
   *
   * Same caveat as reconcileTaskForResumedRun: not every parked run belongs
   * to a dispatched task, so finding no match is the common, expected case.
   */
  async failTasksForExpiredEntries(expired: readonly PendingEntry[]): Promise<{ entry: PendingEntry; task: Task }[]> {
    if (expired.length === 0) return [];
    const all = await this.tasks.list();
    const failed: { entry: PendingEntry; task: Task }[] = [];
    for (const entry of expired) {
      const task = all.find((t) => t.status === "waiting" && t.runId === entry.runId);
      if (!task) continue;
      const reason = `the pending ${entry.kind} request timed out with no response and was auto-denied at restart`;
      const updated = await this.tasks.update(task.id, { status: "failed", finishedAt: new Date().toISOString(), failureReason: reason });
      failed.push({ entry, task: updated });
    }
    return failed;
  }

  /** Best-effort notification for failTasksForExpiredEntries' result — split out because it needs a live Discord connection, unlike the task update itself. */
  async notifyExpiredTaskFailures(failed: readonly { entry: PendingEntry; task: Task }[]): Promise<void> {
    for (const { entry, task } of failed) {
      await this.transport.send(this.channelFor(entry.agentName), `❌ Task \`${task.id}\` failed: ${task.failureReason}`);
    }
  }

  /** Shared by `!result`/`!retry`/`!cancel`: resolves the short id `!tasks` shows (or a full id) to exactly one task. */
  private async resolveTaskByPrefix(prefix: string): Promise<{ task: Task } | { error: string }> {
    const matches = await this.tasks.findByPrefix(prefix);
    if (matches.length === 0) return { error: `No task found starting with \`${prefix}\`.` };
    if (matches.length > 1) {
      const ids = matches.map((t) => t.id.slice(0, 8)).join(", ");
      return { error: `\`${prefix}\` matches ${matches.length} tasks — be more specific: ${ids}` };
    }
    return { task: matches[0]! };
  }

  private async handleCommand(msg: IncomingMessage): Promise<void> {
    const [command, ...rest] = msg.content.trim().split(/\s+/);
    const arg = rest.join(" ");
    const reply = (text: string) => this.transport.send(msg.channelId, text);

    switch (command) {
      case "!stop": {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(this.dataDir, "STOP"), "");
        return void reply("🛑 STOP file set. No new runs until `!resume`.");
      }
      case "!resume": {
        const { rmSync } = await import("node:fs");
        rmSync(join(this.dataDir, "STOP"), { force: true });
        return void reply("▶️ STOP file cleared. Runs resume on the next trigger.");
      }
      case "!disable": {
        if (!arg.trim()) return void reply("Usage: `!disable <agent-name>`");
        // Unlike !enable below, there's no legitimate reason to disable a name
        // that matches no loaded agent — it can only be a typo, and writing it
        // anyway would silently do nothing while replying as if it worked.
        if (!this.agents.some((a) => a.name === arg)) {
          const known = this.agents.map((a) => a.name).join(", ") || "(none loaded)";
          return void reply(`No agent named "${arg}" is loaded — nothing disabled. Known agents: ${known}`);
        }
        const overrides = await this.overrides.read();
        const disabled = new Set(overrides.disabledAgents ?? []);
        disabled.add(arg);
        await this.overrides.set("disabledAgents", [...disabled], "discord");
        return void reply(`⏸️ ${arg} disabled.`);
      }
      case "!enable": {
        if (!arg.trim()) return void reply("Usage: `!enable <agent-name>`");
        const overrides = await this.overrides.read();
        const disabled = new Set(overrides.disabledAgents ?? []);
        disabled.delete(arg);
        await this.overrides.set("disabledAgents", [...disabled], "discord");
        await this.breaker.reset(arg);
        // Still applied even for an unknown name (harmless, and the only way
        // to clear a stale disabledAgents entry left by an agent that was
        // since removed from config) — just flagged, rather than replying as
        // if a currently-loaded agent was actually re-enabled.
        if (!this.agents.some((a) => a.name === arg)) {
          return void reply(`▶️ ${arg} enabled — but no agent by that name is currently loaded, so this only cleared a stale override, if any.`);
        }
        return void reply(`▶️ ${arg} enabled.`);
      }
      case "!budget": {
        const value = Number(arg);
        if (!Number.isFinite(value) || value <= 0) return void reply(`Not a valid budget: "${arg}"`);
        await this.overrides.set("dailyBudgetUsd", value, "discord");
        return void reply(`💰 Daily budget set to $${value}.`);
      }
      case "!concurrency": {
        const value = Number(arg);
        if (!Number.isInteger(value) || value <= 0) return void reply(`Not a valid concurrency: "${arg}"`);
        await this.overrides.set("maxConcurrent", value, "discord");
        this.governor.adjustConcurrency(value);
        return void reply(`🔀 Concurrency set to ${value}.`);
      }
      case "!quiet": {
        if (arg === "off") {
          await this.overrides.set("quietHours", null, "discord");
          return void reply("🔕 Quiet hours disabled.");
        }
        const match = arg.match(/^(\d\d:\d\d)-(\d\d:\d\d)\s+(\S+)$/);
        if (!match) return void reply('Usage: `!quiet HH:MM-HH:MM Area/City` or `!quiet off`');
        // The regex above only proves the *shape*: it accepts "99:99" and any
        // non-whitespace string as a timezone. An unusable timezone written
        // into the overrides makes Governor.admit's Intl.DateTimeFormat throw
        // a RangeError on every admission check, for every agent, until
        // someone hand-edits the file — so it is validated against the very
        // same schema config.yaml's own governor.quietHours must satisfy.
        const parsed = QuietHoursSchema.safeParse({ from: match[1]!, to: match[2]!, timezone: match[3]! });
        if (!parsed.success) {
          const problems = formatZodError("!quiet", parsed.error).lines.join("\n• ");
          return void reply(`❌ Quiet hours not changed:\n• ${problems}`);
        }
        await this.overrides.set("quietHours", parsed.data, "discord");
        return void reply(`🌙 Quiet hours set to ${parsed.data.from}-${parsed.data.to} ${parsed.data.timezone}.`);
      }
      case "!breaker": {
        if (arg === "off") {
          await this.overrides.set("breakerEnabled", false, "discord");
          return void reply("🔓 Circuit breaker disabled — repeated failures no longer auto-refuse a trigger.");
        }
        if (arg === "on") {
          await this.overrides.set("breakerEnabled", true, "discord");
          return void reply("🔒 Circuit breaker re-enabled.");
        }
        return void reply("Usage: `!breaker off` or `!breaker on`");
      }
      case "!runs": {
        const recent = await this.store.listRecent(20);
        const lines = recent.map((r) => {
          const verdict = r.verifiedOutcome && r.verifiedOutcome.verdict !== "achieved" ? ` — ⚠️ ${r.verifiedOutcome.verdict}` : "";
          return `${r.runId} — ${r.status} — $${r.costUsd.toFixed(4)}${verdict}`;
        });
        return void reply(lines.length > 0 ? lines.join("\n") : "No runs yet.");
      }
      case "!task": {
        // Deliberately NOT the shared `arg`: that comes from split(/\s+/) +
        // join(" "), which collapses runs of whitespace and destroys newlines —
        // fine for `!budget 25`, destructive for a multi-line free-form request.
        const raw = msg.content.trim().slice(command.length).trim();
        // `-d` and `-p <n>` are leading flags, not part of the request: each is
        // stripped only when followed by whitespace or end-of-string, in
        // either order, so a real request that happens to start with a word
        // like "-detailed" is left as literal text (matches the pre-existing
        // `-d` behavior this generalizes).
        let text = raw;
        let wantsDetail = false;
        let priority: number | undefined;
        for (;;) {
          if (!wantsDetail && /^-d(?:\s+|$)/.test(text)) {
            wantsDetail = true;
            text = text.replace(/^-d(?:\s+|$)/, "");
            continue;
          }
          const priorityMatch = priority === undefined ? text.match(/^-p\s+(\d+)(?:\s+|$)/) : null;
          if (priorityMatch) {
            priority = Number(priorityMatch[1]);
            text = text.slice(priorityMatch[0].length);
            continue;
          }
          break;
        }
        text = text.trim();
        if (!text) return void reply("Usage: `!task [-d] [-p <n>] <free-form request>`");
        if (text.length > MAX_TASK_TEXT_LENGTH) {
          return void reply(`Task text is ${text.length} characters, over the ${MAX_TASK_TEXT_LENGTH}-character limit — trim it and try again.`);
        }
        const task = await this.tasks.create({
          text,
          createdBy: `discord:${msg.authorId}`,
          ...(wantsDetail ? { wantsDetail: true } : {}),
          ...(priority !== undefined ? { priority } : {}),
        });
        void this.dispatcher.wake().catch((err: unknown) => {
          console.error(`[bot] dispatcher wake failed after !task ${task.id}:`, err);
        });
        return void reply(`📋 Task \`${task.id}\` queued.`);
      }
      case "!result": {
        const prefix = arg.trim();
        if (!prefix) return void reply("Usage: `!result <task-id-or-prefix>` (the short id `!tasks` shows works)");
        const resolved = await this.resolveTaskByPrefix(prefix);
        if ("error" in resolved) return void reply(resolved.error);
        return void reply(formatTaskDetail(resolved.task));
      }
      case "!retry": {
        const prefix = arg.trim();
        if (!prefix) return void reply("Usage: `!retry <task-id-or-prefix>`");
        const resolved = await this.resolveTaskByPrefix(prefix);
        if ("error" in resolved) return void reply(resolved.error);
        const { task } = resolved;
        if (task.status !== "failed") {
          return void reply(`Task \`${task.id.slice(0, 8)}\` is ${task.status}, not failed — nothing to retry.`);
        }
        // specialistAgent is deliberately kept: the earlier routing decision
        // still stands, same as a dispatcher-deferred retry — only a task that
        // was never routed pays for another router call. retryCount is reset:
        // a manual retry is a fresh, deliberate attempt, and should get its
        // own silent auto-retry if this next run also fails transiently.
        await this.tasks.update(task.id, {
          status: "pending", failureReason: undefined, finishedAt: undefined, startedAt: undefined, retryCount: undefined,
          nextRetryAt: undefined,
        });
        void this.dispatcher.wake().catch((err: unknown) => {
          console.error(`[bot] dispatcher wake failed after !retry ${task.id}:`, err);
        });
        return void reply(`🔁 Task \`${task.id.slice(0, 8)}\` requeued.`);
      }
      case "!cancel": {
        const prefix = arg.trim();
        if (!prefix) return void reply("Usage: `!cancel <task-id-or-prefix>`");
        const resolved = await this.resolveTaskByPrefix(prefix);
        if ("error" in resolved) return void reply(resolved.error);
        const { task } = resolved;
        // Only "pending": a running task has no cancellation hook today, and
        // silently discarding the record of a finished/waiting one would be
        // surprising rather than useful.
        if (task.status !== "pending") {
          return void reply(`Task \`${task.id.slice(0, 8)}\` is ${task.status}, not pending — can't cancel it.`);
        }
        await this.tasks.remove(task.id);
        return void reply(`🗑️ Task \`${task.id.slice(0, 8)}\` canceled.`);
      }
      case "!status": {
        const status = await this.governor.status();
        const active = await this.tasks.list();
        const counts = { pending: 0, running: 0, waiting: 0 };
        for (const t of active) {
          if (t.status === "pending" || t.status === "running" || t.status === "waiting") counts[t.status]++;
        }
        const lines = [
          status.stopped ? "🛑 STOPPED — no new runs or resumes until `!resume`" : "▶️ running",
          `Budget: $${status.spentTodayUsd.toFixed(2)} of $${status.dailyBudgetUsd} spent today`,
          `Concurrency: ${status.maxConcurrent}`,
          status.quietHours
            ? `Quiet hours: ${status.quietHours.from}-${status.quietHours.to} ${status.quietHours.timezone}${status.quietHoursActive ? " (active now)" : ""}`
            : "Quiet hours: off",
          `Circuit breaker: ${status.breakerEnabled ? "on" : "off"}`,
          `Disabled agents: ${status.disabledAgents.length > 0 ? status.disabledAgents.join(", ") : "none"}`,
          status.rateLimitUtilization === null
            ? "Rate limit: no reading yet"
            : `Rate limit: ${(status.rateLimitUtilization * 100).toFixed(0)}% of window (pauses at ${(status.rateLimitPauseThreshold * 100).toFixed(0)}%)`,
          `Tasks: ${counts.pending} pending, ${counts.running} running, ${counts.waiting} waiting`,
        ];
        return void reply(lines.join("\n"));
      }
      case "!tasks": {
        const all = await this.tasks.list();
        const active = all
          // "waiting" belongs here too: it is a live run paused on a human
          // approve/deny/answer, so it is exactly what the owner needs to see.
          .filter((t) => t.status === "pending" || t.status === "running" || t.status === "waiting")
          .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
        const lines = active.map((t) => {
          const text = t.text.length > 60 ? `${t.text.slice(0, 57)}...` : t.text;
          return `${t.id.slice(0, 8)} — ${t.status} — ${text}`;
        });
        return void reply(lines.length > 0 ? lines.join("\n") : "No pending, running, or waiting tasks.");
      }
      default:
        return void reply(`Unknown command: ${command}`);
    }
  }
}
