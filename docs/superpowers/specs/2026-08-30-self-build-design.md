# Self-build flow — design

Status: partially shipped. `improvement-scout`'s redundancy-awareness fix
(see "`improvement-scout` prompt change" below) landed 2026-08-30, ahead of
and independent from the rest of this spec. The merge gate itself — the part
that actually lets a config-only PR merge — is not yet implemented; that's
the remaining work. See `docs/decisions.md` for why `grants.yaml`/`agents/**`
were excluded from the normal PR pipeline in the first place; this spec is
the "own deploy/approval path" `docs/system-context.md` flagged as the
missing piece.

## Problem

`touchesExcludedPath` (`src/control/excluded-paths.ts`) permanently blocks any
PR touching `grants.yaml` or anything under `agents/` from merging through
`builder` → `pr-reviewer` → `mergePR`, unconditionally. That's correct for the
governance/safety-rail files also on that list, but it means there is
currently no automated way for this system to grow its own agent roster or
capability grants at all — every one has to be hand-authored by a human
outside the pipeline. This spec adds a narrow, separate path for exactly the
`grants.yaml` + `agents/**` case, while leaving the governance/safety-rail
group permanently excluded, same as today, no exceptions.

## Non-goals / what stays excluded, unconditionally

`config.yaml` (Governor's own caps — budget, concurrency, quiet hours) and the
existing "pipeline's own safety rails" group (`excluded-paths.ts`,
`sdk-runner.ts`, `git-pusher.ts`, `webhook-*.ts`, `credentials.ts`,
`index.ts`, `.github/workflows/ci.yml`, `bot.ts`, `governor.ts`,
`agent-schema.ts`, `grants.ts`) are **not** touched by this feature and remain
refused exactly as `touchesExcludedPath` already refuses them. A pipeline
able to widen its own budget/concurrency ceiling, or edit the code that
enforces any of this, has the same "no gates" problem `EXCLUDED_PATHS` exists
to prevent — nothing here changes that.

## Who proposes, who builds

No new agent. This reuses the existing propose/build split exactly as it
already works for ordinary code changes:

- **`improvement-scout`** proposes — unchanged mechanics (still reads source
  and docs, still queues via `queueTask`), but with one addition to what it's
  told to read (see below), so it knows what already exists before proposing
  something that duplicates it.
- **`builder`** builds — entirely unchanged. It already has unrestricted
  `Read`/`Write`/`Edit` (nothing in this codebase path-restricts local file
  edits, only outward effects like push/merge are gated), and its prompt
  already anticipates being asked to design a new agent's config. The
  dispatcher's existing LLM router (`deps.router.route`, matched against each
  dispatched specialist's `description`) already sends a task like "add a
  grants.yaml entry for X" to `builder`, same as it would any other code-change
  task — no routing change needed.

### `improvement-scout` prompt change — shipped 2026-08-30

Done ahead of the rest of this spec: redundancy-awareness is useful on its
own, independent of whether a config proposal can actually merge yet.
`agents/improvement-scout/prompt.md`'s "What to read" list (previously
`src/`, `README.md`, `CONFIGURING.md`, `docs/decisions.md`,
`docs/system-context.md` — nothing that said what agents/grants *currently
exist*; `decisions.md` only covers what's been rejected, `system-context.md`'s
"possible future additions" is explicitly what's *not* built, and README's
roster description is hand-written prose that can drift stale) now also
includes:

- `/app/agents/*/agent.yaml` — every existing agent's `name`, `description`,
  `tier`, `grantRefs`. This is the same structured source of truth the
  dispatcher's own router reads, always in sync by construction (unlike
  prose).
- `/app/grants.yaml` — the current grant list.
- An explicit instruction: before proposing a new agent or a new grant, check
  whether an existing one's description/scope already covers it. Prefer
  proposing an extension to an existing specialist over a new one, unless the
  work is a genuinely distinct concern.

The same instruction was also added to `docs/system-context.md` itself (a new
"Before proposing or designing something new" section, right before
"Possible future additions") — broader than originally scoped here, since
that doc is read by any agent doing architecture-touching work, not just
`improvement-scout`, and by whoever picks up this spec's remaining work next.

## The merge gate

Folded into the **existing** `mergePR` tool's existing gate 1
(`src/runner/sdk-runner.ts`), not a separate bypass path. `pr-reviewer`
remains the single entry point for every PR, config-only ones included — it
still reviews for sense, redundancy, and quality (one of its four review
angles is already "does the diff do what it claims"), and still decides
whether to call `mergePR` at all. What changes is what gate 1 does once
called:

- **Today**: `touchesExcludedPath(changedFiles)` → refuse, unconditionally,
  for anything in `EXCLUDED_PATHS`/`EXCLUDED_PREFIXES`.
