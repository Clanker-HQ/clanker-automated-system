# PR Review-and-Merge Gate — Design

**Date:** 2026-08-27
**Status:** Draft, pending review
**Scope:** Sub-project 2a of the roadmap — the safe merge gate for agent-authored
(or human-authored) code changes. Deliberately does NOT cover how a change gets
proposed in the first place (that's a separate, later sub-project — "2b", the
autonomous code-proposing agent). This design treats "a PR exists, opened by
whoever/whatever" as a given input.
**Builds on:** [`2026-08-26-plan-b-governance-design.md`](2026-08-26-plan-b-governance-design.md)
— reuses the Governor, tier/grant enforcement, and the agent/trigger model
verbatim rather than inventing a parallel mechanism.

---

## 1. Purpose

Tonight's session repeatedly found real Critical bugs only through multi-pass,
adversarial, human-directed review — and every merge to `main` happened because
a human said so. This system has no equivalent yet: nothing stops a change from
landing except a human personally reading it. The owner has been explicit: they
do not want to be that human, ever, for the general case — but they also want
this built "in the safest way possible" given that constraint.

**Success criteria:**
1. A PR that doesn't break tests, isn't caught by adversarial review, and
   doesn't touch a fixed set of security-sensitive files merges with zero
   human involvement.
2. A PR that touches a security-sensitive file **cannot** merge through this
   pipeline, ever, regardless of what any review concludes — not "parked for
   approval," structurally excluded.
3. The exclusion in (2) is enforced by two independent mechanisms, so a bug in
   one doesn't remove the guarantee.
4. The reviewer runs under the exact same governance (budget, concurrency,
   quiet hours, circuit breaker) as every other agent in this system — nothing
   about "it's the reviewer" gives it a bigger blast radius if it misbehaves.
5. The whole pipeline is testable without a real GitHub repo or real PRs.

**Explicit non-goals for this design:**
- How a PR comes to exist (sub-project 2b, later).
- A sandboxed/isolated execution environment for running a PR's code — the
  owner chose the simpler, higher-risk option (§6) with eyes open; revisiting
  this is possible later but is not part of this design.
- Anything beyond the one repo family this bot identity manages today.

---

## 2. Operating model

Same two-plane split as the parent design: agent definitions and grants are
control-plane (git, human-merged), runs and their output are data-plane. This
adds a **third path onto the control plane** — not a new plane, a new *route*
onto the existing one: PRs merged by this pipeline update `main` the same way
a human `git merge` does today. Everything downstream (the supervisor only
running from `main`, agent definitions validated at boot, grants loaded
separately) is unchanged and still holds.

```
PR opened/synchronized on GitHub
  → GitHub Actions runs npm test + typecheck (a workflow this design adds —
    no CI exists yet, since no GitHub repo exists yet either)
      → red: nothing else happens; PR sits there, visibly broken
      → green: GitHub fires a webhook
  → Webhook receiver (new) verifies GitHub's signature, resolves the event to
    a "webhook"-triggered run of the pr-reviewer agent — governed by the same
    Governor as every other agent (budget, concurrency, quiet hours, breaker)
  → Mechanical check: does the diff touch any file in the excluded-path set?
      → yes: hard stop. Comment posted explaining why. Never merges through
        this pipeline, no matter what a review would have concluded.
      → no: continue
  → Heavy multi-pass adversarial review runs, including actually executing the
    PR's code (§6)
      → Critical/Important finding survives adversarial verification: PR
        stays open, comments posted, nothing merges
      → clean: merge, after re-checking the PR's head SHA hasn't moved since
        review started
```

---

## 3. The privilege boundary, extended

The parent design's three locks (Lock 1: server only runs `main`; Lock 2:
grants aren't agent-authorable; Lock 3: secrets never enter a workspace) all
still hold and are not weakened by this design. This adds a fourth,
specific to this pipeline:

**Lock 4 — the pipeline cannot touch its own safety rails.** A fixed set of
files defines the rules that constrain every agent in this system:
`src/governor.ts`, `src/grants.ts`, `src/agent-schema.ts`, the Discord bot's
owner-authorization check (`src/control/bot.ts`), `grants.yaml`, and
`config.yaml`'s governance section. A PR touching any of these is refused by
this pipeline categorically — not reviewed, not parked, not merged under any
verdict. This is deliberately *not* "ask a human" — the owner does not want
to review code, so the safety here comes from removing the *capability*, not
from a decision point. Changes to that code happen the way tonight's did:
directly, by a human (or a human-directed session), on their own schedule,
outside this pipeline entirely.

**Enforced by two independent mechanisms:**

1. **Our own pipeline code.** Before the reviewer agent is ever invoked, a
   static path-list check runs against the PR's changed files
   (`git diff --name-only` against the merge base). Any overlap with the
   excluded-path set → hard stop, before any LLM sees the diff.
