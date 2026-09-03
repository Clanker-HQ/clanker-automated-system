import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { truncateForPrompt } from "../truncate.js";

/**
 * Findings carry free prose, and this digest is injected into every dispatched
 * task and every cron run. `summaryForPrompt`'s "bounded by construction"
 * property bounds how MANY findings there are, not how long each one is — see
 * truncateForPrompt. The overseer holds `Read` and can open the full file when
 * a conclusion actually matters.
 */
const MAX_CONCLUSION_CHARS = 200;

export interface PortfolioEntry {
  slug: string;
  purpose: string;
  status: "building" | "live" | "paused" | "killed";
  /** ISO date. The next time this must justify itself — see Task C5. */
  nextReviewAt: string;
  /** What it must show by nextReviewAt to survive. Prose, graded by a human-readable bar. */
  bar: string;
  monthlyCostUsd: number;
  /** Leading indicators, newest last, e.g. "2026-09-01: 3 signups". */
  notes: string[];
  /**
   * How many times a review has extended this entry instead of killing it —
   * see MAX_EXTENSIONS and canExtend in reviews.ts. Entries persisted before
   * this field existed read back `undefined` here, not 0; callers that care
   * about the cap must treat the two the same rather than trusting the type.
   */
  extensionCount: number;
}

export interface ShelfItem {
  summary: string;
  shelvedAt: string;
  reason: string;
  /** What would make this worth reconsidering. Empty string means "nothing — this is dead". */
  revisitWhen: string;
}

export interface Finding {
  topic: string;
  conclusion: string;
  confidence: "low" | "medium" | "high";
  updatedAt: string;
  sources: string[];
}

/** Matches a `## <heading>` section holding one fenced ```json block, as written by renderSection. */
const SECTION_RE = /^## .+\n+```json\n([\s\S]*?)\n```\s*$/gm;

