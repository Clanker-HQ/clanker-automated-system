export type CredentialMode = "subscription" | "api-key";

/**
 * Resolves the credential the agent process will use.
 *
 * Subscription authentication is the only supported default. An API key is
 * accepted solely when ALLOW_API_BILLING=true, and in subscription mode the
 * key is actively stripped from the child environment so a stray variable can
 * never silently move spending onto API billing.
 */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): {
  mode: CredentialMode;
  childEnv: Record<string, string>;
} {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }

  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    return { mode: "subscription", childEnv };
  }

  if (env.ANTHROPIC_API_KEY) {
    if (env.ALLOW_API_BILLING !== "true") {
      throw new Error(
        "ANTHROPIC_API_KEY is set but CLAUDE_CODE_OAUTH_TOKEN is not. This platform " +
          "runs on a Claude subscription; using the key would bill the API instead. " +
          "Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or set " +
          "ALLOW_API_BILLING=true if API billing is genuinely intended.",
      );
    }
    return { mode: "api-key", childEnv };
  }

  throw new Error(
    "No Claude credential found. Run `claude setup-token` on a machine where you " +
      "are logged in, then set CLAUDE_CODE_OAUTH_TOKEN in .env",
  );
}
