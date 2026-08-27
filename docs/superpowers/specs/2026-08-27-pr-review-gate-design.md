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
PR opened / synchronized / reopened on GitHub
  → GitHub fires a `pull_request` webhook immediately, in PARALLEL with CI —
    the webhook is NOT gated on CI's result (see the note below)
  → GitHub Actions runs npm test + typecheck (a workflow this design adds —
    no CI exists yet, since no GitHub repo exists yet either)
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
      → clean: call the merge API, after re-checking the PR's head SHA hasn't
        moved since review started
          → CI red (or still running): GitHub's own branch protection refuses
            the merge; the pipeline reports the refusal and the PR stays open
          → CI green: merged
```

**Where CI-gating actually happens.** The trigger deliberately fires on the
PR event itself rather than on a `check_suite`-completion event, so the
review starts immediately and runs concurrently with CI instead of waiting
for it. Nothing in this system's own trigger logic inspects CI's pass/fail
state. What guarantees a test-breaking PR cannot merge is **GitHub branch
protection's "require status checks to pass before merging"** on `main`,
configured against the CI workflow's check: GitHub's merge API itself refuses
a merge whose required checks haven't passed, for any actor including this
pipeline's bot identity. That refusal surfaces through
`mergePullRequest` as an ordinary `{merged: false, reason: ...}` — the same
path a stale-SHA refusal takes — so the pipeline reports it and the PR stays
open. This puts the CI gate in the one place a bug in this codebase cannot
remove, which is the same reasoning as Lock 4's Wall 2 (§3).

---

## 3. The privilege boundary, extended

The parent design's three locks (Lock 1: server only runs `main`; Lock 2:
grants aren't agent-authorable; Lock 3: secrets never enter a workspace) all
still hold and are not weakened by this design. This adds a fourth,
specific to this pipeline:

**Lock 4 — the pipeline cannot touch its own safety rails.** A fixed set of
files defines the rules that constrain every agent in this system, *and* the
code that implements this very exclusion. A PR touching any of them is refused
by this pipeline categorically — not reviewed, not parked, not merged under any
verdict.

The set has two halves, both in `src/control/excluded-paths.ts`:

**`EXCLUDED_PATHS`** — exact-path matches:

| Path | Why |
| --- | --- |
| `src/governor.ts` | budget/concurrency/quiet-hours/breaker enforcement |
| `src/grants.ts` | grant matching and the `decide()` engine |
| `src/agent-schema.ts` | what an agent definition is even allowed to say |
| `src/control/bot.ts` | the Discord bot's owner-authorization check |
| `grants.yaml` | the grants themselves |
| `config.yaml` | governance configuration (excluded whole — see below) |
| `src/control/excluded-paths.ts` | this list; deleting one line removes the mechanism |
| `src/runner/sdk-runner.ts` | all three of `mergePR`'s gates live here |
| `src/control/webhook-signature.ts` | the only thing between a forged HTTP request and a run |
| `src/control/webhook-wiring.ts` | the `enabled` predicate and the untrusted-content fence |
| `src/control/webhook-receiver.ts` | the inbound HTTP trust boundary |
| `src/runner/credentials.ts` | the child-env allowlist keeping secrets out of subprocesses |
| `src/index.ts` | boot wiring: what gets constructed with which credentials |
| `.github/workflows/ci.yml` | CI itself, which branch protection requires (§2) |

**`EXCLUDED_PREFIXES`** — whole subtrees, matched by path prefix:

| Prefix | Why |
| --- | --- |
| `agents/` | any `agent.yaml` is a capability grant |

The prefix half exists because exact-path membership structurally cannot cover
a directory that grows over time. Any `agent.yaml` under `agents/` is a
capability declaration: a PR adding `tier: autonomous`, `approval: auto`,
`grantRefs: [infra-repo]` to some *other* agent hands that agent merge
capability without ever touching the excluded `grants.yaml`. Listing today's
agent files by name would silently stop protecting tomorrow's.

`config.yaml` is excluded whole rather than just its `governor:` key: a
line-range check inside one file is fragile against reformatting, and nothing
else in `config.yaml` is sensitive enough to be worth that risk for the rare
case an automated PR would want to touch it at all.

The second half of the list — this pipeline's own implementation — is not
optional caution. A pipeline able to merge changes to its own gates is a
pipeline with no gates: one PR weakens a check, the next does anything.

This is deliberately *not* "ask a human" — the owner does not want
to review code, so the safety here comes from removing the *capability*, not
from a decision point. Changes to that code happen the way tonight's did:
directly, by a human (or a human-directed session), on their own schedule,
outside this pipeline entirely.

**Enforced by two independent mechanisms:**

1. **Our own pipeline code.** A static path-list check runs against the PR's
   changed files as GitHub itself reports them (the PR-files API, not
   anything the reviewing agent supplies). Any overlap with `EXCLUDED_PATHS`
   or `EXCLUDED_PREFIXES` → hard stop. A rename contributes *both* its old
   and new path to that list, so a PR cannot move an excluded file out from
   under the check; and a changed-file list too long to fetch in one page
   fails closed (refuse to review) rather than being silently truncated.
2. **GitHub's own access control**, independent of anything this codebase
   does. A `CODEOWNERS` file marks the excluded paths as requiring review
   from an account other than the bot; branch protection on `main` requires
   that review before merge; the bot's own GitHub permissions are configured
   so it cannot bypass branch protection. Even a bug in mechanism 1 — a
   missed path, a logic error — does not remove this guarantee, because it
   does not depend on our code being correct. That `CODEOWNERS` file should
   be **generated from (or explicitly kept in sync with)**
   `EXCLUDED_PATHS`/`EXCLUDED_PREFIXES` rather than hand-maintained as a
   separate list: two independently-edited copies of the same set is how one
   quietly ends up shorter than the other, and the whole point of Wall 2 is
   that it covers what Wall 1 covers even when Wall 1 has a bug.

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
- Filters to the events this system cares about — `pull_request` with an
  action of `opened`, `synchronize`, or `reopened` — and ignores everything
  else. Note what is *not* here: no `check_suite`-completion event, and no
  inspection of CI's pass/fail state. A review starts as soon as a PR appears
  or changes, concurrently with CI; the CI gate lives in GitHub branch
  protection at merge time instead (§2).
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
those individual actions should ever need approval per §3's decision.

**Revised from the original design** (which called for an explicit,
hand-maintained repo list, "never 'all repos,' never unbounded"): the bot
GitHub identity is a dedicated, single-purpose account created only for this
system and whatever repos it comes to manage — it holds nothing else. Given
that, the owner chose automatic scope over a hand-maintained allowlist: the
grant's `repos` field accepts either an explicit array (kept for a shared or
multi-purpose account, where a narrower allowlist than the token's own reach
is still worth keeping) or the literal `"*"`, meaning "any repo the
underlying token can reach." The boundary that actually matters is not the
repo count but the **permission type** on the fine-grained PAT: it is scoped
to "all repositories" on the dedicated account, with only `Contents: Read`
and `Pull requests: Read and write` — explicitly *not* `Administration`
(which governs branch-protection rules and CODEOWNERS enforcement), and
nothing account-level (billing, collaborators, other accounts). Withholding
`Administration` is what keeps Wall 2 (§3) intact regardless of how many
repos the token's PR permissions cover: the bot can merge PRs, and nothing
else, on any repo it can see.

A GitHub webhook is still inherently per-repo — a new repo needs one added
in its own Settings → Webhooks regardless of grant scope, since no
account-wide webhook exists without a GitHub App (§10). The wildcard removes
the need to hand-edit `grants.yaml`/`agent.yaml` for every new repo; it does
not remove that one GitHub-side setup step.

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

**A second, related accepted risk: `Bash` can reach `gh` directly.** The
`pr-reviewer` agent has `Bash` in its `allowedTools` — it needs it to check
out and actually run the PR's code. `detectOutwardEffect` in `src/grants.ts`
does not recognize `gh pr merge`, `gh pr review`, or `git push` as outward
effects, so `decide()` falls through to its "no effect detected → allow"
default for them. An agent that chose to shell out to `gh pr merge` — whether
by its own error or because its behavior was hijacked by content injected in
the PR it is reviewing — would therefore bypass all three of `mergePR`'s
gates entirely, **including Lock 4's excluded-path check**. Wall 2
(CODEOWNERS + branch protection, §3) still holds against this, since it
restricts by *who* is merging rather than by which code path asked; so the
bound on this risk is the same as the token-theft bound above: a PR can get
merged without passing review, but the excluded security-sensitive paths stay
protected.

This is stated as an **accepted, documented risk for now**, on the same terms
as the token-theft risk above — not an oversight. Closing it properly is a
real design decision rather than a bolt-on: either extend
`detectOutwardEffect` to recognize these Bash-invoked GitHub-CLI and
`git push` patterns (and accept that string-matching a shell command line is
itself a fragile boundary), or narrow `Bash`'s availability/scope for this
agent specifically (and accept that a reviewer that cannot run arbitrary
commands is a weaker reviewer). Both belong to a future task, not this one.

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

- CI never goes green → the review still runs (the trigger is the PR event,
  not CI's result — §2), but the merge cannot land: GitHub branch protection's
  required status check refuses it, surfacing as an ordinary
  `{merged: false, reason: ...}` the pipeline reports on the PR. The PR stays
  open and visibly broken on GitHub. The cost of the trigger not being
  CI-gated is a review that may run against a branch CI later fails — wasted
  budget, not an unsafe merge.
- Anything fails *before* the run starts (a GitHub rate limit, a network
  error, a revoked token, or the deliberate fail-closed refusal on a
  changed-file list too long to fetch in one page) → no run record exists,
  so the breaker and the Discord outbox never see it. The reason is instead
  posted as a comment on the PR itself, where a human is actually looking,
  and logged. Nothing merges.
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