2. **GitHub's own access control**, independent of anything this codebase
   does. A `CODEOWNERS` file marks the excluded paths as requiring review
   from an account other than the bot; branch protection on `main` requires
   that review before merge; the bot's own GitHub permissions are configured
   so it cannot bypass branch protection. Even a bug in mechanism 1 — a
   missed path, a logic error — does not remove this guarantee, because it
   does not depend on our code being correct.

**Consequence:** the worst outcome of a bug, a compromised PR, or a
misbehaving future proposer (sub-project 2b) touching the excluded paths is:
the PR sits open, unmerged, with an explanation. Not an incident.

---

## 4. New components

### 4.1 Webhook receiver

This system has never had inbound HTTP before — today it only makes outbound
calls and holds an outbound Discord gateway connection. This is new
infrastructure: a small HTTP server, run alongside the existing supervisor,
that:

- Verifies GitHub's webhook signature (HMAC, shared secret set when the
  webhook is configured) before trusting anything in the payload. An
  unverified endpoint would let anyone who found the URL forge a "PR opened"
  event and trigger a run.
- Filters to the events this system cares about (PR opened/synchronized,
  the CI check-suite completing) and ignores everything else.
- On a relevant, verified event, triggers a run of the matching `webhook`-type
  agent the same way `src/triggers/cron.ts` triggers a `cron`-type agent
  today — through `Governor.admit()`, same as any other run.

**Reachability:** no public IP exists yet. For now, a tunnel (ngrok) exposes
the receiver; `config.yaml`'s existing quiet-hours comments already anticipate
a future VPS as the real production home, and this receiver moves there the
same way the rest of the system will, with no design change required — the
webhook receiver doesn't care whether the tunnel or a real public address
delivers the request.

### 4.2 New trigger type: `webhook`

`src/agent-schema.ts`'s `trigger` field currently only accepts
`{ type: "cron", schedule, timezone }`. This adds a sibling variant,
`{ type: "webhook", ... }` (exact shape — which repo/event it binds to — is an
implementation-plan detail, not a design-level one). Same validation
philosophy as `cron`: rejected at boot if malformed, no silent no-ops.

### 4.3 The reviewer is just another agent

`agents/pr-reviewer/` (or similar), with `tier: autonomous` and
`approval: auto` — meaning `decide()` (already built, unmodified) resolves its
merge action to `allow` automatically once it matches a grant, exactly the
same mechanism that already exists for any other autonomous+auto agent. No
special-cased "the reviewer is different" logic anywhere in the governor or
grant code — it's governed identically to `smoke` or any future agent: same
daily budget, same concurrency pool (multiple PRs landing at once queue for a
slot, same as any other simultaneous runs), same quiet hours, and — usefully
— the same circuit breaker. Three failed review runs in a row trips it, and
it stops running automatically until `!enable`, the same recovery path any
other agent already has. A systematically broken pipeline stops hammering
PRs instead of silently misbehaving forever.

### 4.4 New grant kind: `github-pr`

Parallel to the existing `HttpGrant`/`GitPushGrant`/`ProvisionGrant` shapes in
`src/grants.ts`. Covers the whole cohesive "handle this PR" workflow — reading
the diff, posting review comments, merging — as one grant, since none of
those individual actions should ever need approval per §3's decision. Scoped
to the **set** of repos this bot identity manages (not hardcoded to one repo):
the owner expects this GitHub identity to eventually cover multiple projects,
so the grant (and the underlying fine-grained PAT) names a list of repos,
extended as new projects come under management — never "all repos,"
never unbounded.

---

## 5. The review pipeline

Mirrors the pattern that actually caught real bugs building this system
tonight — parallel angles, then adversarial verification, then a clear,
logged decision — not a single pass producing one verdict.

```
PR diff + description + (§6) actual execution of the PR's code
  → Parallel review lenses: correctness/bugs, security, code quality/
    simplification, spec-intent (does the diff match what the PR claims?)
  → Each finding adversarially verified — a separate pass trying to REFUTE
    it, not confirm it
  → Calibrated Critical / Important / Minor, same bar used all night:
    Critical or Important (post-verification) → blocks merge.
    Minor → posted as a PR comment, does not block.
  → Synthesis: MERGE or DON'T-MERGE, with the reasoning logged — a rejected
    PR says why, not just "no"
```

---

## 6. Execution model — chosen risk, stated plainly

The reviewer **runs the PR's code directly**, in the same environment and
with the same credentials it already holds (including the merge-capable
GitHub token) — not in a separate, isolated, credential-free sandbox.

