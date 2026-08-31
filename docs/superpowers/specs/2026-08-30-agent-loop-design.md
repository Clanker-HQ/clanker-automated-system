# The agent loop: memory, novelty, and outcome-driven task creation — design

Subsystem 1 of 2. Subsystem 2 (`2026-08-30-self-evaluation-design.md`)
depends on the memory log this spec introduces and should be built after
this one has produced roughly a month of real data.

## Problem

The system today has two of the three chains a continuous autonomous agent
loop needs:

- **Creation** — four cron scouts + `!task` queue work.
- **Execution** — `builder` / `research` / `pr-reviewer` run it through the
  Governor.

It is missing the third, **prioritization**, and it is missing the edge that
makes the loop a loop: *nothing connects a finished result back to task
creation*. Three concrete consequences:

1. **No arbitration.** When `research` returns three equally plausible
   prospects, nothing chooses. The report posts to Discord and dies there.
   Priority is a static integer (50 for human-queued, 30 for agent-queued),
   so two agent proposals are always exactly equally urgent.
2. **No memory across runs.** Every scout starts from a blank page on every
   cron tick. Nothing tells `research` it investigated a topic three weeks
   ago, or `improvement-scout` that it already proposed a fix twice. The
   `improvement-scout` prompt change shipped 2026-08-30 partly mitigates this
   for *config* proposals by having it read the live registry, but that only
   covers "does this thing exist now," not "have we tried this before."
3. **No follow-through.** A completed run produces no successor work, so the
   system can execute a thread but never pursue one.

## Non-goals

**No agent hierarchy.** The original framing of this work was a
CEO-agent-over-manager-agents-over-workers org chart. Rejected, on evidence:

