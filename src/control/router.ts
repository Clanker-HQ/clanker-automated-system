import type { AgentDef } from "../registry.js";

export interface Specialist {
  name: string;
  description: string;
}

export function specialistsOf(agents: AgentDef[]): Specialist[] {
  return agents
    .filter((a) => a.enabled && a.trigger.type === "dispatched")
    .map((a) => ({ name: a.name, description: a.description }));
}

/** Decides which specialist agent (by name) should handle a task, or null if none fit. */
export interface Router {
  route(taskText: string, specialists: Specialist[]): Promise<string | null>;
}

/** Test double: a fixed answer or a computed one, with zero real LLM calls. */
export class FakeRouter implements Router {
  calls: { taskText: string; specialists: Specialist[] }[] = [];

  constructor(
    private readonly respond: string | null | ((taskText: string, specialists: Specialist[]) => string | null),
  ) {}

  async route(taskText: string, specialists: Specialist[]): Promise<string | null> {
    this.calls.push({ taskText, specialists });
    return typeof this.respond === "function" ? this.respond(taskText, specialists) : this.respond;
  }
}
