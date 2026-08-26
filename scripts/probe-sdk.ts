import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../src/runner/credentials.js";

const { mode, childEnv } = resolveCredentials();
console.log(`credential mode: ${mode}\n`);

for await (const message of query({
  prompt: "Reply with exactly the word: ready",
  options: {
    model: "claude-haiku-4-5",
    maxTurns: 1,
    allowedTools: [],
    env: childEnv,
    permissionMode: "default",
    settingSources: [],
  },
})) {
  const record = message as Record<string, unknown>;
  console.log(record.type, "→", Object.keys(record).join(", "));
  console.log(JSON.stringify(message).slice(0, 400));
  console.log("---");
}
