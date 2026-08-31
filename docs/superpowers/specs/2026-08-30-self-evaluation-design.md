# Goal-directed self-evaluation and structural self-improvement — design

Subsystem 2 of 2. Depends on the memory log from
`2026-08-30-agent-loop-design.md` and on the merge gate from
`2026-08-30-self-build-design.md` (whose rule 3 this spec amends).

Status: partially shipped. The goal-file schema/loader, its `EXCLUDED_PATHS`
entry, spend accounting, and the `RevenueTransport` interface (with its
fake) landed in `docs/superpowers/plans/2026-08-31-goal-file-and-spend-accounting.md`.
`goals.yaml` itself is now committed (operator bootstrap, done) and a
Stripe Managed Payments account is being opened, read-only-scoped for
`RevenueTransport`. Still needed: the real merchant-of-record revenue
transport (implementing `RevenueTransport` against Stripe's actual API); a
separate write-scoped commerce capability so the system can create what it
sells (a Stripe Product/Price/Payment Link) — nothing in this codebase can
list anything for sale yet, `RevenueTransport` only ever reads completed
sales, so this needs its own grant and its own restricted key once a
product proposal actually needs it, not bundled into the read-only
revenue key; the weekly metrics job and its digest integration;
instrumental subordination and the means-constraint classifier in the
proposal/queue path; quota-aware shedding in the Governor;
`architecture-scout`, which the spec's own build order places last.

Supersedes an earlier draft of this file that proposed a human-curated
scorecard of eight process metrics. That draft was wrong in a specific way:
it put the operator in the loop three separate times (attaching grants for
new capability, curating metrics, unblocking growth), which is the
rubber-stamp pattern `CLAUDE.md` rejects. Everything below removes those.

## Problem

Nothing in this system can say whether it is working *well*, and nothing
gives it a direction to be well *at*.

- `OutcomeVerifier` grades one run against its own prompt. Local.
- The reflection pass (subsystem 1) compares the system to its own past —
  which reports that something *changed*, never whether it is *good*.
  Comparison without a target is description, not judgment.
- `improvement-scout` reads source with `[Read, Glob, Grep]` and proposes
  local fixes. No web access, no notion of system performance: it can propose
  "this code could be better," never "this system is missing a subsystem."

Three levels of self-improvement; only the first two exist or are planned:

1. **Tactical** — this run failed, retry it. *Shipped.*
2. **Pattern** — this agent keeps failing at this class of work. *Subsystem 1.*
3. **Directional** — the system's shape is wrong for what it is trying to
   achieve. *Nothing. This spec.*

## The goal file

`goals.yaml` at the repo root. One primary goal, one instrumental secondary,
and the means constraints that bound how they may be pursued.

```yaml
primary:
  id: revenue
  statement: >-
    Generate real, recurring income for the operator.

secondary:
  id: capability
  instrumental: true
  statement: >-
    Improve this system's own capability, reliability and reach — strictly
    in service of the primary goal.

means:
  - Legal in the operator's jurisdiction and in any market touched.
  - No violation of any service's terms of service.
  - No spam, no bulk unsolicited contact, no content farms.
  - No impersonation of a real person or organization.
  - No deception of end users about what they are buying or from whom.
  - When signing up for a service on the operator's behalf, do not claim to
    be a human where the service asks. Acting as the operator's agent, with
    the operator's money, is legitimate; misrepresenting what is signing up
    is what puts the account at risk of termination.
```

**`instrumental: true` is operational, not decorative.** When capability work
competes with revenue work for the queue, revenue wins — unless the
capability proposal carries an explicit revenue thesis (what it unblocks, and
roughly what that is worth). A capability proposal with no such thesis is
deprioritized mechanically. This is what stops a self-improving system from
polishing itself forever with no outside referent.

**The means constraints are part of the goal, not a separate gate.** A
revenue-seeking system with broad autonomy has real and predictable failure
modes — scraping in breach of ToS, spam funnels, content farms,
impersonation. Bounding them in the goal definition costs the operator
nothing at runtime and is checked twice mechanically: at proposal time (a
cheap classifier on the proposal text, same call shape as the router) and
again at merge time in the existing `pr-reviewer` pass.

### What is fixed, and what that costs

`goals.yaml` joins `EXCLUDED_PATHS` (`src/control/excluded-paths.ts`)
alongside `governor.ts` and the pipeline's own safety rails. The system may
**propose** a revision with evidence at any time; it may never author one.

The reason is not caution, it is definition. Every algorithmic check here
compares a change against a reference the change cannot move — self-build
compares against the base-ref registry, tests against expected behavior. The
goal is the reference for "is this system doing well." A system that can
rewrite its objective does not grow, it drifts: any target becomes
satisfiable by moving the target, and "is this better?" stops having an
answer. The fixed goal is what makes the autonomy below it *directional*.

Cost to the operator: authoring one file, once. No clicks after that. This is
not a gate — it is the difference between a system with a purpose and a
system with a random walk.

**Everything below the goal is the system's own.** It invents its own
metrics, tunes their weights, and discards ones that stop being informative,
with no human involvement and no approval step. A first metric set is
suggested below purely as a starting point; the system owns it from day one
and is expected to replace most of it.

## Metrics (system-owned, seeded not fixed)

Computed by a weekly deterministic job — arithmetic over existing stores plus
the memory log, **no LLM in the computation path** — into
`data/state/metrics-<date>.json`, with the delta posted in the digest.

**Primary (revenue):** net income realized and attributable to
system-originated work; revenue per euro of external spend; time from
prospect to first revenue; funnel counts (prospect → validated → built →
shipped → earning) and the stage where threads die.

Income is read from the merchant-of-record's per-sale records via
`RevenueTransport` (see below) — the one metric grounded outside the
system's own reporting.

**Instrumental (capability), only meaningful as they move the above:**
`not-achieved` rate per agent and trend; cost per completed task; rework rate
(PRs bounced by `pr-reviewer`); novelty share and novelty-gate suppression
rate (from subsystem 1's log); queue starvation (oldest pending age).

The system may add, reweight, or retire any of these. Metric changes are
ordinary config changes, not governance changes.

### Anti-gaming

A naive metric set is gameable — queue easy tasks, watch completion rate
climb. Two structural mitigations, neither of which fully solves it:

- The primary metric is **externally grounded**. Revenue is money that
  actually arrived; it cannot be produced by the system marking its own
  homework, unlike every process metric.
- Instrumental metrics are subordinate by construction: moving them without
  moving revenue is visible as exactly that in the digest.

Residual risk stands, and it is a standing reason to read transcripts when a
number moves for an interesting reason.

## Growth without the operator

The earlier draft required a human to attach a grant before the system could
reach any new capability, which capped growth on a recurring human step. That
was a design error. The correct bound is the **credential**, not the grant
entry.

A `grants.yaml` entry whose `secret:` env var is unset is already inert —
that is the live state of `BUILDER_PUSH_TOKEN` today. And a fine-grained PAT
scoped to Contents:Write on one repo cannot do anything outside that scope
regardless of how many grants reference it. The real-world scope of the
credential is a harder bound than any rule written in this repo.

### Amendment to `2026-08-30-self-build-design.md` rule 3

Rule 3 ("no free ride to autonomous+auto") is replaced by a
**credential-scope rule**. A self-authored grant is admissible if either:

- **(a)** its `secret:` names an env var that is **already provisioned and
  already in use** by a live grant — the new grant is then bounded by that
  credential's own real-world scope; or
- **(b)** it carries no real credential (a synthetic capability grant, as
  `web-read` is today) **and** is no broader than an existing grant of the
  same `kind` — same or narrower `urlPattern` / `remote` / `scope`.

Both are mechanical checks against base-ref state, in the same pure function
as the other rules. Rules 1 (schema-valid), 2 (no in-place edit of an
existing grant), and 4 (CI green) are unchanged.

Consequence: the system may freely author new agents and new grants across
everything its existing credentials can reach — which is where essentially
all realistic growth lives. The single remaining act only a human can perform
is **registering an account with a brand-new external service**, which is a
physical-world bootstrap, not an approval of a decision. Expect the revenue
goal to surface a shopping list of these early; that is a useful output, not
a blocker — the system tells the operator exactly what to plug in instead of
the operator guessing.

### Credential breadth is a deliberate dial

The credential-scope rule is only as strong as the credentials are narrow.
The operator's choice is to run **broad** credentials — full access on the
dedicated `Clanker-HQ` bot account rather than today's minimal fine-grained
PATs — so the system can do whatever a task needs without a human widening a
token first. That is the intended trade and it is recorded here so a later
reader does not "fix" it back to narrow scopes.

What it means concretely: for every repo on that account **except this one**,
the system's reach is whatever a GitHub account can do, and the merge
pipeline is not the binding constraint — its own judgment is.

**This repo is the exception, and it must stay one.** Unrestricted push to
this repo's default branch would dissolve the entire safety architecture:
`EXCLUDED_PATHS`, the `mergePR` gates and the self-build rules all assume
changes can only land through a PR. A token that can push straight to `main`
bypasses all of it in one call. Two mechanical requirements:

1. **Branch protection on `main`** requiring a PR and green CI — enforced by
   GitHub itself, outside anything this codebase controls.
2. **No `Administration` permission on this repo** for any credential the
   system holds, so it cannot disable (1).

With those, GitHub enforces the PR path and the existing gates keep their
meaning. Without them, every other guarantee in this spec and in
`2026-08-30-self-build-design.md` is decorative. Branch protection is the
last real bound on this repo once the credential is broad, so it has to hold.

**Implemented 2026-08-30.** Rulesets and branch protection are not enforced
on *private* repositories under GitHub Free — the UI creates the ruleset and
reports it active while enforcing nothing. Since this bound cannot be
optional, `clanker-automated-system` was made **public**, which enables
enforcement at no cost. The repo needing protection holds no secrets
(`.env` is gitignored, `grants.yaml` names only env vars, and its history was
checked clean); the repos that may later hold business-sensitive material are
the product repos, which enforce nothing and can stay private. Live ruleset:
`protect-main`, enforcement `active`, empty bypass list, targeting
`~DEFAULT_BRANCH`, requiring a PR (0 approvals — the bot cannot approve its
own) and the `test` status check.

**Consequence of going public, still open:** `pr-reviewer` triggers on
`pull_request` for `repo: "*"`, so any stranger can fork, open a PR, and
spend subscription quota on a review. The signature check does not help — the
event is genuinely from GitHub. The Governor's budget, concurrency and
breaker caps bound the damage to wasted quota rather than any escape, but the
proper fix is an author filter in the webhook handler: process only PRs
opened by the bot account or a repo collaborator. This should land with
subsystem 1 rather than stay implicit.

### Two different budgets, only one of them automatable

An earlier draft of this spec had the Governor raise its own
`dailyBudgetUsd` against measured ROI. That was wrong, and the reason is
worth recording: **this system runs on a Claude subscription, not API
billing.** The scarce resource for inference is *quota*, not dollars —
`maxBudgetUsd`/`dailyBudgetUsd` estimate the cost of something that is not
billed per token. Revenue cannot buy more subscription capacity; only
upgrading the plan can, and that is a purchase only the operator can make. An
ROI-driven auto-ratchet would have been optimizing a number disconnected from
the actual constraint.

So the two resources are separated:

**1. Inference quota — operator-raised, not automated.** The operator raises
`dailyBudgetUsd` (or upgrades the plan) when they see profit. What *is*
automated is **quota-aware scheduling**: the Governor already admits runs
with an eye on the SDK's `rate_limit_event` utilisation reporting, and should
shed the lowest `goalAlignment` work first when quota is tight, rather than
dropping whichever trigger happens to fire next. Prioritisation under
scarcity is algorithmic; raising the ceiling is not.

**2. External spend — a real, hard-capped pot the system controls.** See
below. This one is genuinely autonomous, because the ceiling is enforced
outside the system entirely.

### The spend pot

The operator funds a **virtual prepaid card with a fixed balance and
auto-topup disabled** (Revolut / Wise / N26 all support this). The system
holds the card details behind a `provision`-kind grant.

Why a card rather than a budget rule: the ceiling is enforced by the bank,
not by code the system could misread or a counter that could drift. At zero
balance the card simply declines. Freezing the card is an instant,
unilateral kill switch requiring no cooperation from the system.

**The ceiling only holds if the system can spend the balance but cannot
administer the account.** These providers are KYC'd, so the account is in the
operator's legal name whichever email opens it — the real boundary is who
reads the password-reset inbox. A system that can read it can reset the
password, re-enable auto-topup and draw on the linked funding source, at
which point the balance caps nothing. Therefore:

- The account is opened on the **operator's** email, and the system never has
  access to that inbox.
- The system gets **card credentials** (spend the balance) and **read-only
  transaction access**, preferably an API token rather than inbox access. If
  no read API exists, forward only transaction notifications to a
  system-readable inbox and keep security mail out of it.
- The system never has access to the **funding source** — the linked bank or
  card. Auto-topup stays off; topping up is a manual operator act.
- Provider note: Revolut's API is business-only, which forces email parsing on
  a personal account; Wise offers personal read tokens. Prefer whichever
  currently gives a clean read API.

**The revenue instrument is the payment processor, not the bank.** An earlier
draft made the card account's transaction feed the source of revenue data.
That was wrong on the merits, independent of any provider's API: a payout
reaches a bank account as a lump transfer with no line items, so it shows
that money arrived but not what sold, when, or which thread earned it — and
attribution is precisely what the funnel metrics need.

Read access to the merchant-of-record's API (Lemon Squeezy / Gumroad /
Stripe) gives per-sale records with product, timestamp and amount. That is
strictly better data, and it is an account the system needs anyway to sell
anything. The bank account is therefore a **spend instrument only**, and
needs no API at all — its ceiling is enforced by the balance whether or not
the system can read it.

Practical consequence: the operator's chosen provider is Revolut personal,
which has no API (business-only). Under this split that costs nothing. The
system does not learn its own balance from the bank; the operator declares it
at top-up time, since funding and declaring are the same action. An attempted
purchase beyond the balance simply declines, which is a clean failure.

**Browser capability must not be pointed at the bank**, once it exists. The
web app is reachable, but: bank login requires 2FA with no app-password
equivalent (a regulatory constraint, not a product gap), so every check would
require a push approval on the operator's phone — worse than declaring the
balance once per top-up. It would additionally require the account's real
password, which grants account administration and dissolves the balance-as-
ceiling guarantee this whole section rests on. And automated access breaches
essentially every bank's terms of service, which `goals.yaml`'s means
constraints already forbid, with account freezing as the concrete downside.

This is not a limit on browser capability generally — checkouts, service
signups, and API-less dashboards are exactly what it is for. Banking is the
single target where the credential model is wrong.

Design rules:

- **Committed recurring spend must be tracked.** A €5/mo subscription signed
  up once keeps charging until the balance dies, at which point the *service*
  breaks mid-use rather than spend stopping cleanly. Every spend decision
  records whether it is one-off or recurring; the available-to-spend figure
  is `balance − sum(committed recurring)`, never raw balance. One-off
  purchases are preferred and recurring ones need an explicit revenue thesis.
- **Every spend is logged to the memory log** with its goal rationale, so the
  reflection pass can evaluate return per euro as a first-class metric.
- **`limit.perDay` cannot be relied on.** README documents that this field on
  a `provision` grant is validated at boot and then never consulted — nothing
  counts uses. Until that counter is actually implemented, the card balance is
  the only real ceiling. Do not write a spend design that assumes otherwise.

### What the pot is and is not for

**Not this system's own infrastructure.** The operator pays for the VPS and
the Claude subscription directly. The system never spends on running itself.
The pot covers costs of *what it builds* to earn money.

**Many revenue paths need no spend at all** — publishing packages to
npm/PyPI, selling through a marketplace that supplies both storefront and
payment (Gumroad, itch.io), anything served from GitHub Pages, freelance or
bounty work. Do not assume a "deploy a web app" shape by default; the
zero-cost paths are usually the faster ones to first revenue.

**When spend is genuinely required**, it is typically a domain (~€10/yr) and
occasionally third-party API credit. A domain is not cosmetic for a paid
product: no HTTPS on a bare IP (Let's Encrypt does not issue for one, and
browsers mark it insecure), payment processors require HTTPS at checkout,
mail from a bare IP does not deliver, and the address breaks if the VPS
moves. An IP is fine for anything internal.

**Funding order: account first, money later.** Create the account and grant so
the capability exists; fund it when a concrete proposal needs a purchase, not
in advance. At zero balance the system simply cannot act on spend-requiring
proposals and reports that. Topping up is the same category as registering a
new service — a physical bootstrap, not an approval of a decision.

**Taking payment: prefer a merchant of record.** Any proposal to sell
something should default to Lemon Squeezy / Paddle / Gumroad over raw Stripe.
They become the legal seller, which means EU VAT and OSS registration are
theirs rather than the operator's — a material difference for a solo
operator selling digital goods into the EU, and a cost that does not appear
in a naive revenue estimate. A revenue proposal that assumes direct Stripe
integration should state why the MoR route does not fit.

### Hosting a product on the operator's VPS

Free capacity the operator already pays for, and the obvious host for a first
product — but the same box runs the supervisor holding
`CLAUDE_CODE_OAUTH_TOKEN` and the broad GitHub credential. A compromised
public-facing app there reaches both.

So a system-built product hosted on that VPS runs in a **separate container
with no access to the supervisor's data directory or environment**, and its
own credentials are never drawn from the agent's env. This needs deciding
before the first product ships, not retrofitted after.

## `architecture-scout`

A new cron scout, same flat shape as the existing four. Proposal-only, no
authority over any other agent.

```yaml
name: architecture-scout
trigger: { type: cron, schedule: "0 4 1 * *" }   # monthly
permissions:
  allowedTools: [Read, Glob, Grep, WebSearch]
tier: readonly
approval: notify
grantRefs: []
```

**On the toolset — this is the trap `agents/research/agent.yaml` documents.**
That file deliberately withholds `Read` because `Read` plus the broad
`web-read` grant (`urlPattern: "*"`, `WebFetch` to arbitrary URLs) is a
direct exfiltration path: read a secret off disk, `WebFetch` it to an
attacker-chosen URL, auto-allowed. `architecture-scout` needs `Read` — its
whole job is reading this system's own source — so it gets **`WebSearch`
only, no `WebFetch`, no grants**. Search results return through the harness;
there is no attacker-chosen URL to send anything to. This mirrors
`opportunity-scout`, already `WebSearch`-only at `tier: readonly` with no
grants. A future edit that seems to need `WebFetch` here needs a different
design, not a wider grant.

Reads: the computed metrics, reflection records, `agents/*/agent.yaml`,
`grants.yaml`, `docs/decisions.md` (what was already rejected and why),
`docs/system-context.md`, and the outside world via `WebSearch`.

Proposes: structural change — a new agent, a missing subsystem, a pattern
from outside this codebase.

**Discipline: every proposal must cite a measured weakness and a path to the
goal.** Which metric, its observed value, and how the change is expected to
move revenue (directly, or through a stated instrumental chain). A proposal
citing nothing measured is rejected at queue time. Mechanical check, not
judgment — and it is what keeps the scout from chasing whatever is
fashionable in agent research this month.

## How a structural change lands

No new merge machinery; the path exists once the self-build gate ships.

```
metrics show revenue-per-dollar falling, builder repeating similar work
  → reflection pass names the pattern
  → architecture-scout finds external work on skill libraries, ties it to
    that metric and to a revenue thesis, queues a proposal
  → builder implements
  → pr-reviewer reviews (means constraints, redundancy, sense, quality)
  → self-build gate: schema-valid, no in-place grant edit, credential-scope,
    CI green
  → health check, auto-rollback on failure
```

That is the concrete answer to "could it build a skill library itself" — yes,
end to end, with no human in the chain.

## What it still cannot see

Stated rather than papered over:

1. **It perceives only what it instruments.** It now owns its instruments,
   so it can fix this — but only for things it thinks to measure.
2. **Goodhart is mitigated, not solved.** Revenue being externally grounded
   raises the cost of gaming considerably; it does not eliminate it.
3. **It cannot question its own goal.** By construction — that is what makes
   it a goal. It can propose a revision with evidence at any time.

## Testing

- Metric computation: pure functions over fixture stores; each metric
  positive and negative; empty-history and single-run edge cases.
- `goals.yaml` in `EXCLUDED_PATHS` — a PR touching it refuses (extend the
  existing `excluded-paths` test).
- Credential-scope rule: new grant on a provisioned in-use secret (allow);
  on an unprovisioned secret (refuse); synthetic grant narrower than an
  existing same-kind grant (allow); synthetic grant broader (refuse).
- Spend accounting: available-to-spend subtracts committed recurring charges
  from balance; a recurring commitment that would exhaust the balance before
  its next renewal is refused; every spend appends a memory-log record with
  its rationale.
- Quota-aware shedding: under simulated high `rate_limit_event` utilisation,
  the lowest-`goalAlignment` pending work is dropped first rather than the
  next trigger to fire.
- Instrumental subordination: a capability proposal with no revenue thesis
  ranks below a revenue proposal of equal novelty and importance.
- Means-constraint classifier: a spam-shaped proposal is rejected at queue
  time.
- `architecture-scout` toolset: asserts no `WebFetch` and no `grantRefs`, so
  the `research`-style pairing cannot be reintroduced by a later edit without
  failing a test.

## Sequencing

**Operator bootstrap** (the whole human surface, one time):

- Write `goals.yaml`.
- Enable branch protection on this repo's `main` (PR + green CI required),
  and confirm no system-held credential has `Administration` here.
- Issue the broad `Clanker-HQ` credential and swap it in.
- Open the virtual prepaid card with auto-topup disabled, and add its
  credentials. Funding it can wait until a proposal actually needs a
  purchase — this account is a **spend instrument only** (see "The revenue
  instrument is the payment processor, not the bank"); it needs no read API
  of its own.
- Open a merchant-of-record account (Lemon Squeezy / Gumroad / Stripe) and
  add its API credentials. This one matters from day one for the *receive*
  side — revenue is unobservable without it, since it is what
  `RevenueTransport` reads per-sale records from.
- Create a **dedicated email account** for the system, structured like the
  card: the operator holds the password and 2FA, the system gets a revocable
  app password for IMAP/SMTP. Without an email identity the system cannot
  register for any service on its own, which puts a human back into every
  signup. It must **never** be the recovery address for the spend account —
  anything registered to a system-readable inbox is system-controlled.

**Build order:**

1. Subsystem 1 ships; the log accumulates real data.
2. Self-build merge gate ships, with the amended rule 3.
3. `goals.yaml` excluded; metric job ships seeded with the set above; spend
   accounting and the `RevenueTransport` reader land with it, since revenue
   is the primary metric and is unobservable without them.
4. `architecture-scout` last — it is useless before metrics exist, since
   every proposal must cite one.
