/**
 * The one substitution an agent's `prompt.md` may ask for.
 *
 * Why this exists: three scout prompts (cleanup-scout, improvement-scout,
 * dependency-scout) audit *this* repo, and each hardcoded `/app` — the path
 * the repo is mounted at inside the container by docker-compose.yml. Run the
 * supervisor outside that container (locally, which is how it runs now) and
 * `/app` does not exist, so every Read/Glob in those prompts failed. That
 * broke four consecutive cleanup-scout runs before one of them thought to
 * park and ask where the repo actually lives.
 *
 * A prompt cannot know that path — only the process can (`ROOT` in
 * src/index.ts, `APP_ROOT` or the working directory). So the prompt names the
 * placeholder and the orchestrator fills it in.
 *
 * Deliberately opt-in per prompt rather than appended to every prompt the way
 * `workspaceNote` is: `builder` and `repair` hold Write/Edit and are supposed
 * to work inside a *clone* in their workspace. Handing them the path of the
 * supervisor's own live checkout invites edits to it. They don't use the
 * placeholder, so they never receive it.
 */
export const KNOWN_PROMPT_PLACEHOLDERS = ["repoRoot"] as const;

export type PromptVars = { [K in (typeof KNOWN_PROMPT_PLACEHOLDERS)[number]]: string };

/** `{{name}}`, tolerating inner padding. Matches nothing in ordinary prose —
 *  a single brace, `{}`, or a JSON object literal all fail the doubled `{{`. */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Replaces every known placeholder with its value, and leaves everything else
 * — including an unknown placeholder — exactly as written. Unknown ones are
 * boot's problem, not render time's: see `unknownPlaceholders`.
 */
export function renderPrompt(text: string, vars: PromptVars): string {
  return text.replace(PLACEHOLDER, (whole, name: string) =>
    // A function replacer, NOT a string one: a replacement string expands
    // `$&`, `` $` ``, `$'` and `$1`, and these values are filesystem paths —
    // data, which must land verbatim.
    Object.hasOwn(vars, name) ? vars[name as keyof PromptVars] : whole,
  );
}

/**
 * Every placeholder in `text` that `renderPrompt` would pass through
 * untouched, deduplicated and in order of first appearance.
 *
 * Called by the registry at boot so a typo'd or stale placeholder is a
 * startup failure the operator sees immediately, rather than a literal
 * `{{appRoot}}` shipped to the model — which is the same silent-staleness
 * failure this whole mechanism replaces.
 */
export function unknownPlaceholders(text: string): string[] {
  const known = new Set<string>(KNOWN_PROMPT_PLACEHOLDERS);
  const found = new Set<string>();
  for (const [, name] of text.matchAll(PLACEHOLDER)) {
    if (!known.has(name!)) found.add(name!);
  }
  return [...found];
}
