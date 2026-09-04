import type { MemoryConfig } from "../config.js";
import { MAX_TASK_TEXT_LENGTH, type Task, type TaskStore } from "../control/task-store.js";
import { specialistsOf, type Router } from "../control/router.js";
import type { AgentDef } from "../registry.js";
import type { MemoryStore } from "./memory-store.js";
import { assessNovelty } from "./novelty-gate.js";
import { priorityScore, toPriority } from "./scoring.js";

export interface SuccessorSuggestion {
  text: string;
  domain: string;
  subject: string;
  importance: number;
  goalAlignment: number;
}

export type SuccessorSuggester = (summary: string) => Promise<SuccessorSuggestion[]>;

export interface SuccessorInput {
  parentTask: Task;
  summary: string;
  parentDepth: number;
  agentName: string;
  tasks: TaskStore;
  memory: MemoryStore;
  config: MemoryConfig;
  suggest: SuccessorSuggester;
  now: Date;
  /**
   * Optional, and required together (same posture as queueTask's own
   * preflight in sdk-runner.ts): without both, behaviour is unchanged from
   * before this check existed. With both, a suggestion nothing can execute
   * is skipped rather than created — this is the one path that creates tasks
   * without going through queueTask's MCP tool at all, so it needs its own
   * copy of the same preflight rather than inheriting the fix for free.
   */
  router?: Router;
  agents?: AgentDef[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUCCESSORS = 3;

/**
 * Turns a finished run into the next piece of work — the edge that makes this
 * a loop rather than a queue. Three independent mechanical bounds, because
 * this is the one place the system can generate work for itself without limit:
 *
 *  1. depth — a successor chain stops at config.maxChainDepth.
 *  2. breadth — at most MAX_SUCCESSORS per completed task.
 *  3. rate — a rolling-day ceiling across ALL agent-originated tasks, which
 *     catches a wide shallow fan-out that no per-chain cap would.
 *
 * The Governor's daily budget remains the final backstop underneath all three.
 * Never throws: a successor pass failing must not disturb the parent task,
 * which has already succeeded.
 */
export async function proposeSuccessors(input: SuccessorInput): Promise<string[]> {
  if (!input.config.enabled) return [];
  if (input.parentDepth >= input.config.maxChainDepth) return [];

  try {
    const since = input.now.getTime() - DAY_MS;
    const todaysAgentTasks = (await input.tasks.list()).filter(
      (t) => t.createdBy.startsWith("agent:") && new Date(t.createdAt).getTime() >= since,
    ).length;
    if (todaysAgentTasks >= input.config.maxAgentTasksPerDay) return [];

    const suggestions = (await input.suggest(input.summary)).slice(0, MAX_SUCCESSORS);
    const records = await input.memory.list();
    const created: string[] = [];

    for (const suggestion of suggestions) {
      if (todaysAgentTasks + created.length >= input.config.maxAgentTasksPerDay) break;

      const verdict = assessNovelty(
        { domain: suggestion.domain, subject: suggestion.subject },
        records,
        { threshold: input.config.similarityThreshold, stalenessDays: input.config.stalenessDays, now: input.now },
      );
      if (verdict.kind === "suppressed") continue;

      let specialistAgent: string | undefined;
      if (input.router && input.agents) {
        const chosenName = await input.router.route(suggestion.text, specialistsOf(input.agents));
        if (!chosenName) continue;
        specialistAgent = chosenName;
      }

      const priority = toPriority(
        priorityScore(
          {
            goalAlignment: suggestion.goalAlignment,
            maxSimilarity: verdict.maxSimilarity,
            importance: suggestion.importance,
            proposedAt: input.now.toISOString(),
          },
          input.config.weights,
          input.now,
        ),
      );

      const task = await input.tasks.create({
        // The same bound every other free-form task creator respects: a
        // suggestion comes straight from a model with nothing capping its
        // length, and it would otherwise go into a run's prompt unbounded.
        text: suggestion.text.slice(0, MAX_TASK_TEXT_LENGTH),
        priority,
        createdBy: `agent:${input.agentName}`,
        parentId: input.parentTask.id,
        wantsDetail: true,
        specialistAgent,
      });
      await input.memory.append({
        domain: suggestion.domain,
        kind: "proposal",
        subject: suggestion.subject,
        body: suggestion.text,
        importance: suggestion.importance,
        createdBy: `agent:${input.agentName}`,
        sourceTaskId: task.id,
        chainDepth: input.parentDepth + 1,
      });
      created.push(task.id);
    }
    return created;
  } catch (error) {
    console.error("[successor] pass failed; parent task is unaffected", error);
    return [];
  }
}
