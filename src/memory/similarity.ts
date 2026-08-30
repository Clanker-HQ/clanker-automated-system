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
 * and character-trigram overlap (catches morphology — "developer" vs
 * "developers"). Neither alone is enough.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "of", "for", "in", "on", "at", "by", "with",
  "is", "are", "be", "it", "this", "that", "or", "as", "from", "into",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOP_WORDS.has(t)),
  );
}

function trigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    .join("")
    .replace(/[^a-z0-9]/g, "");
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

  const subjectScore = (jaccard(tokens(a.subject), tokens(b.subject)) + jaccard(trigrams(a.subject), trigrams(b.subject))) / 2;

  // If only one has a key, don't allow perfect match
  if ((a.key && !b.key) || (!a.key && b.key)) {
    return Math.min(subjectScore, 0.99);
  }

  return subjectScore;
}
