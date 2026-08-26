import { ValidationError } from "../errors.js";

export type CredentialMode = "subscription" | "api-key";

/**
 * The only host variables copied into the agent process, plus the one
 * credential resolved below.
 *
 * This is an allowlist *because* a denylist cannot keep pace: the CLI the SDK
 * spawns independently honours a growing set of provider switches read from
 * its own process.env — CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX,
 * CLAUDE_CODE_USE_FOUNDRY, CLAUDE_CODE_USE_ANTHROPIC_AWS,
 * AWS_BEARER_TOKEN_BEDROCK, ANTHROPIC_FOUNDRY_API_KEY,
 * ANTHROPIC_FOUNDRY_AUTH_TOKEN, ANTHROPIC_AWS_API_KEY, ANTHROPIC_BASE_URL —
 * any one of which silently moves a run onto paid billing while this module
 * still reports mode "subscription". Copying the whole environment and
 * deleting the two names we happened to think of was a guarantee we could not
 * make.
 *
 * The second reason is blast radius: the supervisor's own environment holds
 * DISCORD_WEBHOOK_* (write access to the owner's Discord) and whatever else
 * lives in the shell profile. A listed tool is pre-approved, so an agent with
 * Bash has an unattended shell that can read `env`.
 *
 * `options.env` REPLACES the child's environment rather than extending it
 * (see the SDK's query() implementation), so this list must carry everything
 * a child process genuinely needs to start.
 *
 * On an SDK bump, re-check the SDK's own auth-variable list (grep the
 * installed @anthropic-ai/claude-agent-sdk bundle for ANTHROPIC_ and
 * CLAUDE_CODE_USE_) and widen the credential handling here if it has grown.
 */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
] as const;

/**
 * Windows environment variable names are case-insensitive in practice but
 * arrive with varied casing ("SystemRoot", "SYSTEMROOT", "Path"), so names are
 * matched case-insensitively and copied with the host's own casing intact.
 */
const ALLOWED_LOWERCASE: ReadonlySet<string> = new Set(
  CHILD_ENV_ALLOWLIST.map((name) => name.toLowerCase()),
);

function allowlistedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && ALLOWED_LOWERCASE.has(key.toLowerCase())) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

/**
 * Resolves the credential the agent process will use.
 *
 * Subscription authentication is the only supported default. An API key is
 * accepted solely when ALLOW_API_BILLING=true. Nothing else that could steer
 * billing is copied into the child environment at all — see the allowlist
 * above.
 *
 * Called at boot (so a missing credential fails startup rather than the first
 * cron fire) and again per run; it is cheap and idempotent. It throws
 * ValidationError so a credential problem formats like every other
 * configuration failure.
 */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): {
  mode: CredentialMode;
  childEnv: Record<string, string>;
} {
  const childEnv = allowlistedEnv(env);

  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauth;
    return { mode: "subscription", childEnv };
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    if (env.ALLOW_API_BILLING !== "true") {
      throw new ValidationError("Claude credentials (.env)", [
        "ANTHROPIC_API_KEY is set but CLAUDE_CODE_OAUTH_TOKEN is not. This platform " +
          "runs on a Claude subscription; using the key would bill the API instead. " +
          "Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or set " +
          "ALLOW_API_BILLING=true if API billing is genuinely intended.",
      ]);
    }
    childEnv.ANTHROPIC_API_KEY = apiKey;
    return { mode: "api-key", childEnv };
  }

  throw new ValidationError("Claude credentials (.env)", [
    "No Claude credential found. Run `claude setup-token` on a machine where you " +
      "are logged in, then set CLAUDE_CODE_OAUTH_TOKEN in .env",
  ]);
}
