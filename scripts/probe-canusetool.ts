import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../src/runner/credentials.js";

const { childEnv } = resolveCredentials();
let sawToolAttempt = false;
let sawAnythingAfterDenial = false;

for await (const message of query({
  prompt: "Run the Bash command `echo outward-effect-probe` right now.",
  options: {
    model: "claude-haiku-4-5",
    maxTurns: 5,
    allowedTools: ["Bash"],
    tools: ["Bash"],
    env: childEnv,
    permissionMode: "default",
    settingSources: [],
    canUseTool: async (toolName) => {
      sawToolAttempt = true;
      console.log(`canUseTool called for ${toolName} — denying with interrupt: true`);
      return { behavior: "deny", message: "probe: denying to test interrupt", interrupt: true };
    },
  },
})) {
  const record = message as Record<string, unknown>;
  if (sawToolAttempt) sawAnythingAfterDenial = true;
  console.log(record.type, "→", JSON.stringify(message).slice(0, 300));
}

console.log("\n--- probe result ---");
console.log("canUseTool was called:", sawToolAttempt);
console.log("stream continued after the deny (expected: minimal/none if interrupt works):", sawAnythingAfterDenial);