- Anthropic's own multi-agent research system is an ephemeral fan-out over a
  *single* incoming query, not a governor of a standing fleet — and its
  writeup explicitly scopes cross-subagent arbitration as out of bounds
  ("if two subagents need to coordinate on a finding mid-search, this
  architecture can't help them").
- The 2026 supervisor-pattern surveys report its costs as 3-10x tokens,
  orchestrator context overflow past ~4 workers, and hallucination cascade
  where downstream agents treat upstream output as ground truth.
- Production agent fleets (Cognition/Devin) parallelize execution against an
  externally-defined backlog. None use an autonomous manager agent to decide
  what is worth working on.

The closest architectural precedent to this system's actual shape is the
BabyAGI create → execute → store → create-from-results → prioritize loop.
What is missing here is a **loop edge and a ranking function**, not a
management layer. A manager agent would also blur into the Governor's job:
"may this run" (deterministic, safety-critical) and "what matters most"
(fuzzy, strategic) are different questions and should stay in different
mechanisms.

**No skill library** (Voyager-style stored reusable procedures). Real
technique, but there is no demonstrated case of repeated procedure across 7
agents yet. Revisit only if subsystem 2's metrics show it — and note that
when they do, the system can propose and build it without a human, which is
the point.

## The memory log

Append-only JSONL at `data/memory/log.jsonl`, matching the existing
`transcript.jsonl` precedent (written as events arrive, survives a crash).

```json
{
  "id": "mem_20260830T120000Z_a3f2",
  "ts": "2026-08-30T12:00:00Z",
  "domain": "research",
  "kind": "finding",
  "subject": "canonical one-line description, used for similarity",
  "key": "optional natural key (npm package, file path, repo)",
  "body": "the substance",
  "importance": 7,
  "createdBy": "agent:research",
  "sourceRunId": "...",
  "sourceTaskId": "...",
  "verdict": "achieved",
  "chainDepth": 0
}
```

`kind` is one of `finding` | `proposal` | `outcome` | `reflection`.
`importance` is self-assessed 1-10 at write time (the Generative Agents
approach) and means *importance toward the goal*, not intrinsic interest.
`domain` partitions the log so a similarity check never compares an npm
advisory against a revenue prospect.

### Write path

Per the memory literature's stated failure mode — memory accumulating
indefinitely with no freshness policy until it is actively misleading — and
the specific finding in *"Useful Memories Become Faulty When Continuously
Updated by LLMs"*:

- **Append-only. No LLM ever rewrites a record in place.** Consolidation
  produces *derived views* under `data/memory/derived/`, recomputed from raw,
  never destructive.
- Writes are cheap and synchronous (one JSON line); any consolidation runs
  asynchronously in the reflection pass, never inline in an agent's turn.
- Pruning extends the existing weekly `retention` job: raw records older than
  `retention.days`, except `kind: reflection` (already compressed — kept for
  a longer, separately configured window) and any record referenced by a task
  that is not yet terminal.

### Similarity without embeddings

**This system authenticates with a Claude subscription and never API
billing.** Anthropic serves no embeddings endpoint, so cosine-similarity over
embeddings would require either a third-party API (new credential, new grant,
new billing — against the grain of the whole project) or a local embedding
model in the container (RAM/CPU headroom that `docs/system-context.md`
explicitly wants to preserve for a possible future browser capability).

So similarity is **lexical and deterministic**, in `src/memory/similarity.ts`
as a pure function:

- exact match on `key` when the domain has a natural key → similarity 1.0
- otherwise normalized token-set Jaccard plus character-trigram overlap over
  a canonicalized `subject` (lowercased, stop-words dropped, numbers and
  dates normalized)
- optional cheap-LLM tiebreak over only the top-N candidates, reusing the
  existing router's call pattern — never in the safety path, only to refine
  an already-narrow candidate list

Pure, unit-testable with plain data, no new dependency, no new credential.

## Two scoring functions (and the sign flip between them)

Generative Agents scores memory retrieval as
`recency + importance + relevance`. That is correct for *retrieval* but
inverted for *prioritization*, and conflating the two is the easy mistake
here:

**Retrieval** — "what should this agent know before it starts?" Similarity to
the current subject is a **positive** term. Top-K records get injected into
the agent's prompt.

```
retrievalScore = w_sim·similarity + w_rec·recencyDecay(ts) + w_imp·importance
```

**Prioritization** — "which pending proposal runs next?" Similarity to
already-completed work is a **penalty**; novelty is what we want. And the
dominant term is alignment with the goal in `goals.yaml` (subsystem 2):

```
priorityScore = w_goal·goalAlignment
              + w_nov·(1 − maxSimilarityToCompleted)
              + w_imp·importance
              + w_rec·recencyDecay(proposedAt)
```

`goalAlignment` is the proposal's own stated contribution to the primary
goal, and it carries the largest weight — novelty and recency break ties
between comparably goal-aligned candidates, they do not outvote the goal. A
proposal serving only the instrumental secondary goal, with no stated revenue
thesis, is scored down mechanically (see subsystem 2's `instrumental: true`).

Mapped onto the existing 0-100 priority integer, **clamped to 0..49**, so the
existing invariant holds unchanged: agent-originated work never queues ahead
of something a human asked for. Weights live in `config.yaml` and are
system-tunable.

Until `goals.yaml` exists, `goalAlignment` is a constant and the function
degrades cleanly to novelty/importance/recency — so subsystem 1 ships and is
useful standalone.

### The novelty gate

Before a proposal is queued at all:

- `maxSimilarity > threshold` against a **fresh** record with
  `verdict: achieved` → **suppressed**. Not silently: it is logged as a
  suppressed duplicate and counted, so subsystem 2 can measure the
  suppression rate.
- Similar but the prior record is **stale**, or its verdict was
  `not-achieved`/`unclear` → **allowed**, with the prior attempt and its
  failure reason annotated onto the new task, so the retry is informed rather
  than blind.

This is the mechanism that answers "stop researching the same thing a
hundred times," and it is a pure function over the log, not an agent's
judgment.

## The outcome → creation edge

After `OutcomeVerifier` grades a successful run, a **successor pass** (one
cheap call, same shape as the existing LLM router) proposes 0-3 successor
tasks from the result. This is what makes "research returned three prospects"
resolve: the top-scored prospect becomes the next queued task, and the other
two persist in the log as ranked-but-not-chosen — neither lost nor
re-researched from scratch.

Runaway containment, all mechanical:

- **Depth cap.** Tasks carry `chainDepth`; a successor inherits `depth + 1`;
  at the configured cap (default 3) no successors are proposed at all.
- **Novelty gate**, same as any other proposal.
- **Daily cap** on agent-originated tasks, in `config.yaml`, independent of
  depth — a broad shallow fan-out hits a ceiling too.
- **Governor's daily budget** remains the final backstop, unchanged.

## The reflection pass

Weekly cron, cheap model, reads the log + run outcomes + task records for the
window, writes `kind: reflection` records back into the log. Output is
domain-level conclusions: *"cleanup-scout's tasks graded not-achieved 40% of
the time," "this research direction has produced three dead ends," "builder
PRs in this area keep getting bounced by pr-reviewer."*

Consumed by: the scouts' prompts (injected as context), the `importance`
prior in scoring, and the daily digest.

Reflections are appended, never rewritten — a newer reflection supersedes an
older one by recency, and the old one stays readable.

This is the function the original "manager agent" idea was reaching for —
cross-cutting judgment about what the system should focus on — implemented as
a periodic batch job whose output is *advisory data* other components read,
rather than a standing authority every task routes through. Same benefit,
none of the latency, token multiplication, or ambiguity of authority.

## Integration points

| Component | Change |
|---|---|
| `src/control/dispatcher.ts` | writes `outcome` records; runs the successor pass; applies the novelty gate at queue time |
| `queueTask` MCP tool | applies the novelty gate and the computed priority |
| `src/retention.ts` | prunes raw memory; preserves reflections and referenced records |
| `src/digest.ts` | reports novelty/suppression counts and the latest reflections |
| scout prompts | receive retrieved top-K context |
| `config.yaml` | scoring weights, thresholds, depth cap, daily cap, reflection window |

## Testing

Pure-function unit tests with plain data (no LLM or GitHub mocking) for:
similarity (exact key, near-duplicate, unrelated), both scoring functions,
the 0..49 clamp, the novelty gate's four cases (fresh+achieved → suppress;
stale → allow annotated; not-achieved → allow annotated; below threshold →
allow clean), and the depth cap at boundary.

Integration: a completed run appends exactly one `outcome` record; a
successor at depth cap proposes none; retention preserves a reflection and a
referenced record while pruning an unreferenced stale one.

## Risks

- **Lexical similarity is weaker than embeddings.** Two differently-worded
  descriptions of the same work will slip through as novel. Mitigated by
  domain partitioning, natural keys where available, and the optional LLM
  tiebreak — but this is a real accuracy ceiling, accepted deliberately in
  exchange for no new credential and no new dependency.
- **Successor pass can amplify a bad result.** A wrong finding produces
  successors built on it — the hallucination-cascade failure mode. The depth
  cap bounds it; `OutcomeVerifier` grades each link independently; nothing
  fully prevents it.
- **Importance is self-assessed**, so an agent can inflate its own work's
  priority. Bounded by the 0..49 clamp and by novelty carrying independent
  weight.