**Why this matters, and was chosen anyway:** everywhere else in this system,
`canUseTool` mediates each individual action an agent's own reasoning decides
to take. That mechanism does **not** extend inside an already-permitted
subprocess — once the reviewer runs `npm test` (or anything) against a PR
branch, whatever that subprocess does (a malicious test file, a poisoned
`package.json` script) is invisible to and unmediated by the grant system.
Concretely: a hostile or buggy PR's code, executing in the reviewer's own
environment, could in principle read and exfiltrate the reviewer's own
GitHub token.

**Bound on the resulting risk:** a stolen token is still *the bot's own
GitHub identity* as far as GitHub's access control is concerned — Lock 4's
Wall 2 (CODEOWNERS + branch protection) restricts by *who* is merging, not
which credential string authenticated as them, so it holds even against a
stolen token. The worst case of this chosen risk is therefore bounded to:
**an attacker who can get a hostile PR opened against a managed repo can get
it merged without passing review — but still cannot touch the excluded
security-sensitive paths.** This is a real, accepted risk, not a
theoretical one; it was explained plainly and the simpler option was chosen
over a safer, more complex sandboxed alternative.

**Two cheap mitigations included regardless**, since they cost little and
reduce how bad this can get without changing the architecture:
1. The GitHub token is scoped as narrowly as GitHub's fine-grained PATs
   allow: only the managed repo set, only PR read/write and merge
   permissions — nothing broader that a theft would also hand over.
2. Network access is disabled specifically during the step where the PR's
   code actually executes, even though the rest of the reviewer's
   environment isn't otherwise sandboxed. Most exfiltration needs the
   network to send anything anywhere; cutting it off during execution closes
   the most likely path for close to no engineering cost.

---

## 7. Merge mechanics

Squash merge by default (clean history for what will likely be many small,
automated changes — revisitable). Before calling the merge API, the pipeline
re-reads the PR's current head commit SHA and compares it to the SHA that was
actually reviewed; a mismatch (a new commit landed mid-review) aborts the
merge rather than merging something nobody reviewed. The new commit gets its
own fresh review from its own `synchronize` webhook event.

---

## 8. Error handling

Designed to fail safe throughout, matching the rest of this system's posture:

- CI never goes green → no webhook ever fires → nothing happens. The PR is
  visibly broken on GitHub; no separate failure path needed.
- The reviewer agent errors or crashes mid-run → recorded as a failed run
  like any other agent failure; the circuit breaker counts it; nothing
  merges, since merging only happens on an explicit clean synthesis verdict.
- A new commit lands while a review is in flight → handled mechanically by
  the SHA check in §7, not by any judgment call.
- GitHub API failures / rate limits → treated as an ordinary failed run,
  naturally retried on the next relevant webhook event (e.g. another push).

---

## 9. Testing

- **`FakeGithubTransport`**, mirroring `FakeBotTransport`'s existing pattern
  in `src/control/bot.ts` — simulates webhook events and PR diffs so the
  whole pipeline is unit/integration-testable with zero real GitHub calls
  and zero cost, the same "test the whole pipeline without consuming
  quota" principle this project has held since Plan A.
- **Dedicated tests for webhook signature verification** specifically — a
  forged webhook is the one input that could trigger this entire pipeline
  illegitimately, so it gets the same scrutiny the Discord bot's
  owner-authorization check got in Plan B.
- **A live dry run against a small throwaway test repo**, under the same bot
  account, before this is ever pointed at the real infrastructure repo —
  same "prove it cheaply before trusting it" pattern as the `e2e-approval-test`
  agent used to validate the park/resume/approval chain.

---

## 10. What this design deliberately does not build

- **How a PR comes to exist.** Sub-project 2b, later, once this gate is
  proven. Nothing here assumes or requires an autonomous proposer — a human
  (or a Claude Code session, like tonight's) opening a PR by hand exercises
  this entire pipeline identically.
- **Isolated/sandboxed execution.** Considered and explicitly declined in
  favor of the simpler model in §6, with the resulting risk stated rather
  than hidden. Worth revisiting once real usage patterns are observed.
- **A GitHub App.** A fine-grained PAT tied to the dedicated bot account
  (already created) is simpler to set up and reason about for a single-owner,
  multi-repo-but-bounded setup than standing up a full GitHub App
  registration/installation flow. Revisitable if this ever needs to operate
  across more accounts/orgs than one owner's.

---

## 11. Open items for the implementation plan

Design-level decisions are settled; these are sizing/detail questions for
whoever writes the implementation plan, not open design questions:

- Exact `webhook` trigger schema shape (what identifies "this repo, this
  event type").
- Exact new-file layout for the webhook receiver and its wiring into
  `src/index.ts` (mirrors how `reconcileAndConnectBot` was added in Plan B).
- The GitHub Actions workflow YAML itself (add if not already present).
- One-time GitHub-side setup: create the repo, invite the bot account,
  create `CODEOWNERS`, configure branch protection — manual steps, not code,
  but need to happen before this can be tested end-to-end for real.