function renderSection(heading: string, value: unknown): string {
  return `## ${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** A section that fails to parse is logged and skipped — one corrupt entry must never make the whole document unreadable. */
function parseSections<T>(text: string, label: string): T[] {
  const out: T[] = [];
  for (const match of text.matchAll(SECTION_RE)) {
    try {
      out.push(JSON.parse(match[1] as string) as T);
    } catch (error) {
      console.error(`[world-model] skipping unparseable ${label} section`, error);
    }
  }
  return out;
}

/** The fenced block under the "## Current conclusion" heading — always the first section in a findings file. */
const CURRENT_FINDING_RE = /^## Current conclusion\n+```json\n([\s\S]*?)\n```/m;

function parseCurrentFinding(text: string): Finding | null {
  const match = CURRENT_FINDING_RE.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[1] as string) as Finding;
  } catch (error) {
    console.error("[world-model] skipping unparseable finding conclusion", error);
    return null;
  }
}

/** A filesystem-safe basename for a topic's findings file — arbitrary topic text must never escape the findings directory. */
function slugify(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/**
 * The shared substrate agents read before working and write after — it
 * answers "what is true right now", which a similarity search over the
 * memory log (src/memory/) structurally cannot, because current state is the
 * accumulation and resolution of many records.
 *
 * Bounded by construction, not by summarisation: each document's current
 * state has a shape whose size tracks the number of real things it
 * describes. portfolio.md replaces a product's section in place on every
 * review rather than appending, so reviewing it forever does not grow the
 * file. Findings keep one current conclusion with history appended below,
 * read only on demand. src/memory/reflection.ts already found that
 * LLM-rewritten memory degrades over successive rewrites — periodic
 * re-summarising is deliberately not how this stays bounded.
 */
export class WorldModel {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "world");
  }

  private portfolioPath(): string {
    return join(this.dir(), "portfolio.md");
  }

  private shelfPath(): string {
    return join(this.dir(), "shelf.md");
  }

  private findingsDir(): string {
    return join(this.dir(), "findings");
  }

  private findingPath(topic: string): string {
    return join(this.findingsDir(), `${slugify(topic)}.md`);
  }

  /** A missing file reads as an empty portfolio, never throws — match MetricsStore.listAll's posture. */
  async readPortfolio(): Promise<PortfolioEntry[]> {
    const text = await readFile(this.portfolioPath(), "utf8").catch(() => "");
    return parseSections<PortfolioEntry>(text, "portfolio");
  }

  /** Replaces the section with the same slug in place; appends when the slug is new. */
  async upsertPortfolioEntry(entry: PortfolioEntry): Promise<void> {
    const entries = await this.readPortfolio();
    const index = entries.findIndex((e) => e.slug === entry.slug);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;

    const text = entries.map((e) => renderSection(e.slug, e)).join("\n\n") + "\n";
    await mkdir(this.dir(), { recursive: true });
    await writeFileAtomic(this.portfolioPath(), text);
  }

  /** A missing file reads as an empty shelf, never throws. */
  async readShelf(): Promise<ShelfItem[]> {
    const text = await readFile(this.shelfPath(), "utf8").catch(() => "");
    return parseSections<ShelfItem>(text, "shelf");
  }

  /** Always appends — the shelf has no identity to replace by, only a growing record of what was set aside. */
  async addShelfItem(item: ShelfItem): Promise<void> {
    const items = await this.readShelf();
    items.push(item);
    const text = items.map((i) => renderSection(`shelved ${i.shelvedAt}: ${i.summary}`, i)).join("\n\n") + "\n";
    await mkdir(this.dir(), { recursive: true });
    await writeFileAtomic(this.shelfPath(), text);
  }

  /** null for an unknown topic, or when the file exists but its conclusion fails to parse. */
  async readFinding(topic: string): Promise<Finding | null> {
    const text = await readFile(this.findingPath(topic), "utf8").catch(() => "");
    return parseCurrentFinding(text);
  }

  /**
   * Replaces the current conclusion and pushes the superseded one into
   * History rather than discarding it — the difference between "we rejected
   * this" and "we rejected this, but the world has changed" only survives if
   * the old reasoning stays legible.
   */
  async writeFinding(topic: string, finding: Finding): Promise<void> {
    const path = this.findingPath(topic);
    const existingText = await readFile(path, "utf8").catch(() => "");
    const previous = parseCurrentFinding(existingText);

    const historyHeadingIndex = existingText.indexOf("## History");
    const existingHistoryBody = historyHeadingIndex === -1 ? "" : existingText.slice(historyHeadingIndex + "## History".length).trim();

    const entries = [previous ? renderSection(`superseded ${previous.updatedAt}`, previous) : null, existingHistoryBody || null].filter(
      (s): s is string => s !== null,
    );

    let text = renderSection("Current conclusion", finding);
    if (entries.length > 0) text += `\n\n## History\n\n${entries.join("\n\n")}`;
    text += "\n";

    await mkdir(this.findingsDir(), { recursive: true });
    await writeFileAtomic(path, text);
  }

  /**
   * The bounded digest injected into agent prompts — every portfolio entry's
   * slug and status, every shelf item's summary, and each finding's current
   * conclusion. Deliberately excludes finding history: history is read only
   * on demand, not carried into every dispatched task's context.
   */
  async summaryForPrompt(): Promise<string> {
    const [portfolio, shelf] = await Promise.all([this.readPortfolio(), this.readShelf()]);
    const topics = await this.listFindingTopics();
    const findings = (await Promise.all(topics.map((topic) => this.readFinding(topic)))).filter((f): f is Finding => f !== null);

    const lines: string[] = [];

    lines.push("## Portfolio");
    lines.push(portfolio.length > 0 ? portfolio.map((e) => `- ${e.slug} (${e.status})`).join("\n") : "- (none)");

    lines.push("");
    lines.push("## Shelf");
    lines.push(shelf.length > 0 ? shelf.map((s) => `- ${s.summary}`).join("\n") : "- (none)");

    lines.push("");
    lines.push("## Findings");
    if (findings.length > 0) {
      // One note for the whole section rather than a marker per line: this
      // text is itself paid for on every turn of every run.
      lines.push("(conclusions abbreviated — full text in data/world/findings/)");
      lines.push(
        findings
          .map((f) => `- ${f.topic} (confidence: ${f.confidence}): ${truncateForPrompt(f.conclusion, MAX_CONCLUSION_CHARS)}`)
          .join("\n"),
      );
    } else {
      lines.push("- (none)");
    }

    return lines.join("\n");
  }

  /** Every finding's full current conclusion — unlike summaryForPrompt's digest, nothing here is truncated. */
  async listFindings(): Promise<Finding[]> {
    const topics = await this.listFindingTopics();
    const findings = await Promise.all(topics.map((topic) => this.readFinding(topic)));
    return findings.filter((f): f is Finding => f !== null);
  }

  private async listFindingTopics(): Promise<string[]> {
    const names = await readdir(this.findingsDir()).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -".md".length));
  }
}
