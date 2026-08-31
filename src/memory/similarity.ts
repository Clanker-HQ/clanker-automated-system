export interface Comparable {
  subject: string;
  key?: string;
}

/**
 * Deliberately lexical, not embedding-based. This system runs on a Claude
 * subscription with no API billing, and Anthropic serves no embeddings
 * endpoint — an embedding provider would mean a new credential and new
 * billing, and a local model would mean RAM this box is preserving for other
 * things. Accuracy ceiling accepted in exchange; see the spec's Risks.
 *
 * Two signals, averaged: token-set Jaccard (catches reordering and filler)
 * and character-trigram overlap (catches morphology). Both drop stop words
 * before comparing — including inside the trigram text, not just the token
 * list, since a shared filler word ("the") otherwise shifts every trigram
 * after it and drags the score down for no semantic reason. Tokens
 * additionally strip one trailing "s": a cheap, dependency-free stand-in for
 * stemming (this system takes no new dependencies) that's enough to treat
 * "platform"/"platforms" or "developer"/"developers" as the same word.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "of", "for", "in", "on", "at", "by", "with",
  "is", "are", "be", "it", "this", "that", "or", "as", "from", "into",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/** Strips one trailing "s" — length > 1 so a lone "s" token is never reduced to "". */
function singularize(word: string): string {
  return word.length > 1 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function tokens(text: string): Set<string> {
  return new Set(words(text).map(singularize));
}

function trigrams(text: string): Set<string> {
  const normalized = words(text).join("");
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) grams.add(normalized.slice(i, i + 3));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function similarity(a: Comparable, b: Comparable): number {
  if (a.key && b.key && a.key.toLowerCase() === b.key.toLowerCase()) return 1;
  return (jaccard(tokens(a.subject), tokens(b.subject)) + jaccard(trigrams(a.subject), trigrams(b.subject))) / 2;
}
