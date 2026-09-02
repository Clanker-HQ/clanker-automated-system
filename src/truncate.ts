/**
 * Shortens a value that gets injected into agent prompts.
 *
 * The world model and the memory log are both bounded by *construction* —
 * one entry per finding, `limit` memory records — but that bounds the COUNT
 * of entries, not the SIZE of each. A finding's conclusion is free prose, so
 * without a cap here a handful of verbose entries become a permanent per-turn
 * tax: the digest goes into every dispatched task and every cron run, and
 * every turn of a run resends the whole conversation, so one long conclusion
 * is paid for again on every turn of every run for as long as it exists.
 *
 * Truncation is safe because it is only ever applied to the injected digest.
 * The full text always remains in its source file.
 */
export function truncateForPrompt(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;

  const cut = collapsed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  // Prefer a word boundary, but not one so early that most of the budget is
  // thrown away — a single very long token would otherwise reduce the whole
  // entry to its first word.
  const body = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