- **New**: if every changed file is `grants.yaml` exactly, or matches
  `^agents/[^/]+/(agent\.yaml|prompt\.md)$` (one path segment for the agent
  name — no nested directories, no other filenames), run the deterministic
  rules below instead of refusing outright. Anything else
  (including a PR that mixes an allowlisted file with anything outside it)
  still refuses exactly as today — self-build changes must be pure, never
  bundled with an ordinary code change.

Two gates now compose: `pr-reviewer`'s LLM judgment decides *whether* to call
`mergePR` (redundancy/sense — the thing that would have caught this design's
own earlier mistake, an agent that duplicated `builder`'s existing role); the
mechanical rules decide whether that call actually *succeeds* (the security
floor). Neither can override the other.

### The four rules (`src/control/self-build-gate.ts`, pure function, no LLM)

Given the PR's base-ref state (the current live registry — fetched fresh from
GitHub, not trusted from in-process memory, which could be stale relative to
the latest merge) and the changed files' head-ref content:

1. **Schema-valid**: every new `agent.yaml` still validates against
   `AgentSchema`, the new `grants.yaml` still validates against `GrantSchema`,
   and `validateGrantRefs` still passes across the resulting full agent set.
   Reuses `parseAgent`/`parseGrants`/`validateGrantRefs` as-is.
2. **No existing grant edited in place**: for every grant `id` present in
   both base and new `grants.yaml`, the two must be structurally identical.
   Self-build may only add a new grant `id` or delete an old one, never
   modify one's fields. (Sidesteps having to prove a glob got "narrower" —
   simpler and stricter to just forbid in-place edits entirely.)
3. **Credential scope** — *amended 2026-08-30, see
   `2026-08-30-self-evaluation-design.md`.* This rule originally read "no
   free ride to autonomous+auto": a new (agent, grantRef) pairing at
   `autonomous`+`auto` required some other agent to already hold that same
   grantRef at that tier, making any brand-new grant inert until a human
   attached it directly. That was wrong — it capped the system's growth on a
   recurring human step, which is exactly the pattern `CLAUDE.md` rejects.

   The bound is the **credential**, not the grant entry. A grant whose
   `secret:` env var is unset is already inert (today's `BUILDER_PUSH_TOKEN`),
   and a fine-grained PAT cannot exceed its own real-world scope however many
   grants reference it. So a self-authored grant is admissible if either:

   - **(a)** its `secret:` names an env var **already provisioned and already
     in use** by a live grant — bounded thereafter by that credential's own
     scope; or
   - **(b)** it carries no real credential (a synthetic capability grant, as
     `web-read` is today) **and** is no broader than an existing grant of the
     same `kind` — same or narrower `urlPattern` / `remote` / `scope`.

   Both are mechanical checks against base-ref state, in the same pure
   function. The only act left to a human is registering an account with a
   brand-new external service — a physical bootstrap, not an approval.
4. **CI green** — unchanged, existing branch-protection/CI gate, not new code.

On refusal, `mergePR`'s handler returns the specific rule that failed, same
style as its existing refusal messages — `pr-reviewer` posts it as a comment
and stops, same as today.

### New `GithubTransport` methods

Needed to fetch the base-ref registry state fresh (not from process memory):

- `getFileContent(repo, ref, path): Promise<string | null>` — null if absent
  at that ref (new file, or deleted).
- `listRepoFiles(repo, ref, pathPrefix): Promise<string[]>` — file paths
  under a prefix at a given ref (via the Git Trees API), used to enumerate
  `agents/*/agent.yaml` at the base ref for rule 3's "does some other agent
  already hold this."

Both are internal to the merge-gate wiring, not exposed as agent-callable MCP
tools — no agent's own capability surface grows.

## Testing

- `self-build-gate.test.ts` — each rule, positive and negative, pure data in
  (no GitHub/LLM mocking needed): schema-invalid new agent; an edited existing
  grant (refuse); a new grant on an already-provisioned, already-in-use secret
  (allow); a new grant naming an unprovisioned secret (refuse); a synthetic
  grant narrower than an existing same-kind grant (allow); a synthetic grant
  broader than any existing same-kind grant (refuse); an unrelated field edit
  on an existing agent (allow).
- `sdk-runner.test.ts` (`mergePR` gate 1) — extend existing tests: a
  config-only PR that passes the gate merges; one that fails posts the
  specific refusal; a mixed config+code PR still refuses exactly as
  `touchesExcludedPath` does today.
- `improvement-scout` prompt change needs no test (prompts aren't unit
  tested elsewhere in this repo either) but should be smoke-checked by
  reading its rendered prompt includes the new reading list.

## Documentation

`README.md`'s "Not built yet" bullet on this and `docs/system-context.md`'s
"possible future additions" entry both get rewritten to describe this as
shipped once the merge gate lands, mirroring how the outcome-verification and
retry features were documented after landing. (`system-context.md`'s new
"Before proposing or designing something new" section, added as part of the
`improvement-scout` fix above, is unrelated to that flip and stays either
way — it's not conditional on the rest of this spec shipping.)
