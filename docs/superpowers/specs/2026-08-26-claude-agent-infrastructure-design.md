# Claude Agent Infrastructure — Design

**Date:** 2026-08-26
**Status:** Approved in outline; revised after the autonomy requirement
**Scope:** Sub-project 1 of 3 — core runtime, control channel, and deployment

---

## 1. Purpose

A self-hosted platform that runs Claude agents unattended on a server, billed
against a Claude subscription rather than the API.

**The owner does not write configuration.** Agent definitions are authored by
Claude locally and deployed, or proposed by an agent on the server and approved
by the owner. Every artefact in this system is therefore designed to be written
and validated by a machine, and read by a human only when something needs a
decision.

The owner's entire interface is Discord: approvals, answers to agent questions,
and reports.

### Success criteria

1. An agent runs on a schedule with no human present and reports to Discord.
2. A new agent can be created without the owner editing a file.
3. No `ANTHROPIC_API_KEY` anywhere; authentication is the Claude subscription.
4. An agent cannot increase its own privileges by any path.
5. A runaway agent is stopped by budget, turn, or time limits without human action.
6. A run awaiting approval survives a server restart and resumes on approval.
7. The whole pipeline is testable without consuming meaningful subscription quota.

### Explicit non-goals for v1

No web dashboard. No database — JSON files on disk are correct at this scale.
No multi-user support. No automatic retry of failed runs. No continuous
autonomous workers.

---

## 2. Operating model

Two planes, separated by who may write to them.

| | Control plane | Data plane |
|---|---|---|
| **Contains** | Agent definitions, grants, global config | Workspaces, transcripts, run records, agent output |
| **Written by** | Claude locally, or agents via proposal branches | Agents, freely |
| **Made live by** | A human merge, always | Nothing — it is already live |
| **Lives in** | Git | The `data/` volume |

The owner's actions are limited to three: approving a proposed agent, approving
an irreversible action, and answering an agent's question. All three happen in
Discord as a tap or a short reply.

---

## 3. The privilege boundary

**The threat.** Agent definitions declare capabilities. If an agent can author
agent definitions, an agent can grant itself capabilities — not maliciously, but
because writing itself a deploy token is the shortest path to a goal it was
given. Every safeguard in this design lives inside those files, so an agent that
can edit them holds the key to its own sandbox.

This must be structurally impossible. Instructions are suggestions to a system
this open-ended; only mechanism is binding.

### Three locks

**Lock 1 — the server runs only `main`.** The supervisor deploys from a git
checkout and refuses to load agent definitions from any other ref. An agent may
write a complete, valid agent definition and push it to `proposal/*`; it cannot
make it run. Merging is a human action, surfaced as a Discord approval carrying
a plain-language summary of what the proposed agent would be able to do.

**Lock 2 — grants are not in `agent.yaml`.** Credentialed powers live in
`grants.yaml`, which the registry loads separately and which agent-authored
commits may not modify. A merged agent definition referencing a grant that does
not exist in `grants.yaml` fails validation at boot. Authoring an agent and
authorising it are two different acts requiring two different writes.

**Lock 3 — secrets never enter a workspace.** Grant credentials live in the
supervisor's environment. The runner performs granted effects *on behalf of* an
agent; the agent receives a result, never a token. An agent that reads every
file it can reach still finds no credentials.

### Consequence

The worst outcome from a fully compromised or badly confused agent is: it
consumes its budget, makes a mess inside its own workspace, and pushes a
proposal branch nobody merges. That is a recoverable afternoon, not an incident.

---

## 4. Decisions and rationale

### 4.1 Authentication — subscription, via a swappable provider

`claude setup-token` mints a long-lived OAuth token tied to a Claude
subscription. Exposed to the container as `CLAUDE_CODE_OAUTH_TOKEN`, the Agent
SDK uses it and no API billing occurs.

**Terms-of-service boundary.** Anthropic does not permit third-party developers
to offer claude.ai login or rate limits *to their products' users* without prior
approval. Running agents for oneself on one's own subscription is the intended
use of `setup-token`. The line is crossed only if end users' actions come to
trigger Claude calls on this subscription; the owner has confirmed no such
product is planned. Credential resolution is nonetheless isolated in one module
so a move to API-key billing stays a configuration change.

### 4.2 Rejected: Managed Agents

Anthropic's Managed Agents product with scheduled deployments does what this
platform does, with Anthropic hosting the loop and the sandbox. It bills against
the API, which violates the primary requirement. Worth revisiting only if
billing ever moves to the API.

### 4.3 Rejected: one container per run

Kernel-level isolation per run requires Docker socket access from the
supervisor — equivalent to host root — plus an image pipeline and slow cold
starts. Disproportionate for one operator running their own agents. The `Runner`
interface (§7.1) is the seam where this could be adopted later.

### 4.4 Chosen: one container, one supervisor, agents as folders

The container is the security boundary. Within it, agents are separated by
workspace directory, per-agent tool permissions, and capability tiers.
TypeScript, because the Agent SDK wraps the Node-based Claude Code binary.

---

## 5. Repository layout

```
claude-agent-infrastructure/
├─ docker-compose.yml
├─ Dockerfile                  # FROM mcr.microsoft.com/playwright:v1.x-noble
├─ .env.example                # documents required keys; .env is gitignored
├─ config.yaml                 # governor settings, Discord channel map
├─ grants.yaml                 # HUMAN-ONLY: credentialed powers (Lock 2)
├─ schema/
│  ├─ agent.schema.json        # JSON Schema — authoring agents validate first
│  └─ capabilities.json        # machine-readable menu of legal tools and tiers
├─ src/
│  ├─ index.ts                 # boot: validate everything, then start triggers
│  ├─ registry.ts              # discover + validate agents/*/agent.yaml
│  ├─ runner/
│  │  ├─ types.ts              # Runner interface, RunEvent union
│  │  ├─ sdk-runner.ts         # THE seam — only file importing the SDK
│  │  ├─ fake-runner.ts        # canned event streams for tests
│  │  └─ credentials.ts        # swappable: subscription token | API key
│  ├─ governor.ts              # admission control, budgets, breaker
│  ├─ grants.ts                # tier + grant enforcement (security boundary)
│  ├─ control/
│  │  ├─ bot.ts                # Discord bot: approvals, questions, commands
│  │  ├─ pending.ts            # durable park/resume queue
│  │  └─ deploy.ts             # git pull, validate, reload; merge on approval
│  ├─ outbox/discord.ts
│  └─ triggers/cron.ts
├─ agents/<agent-name>/
│  ├─ agent.yaml
│  └─ prompt.md
├─ docs/superpowers/specs/
└─ data/                       # named docker volume, gitignored
   ├─ workspaces/<agent>/      # persists across runs
   ├─ runs/<runId>/            # transcript.jsonl + result.json
   ├─ state/<agent>/           # notes an agent leaves its future self
   ├─ pending/<id>.json        # parked runs awaiting a human (§8.2)
   ├─ config-overrides.json   # runtime settings set from Discord (§7.3.1)
   ├─ undelivered/             # outbox failures, never dropped
   └─ STOP                     # kill switch: presence halts everything
```

---

## 6. The agent definition — machine-first

Two files per agent. Neither is written by the owner.

`prompt.md` is the task in plain English.

`agent.yaml` is governed by `schema/agent.schema.json`. Because its authors are
language models rather than people, three properties matter more than brevity:

**Schema-validated before commit.** An authoring agent validates against the
JSON Schema and fixes its own mistakes without a round trip through a human.

**A machine-readable capability menu.** `schema/capabilities.json` enumerates
every legal tool name, tier, trigger type, and grant kind. An authoring agent
reads what is possible rather than guessing and failing at boot.

**Validation errors written for a model.** Errors state the offending path, the
legal values, and the fix — `permissions.allowedTools[2]: "Browser" is not a
tool. Legal values: [...]. For browser control set capabilities.browser.enabled`
— not `invalid config`. The reader is an agent that must self-correct.

```yaml
name: daily-digest              # must match directory name
enabled: true
authoredBy: claude-local        # claude-local | agent:<name>  (provenance)

trigger:
  type: cron
  schedule: "0 7 * * *"
  timezone: UTC

run:
  model: claude-opus-5          # claude-haiku-4-5 for dev/smoke agents
  effort: medium
  maxTurns: 40
  timeoutMinutes: 15
  maxBudgetUsd: 1.00

permissions:
  allowedTools: [Read, Write, Edit, Glob, Grep, WebSearch, WebFetch]
  disallowedTools: [Bash]

tier: sandboxed                 # readonly | sandboxed | granted | autonomous
approval: approve               # DEFAULT. auto | notify | approve
grantRefs: []                   # ids from grants.yaml; never inline definitions

capabilities:
  browser:
    enabled: false
    blockedOrigins: []
    exclusiveSlot: true

outbox:
  discord: research
  notifyOn: [success, failure, parked]
```

`authoredBy` records provenance so a proposal's approval message can say who
wrote it. `grantRefs` holds ids only — grant bodies live in `grants.yaml`,
enforcing Lock 2 at the schema level rather than by convention.

**Model choice.** `claude-opus-5` for real work; `claude-haiku-4-5` for dev and
smoke agents, to minimise quota consumption while exercising the plumbing. Haiku
4.5 has a 200K context window rather than 1M — it tests infrastructure, not long
research runs.

**Validation happens at boot, not at trigger time.** A malformed cron
expression, an unknown tool, or a `grantRef` with no matching grant fails
startup loudly. Silent per-trigger skips produce agents that look healthy and
never run.

---

## 7. Components

### 7.1 Runner — the SDK seam

```ts
interface Runner {
  execute(agent: AgentDef, run: RunContext, signal: AbortSignal):
    AsyncIterable<RunEvent>;
}
```

`SdkRunner` is the only module importing `@anthropic-ai/claude-agent-sdk`,
mapping an `AgentDef` onto `query()` options:

| agent.yaml | SDK option |
|---|---|
| `run.model`, `run.effort`, `run.maxTurns` | `model`, `effort`, `maxTurns` |
| `run.maxBudgetUsd` | `maxBudgetUsd` |
| `run.timeoutMinutes` | `abortController` on a timer |
| `permissions.*` | `allowedTools`, `disallowedTools` |
| workspace path | `cwd` |
| `capabilities.browser` | `mcpServers.playwright` |
| `tier`, `grantRefs`, `approval` | `canUseTool` + `hooks.PreToolUse` |
| resuming a parked run | `resume`, `sessionId` |

`settingSources` is set explicitly rather than left to default, so a run's
behaviour depends only on its definition and not on stray files in the image.

`FakeRunner` replays canned `RunEvent` streams, so everything downstream is
tested at zero quota cost — including paths that cannot be summoned on demand:
budget exceeded, timeout, denied grant, parked-then-resumed, outbox down.

### 7.2 Capability tiers and grants — the security boundary

| Tier | Permits | Forbids |
|---|---|---|
| `readonly` | Read, search, web fetch, report | All writes |
| `sandboxed` | Full freedom inside its workspace: bash, packages, local git commits | Any outward effect |
| `granted` | `sandboxed` plus effects matching its `grantRefs` | Anything not enumerated |
| `autonomous` | `granted` without per-action approval | Anything not enumerated |

`grants.yaml`, human-controlled:

```yaml
grants:
  - id: push-site
    kind: git-push
    remote: github.com/<owner>/<repo>
    branches: [main]
    secret: GH_TOKEN_MY_LANDING_PAGE     # scoped to that one repository
  - id: deploy
    kind: http
    method: POST
    urlPattern: "https://api.netlify.com/build_hooks/*"
    secret: NETLIFY_HOOK

  - id: new-repo
    kind: provision                      # see §7.6
    resource: github-repo
    scope: github.com/<machine-account>  # may create repos only here
    limit: { perDay: 3 }
    secret: GH_TOKEN_PROVISION
```

An agent's outward powers are readable from two files; grants are revocable
individually; each maps to a credential scoped to it, so a failure's blast
radius is that grant rather than an account. Per Lock 3, the runner executes
granted effects on the agent's behalf and returns only results.

**Approval modes.** `approve` is the default and the owner's chosen posture: the
agent parks, Discord asks, a tap resumes or denies. `notify` proceeds while
posting as it happens. `auto` proceeds silently, reserved for `autonomous`-tier
agents that have earned it.

**Browser capability.** Playwright MCP is opt-in per agent and started only for
agents declaring it. Available at any tier, but what it may carry depends on
tier:

| Tier | Browser configuration |
|---|---|
| `sandboxed` and below | `--headless --isolated`, no stored credentials, logged out |
| `granted` and above | May use `--storage-state` or `--secrets`, only for credentials named in a grant |

A browser holding a live login can act as the account owner on that site — an
outward effect, and therefore behind a grant. A logged-out isolated browser is a
read-and-explore tool needing none. Playwright's documentation states that
`--allowed-origins` and `--blocked-origins` are *not* a security boundary; they
are guardrails against mistakes, not defence. Pin the package version.

Grant enforcement receives the most thorough tests in the project: table-driven
over (tier, grants, attempted effect) → allow | deny | park.

### 7.3 Governor — admission control

| Mechanism | Prevents | Implementation |
|---|---|---|
| `maxBudgetUsd` | Unbounded thinking | SDK |
| `maxTurns` | Tool-call loops | SDK |
| `timeoutMinutes` | Wedged processes | `abortController` |
| `allowedTools` | Misuse of unnecessary tools | SDK — absent from context |
| Concurrency cap | Simultaneous wake-ups | Queue; 2 slots; browser agents take an exclusive slot |
| Daily budgets | Unnoticed slow bleed | Per-agent and global; a global breach pauses everything and alerts |
| Circuit breaker | Endless failure loops | 3 consecutive failures disables the agent and alerts once |

`config.yaml` supplies defaults:

```yaml
governor:
  maxConcurrent: 2
  dailyBudgetUsd: 10
  pendingTimeoutHours: 24

  # Local development: agents run almost always; the window is nominal.
  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }

  # Production (VPS): agents work overnight and stand down while the owner
  # is awake and using Claude interactively.
  # quietHours: { from: "10:00", to: "22:00", timezone: Europe/Berlin }
```

Timezones are always IANA zone names, never fixed offsets or abbreviations.
`Europe/Berlin` carries the CET/CEST daylight-saving rules, so the window does
not silently shift by an hour in October. A hardcoded `+02:00` would.

The production window reserves twelve hours a day for the owner's own use of the
subscription. Agents are nocturnal by design; this is the single most effective
protection against the failure mode where agents exhaust the shared rate limit
during working hours. It is expected to widen as the subscription plan or the
observed consumption allows — hence §7.3.1.

#### 7.3.1 Mutable operating parameters vs. the immutable boundary

Two classes of setting, deliberately stored and changed differently.

| | Runtime-mutable | Git-only |
|---|---|---|
| **Contains** | `quietHours`, `dailyBudgetUsd`, `maxConcurrent`, per-agent enable/disable | Grants, tiers, `permissions`, `capabilities`, agent definitions |
| **Changed via** | A Discord command, taking effect immediately | A commit and a human merge (§3) |
| **Stored in** | `data/config-overrides.json` | Git |
| **Governs** | Pacing and cost | Authority |
| **Cost of a wrong value** | Wasted time or quota — recoverable, and you want to correct it in seconds | Loss of control — the slowness is the safeguard |

Precedence is override, then `config.yaml`, then built-in default. Overrides
persist across restarts, are echoed to Discord when set, and are recorded in an
audit log so the current configuration always has a traceable origin.

Because the governor is consulted at trigger time rather than at schedule
registration, a changed window takes effect on the very next trigger — no
reload, no redeploy, no restart.

```
!quiet                     → show the current window
!quiet 10:00-22:00         → set it
!quiet off                 → disable quiet hours; agents run at any hour
!budget 25                 → change the daily budget ceiling
!concurrency 3             → change parallel run slots
```

`!quiet off` is expected to be used the moment the subscription plan allows
agents to run continuously. Widening the window is a message from a phone, not a
deployment.

Under no circumstances does this mechanism extend to grants, tiers, or
permissions. Anything that changes what an agent is *allowed to do* passes
through git and a human merge, because that is the only path the privilege
boundary in §3 can defend.

**Kill switch:** the presence of `data/STOP` prevents new runs and aborts running
ones. One file, usable over SSH in seconds.

**Subscription rate limits.** Agents share one rate limit with the owner's
interactive Claude Code use, and no API reports the remaining allowance. Three
mitigations: track estimated cost and tokens per run, enforcing daily budgets
against those; on a rate-limit error, pause globally, alert, and retry with
exponential backoff; and defer to the human during `quietHours`. The third
matters most — agents consuming the allowance during the owner's working hours
is the failure that would cause abandonment.

**Parked runs hold no slot.** A run awaiting approval has exited (§8.2); it
consumes nothing while it waits.

### 7.4 Control channel — the Discord bot

The owner's only interface, and therefore core rather than deferred. It handles:

- **Action approvals** — an agent wants an irreversible effect; the message
  states the agent, the effect, the grant it invokes, and why. Approve or deny.
- **Proposal approvals** — an agent wrote a new agent definition on a
  `proposal/*` branch; the message summarises what it would be permitted to do,
  in plain language derived from its tier and `grantRefs`. Approving merges to
  `main` and triggers a deploy.
- **Agent questions** — free-text; the reply is injected into the resumed run.
- **Commands** — status and control: `!runs`, `!stop`, `!resume`,
  `!disable <agent>`, `!enable <agent>`; and the runtime settings of §7.3.1:
  `!quiet`, `!budget`, `!concurrency`. Settings commands echo the new value and
  write to the audit log. No command can alter grants, tiers, or permissions.

Every prompt carries its `pendingId`, so answers survive restarts and cannot be
misrouted. Unanswered prompts expire after `pendingTimeoutHours` (default 24),
resolving as **deny**, reported as such. Silence never authorises anything.

### 7.5 Outbox

Discord incoming webhooks, one channel per agent, mapped by key in `config.yaml`
with URLs in `.env`. Messages report what the agent did, what it cost, which
effects it touched, and the run id. Failures retry three times, then write to
`data/undelivered/`. A result is never lost because the outbox was unavailable.

Webhooks are used for reporting and the bot for interaction, because webhooks
cannot receive replies.

### 7.6 Identity and resource provisioning

The system must be able to create things for itself — a repository for a new
project, a site to deploy to, a subdomain to publish on — without the owner
operating a dashboard. It must not create **identities**.

| | Created by | Rationale |
|---|---|---|
| **Identity roots** — email, GitHub machine account, hosting account, domain | The owner, once (four items) | Legally the owner's regardless of who registers them; bound to payment methods; unrevocable if unenumerable. Automated registration also violates the terms of every relevant service and is defeated by CAPTCHA and phone verification |
| **Resources** — repositories, sites, subdomains, projects | Agents, via API, under a `provision` grant | Created inside a boundary the owner already controls: listable, revocable in bulk, free |

An agent registering accounts does not reduce the owner's liability; it removes
the owner's visibility. An agent creating its fiftieth repository inside a
machine account the owner controls is unremarkable — all fifty are visible and
removable in one action.

**Identity roots to establish once:**

1. **A dedicated email**, or better, a **domain with catch-all addressing** —
   one mailbox yields unlimited per-agent addresses, and the same domain
   supplies subdomains to publish on. One purchase serves both needs.
2. **A GitHub machine account.** GitHub's terms explicitly permit one machine
   account for automation alongside a personal account, so the agent system
   holds a legitimate identity of its own and its commits are visibly not the
   owner's.
3. **A hosting account** with an API — Netlify or Cloudflare Pages; both have
   free tiers.
4. **A domain**, per item 1.

**The `provision` grant kind.** Distinct from `http` because provisioning
creates persistent resources and therefore carries a rate limit:

```yaml
- id: new-repo
  kind: provision
  resource: github-repo | host-site | dns-subdomain
  scope: <the account or zone within which creation is permitted>
  limit: { perDay: 3 }
  secret: <token scoped to that account>
```

Provisioning obeys the same approval posture as any other outward effect: under
the default `approve`, the agent parks and Discord asks. Per Lock 3, the runner
calls the provider API and returns the created resource's identifier; the token
never enters the workspace.

**Never agent-created:** accounts, identities, payment methods, or domain
registrations. These are enumerated as forbidden in `schema/capabilities.json`
so an authoring agent cannot propose them, and rejected by grant validation if
one is somehow written by hand.

---

## 8. Run lifecycle

### 8.1 Normal path

```
trigger fires
  → governor admission (concurrency, budgets, quiet hours, breaker, STOP)
      → refused: log reason, alert only if actionable
  → prepare: runId, ensure workspace, read prompt.md,
             inject state/<agent>/notes.md if present
  → execute via Runner
      → stream every event, appending to transcript.jsonl as it arrives
      → attempted outside effect → grants check → allow | deny | park
  → finish: success | failed | timeout | budget-exceeded | denied | killed
  → record result.json { status, cost, tokens, duration, turns, effects[] }
  → outbox
```

**Transcripts are written as events stream, not assembled at the end.** When an
agent dies at 3am, the transcript up to the moment of death is the artefact that
explains why. Post-hoc logging loses precisely the run most worth reading.

### 8.2 Park and resume

An approval may take hours. A run must not hold a live session and a concurrency
slot while it waits, so approval **parks** the run rather than blocking it:

```
agent attempts an effect requiring approval
  → write data/pending/<id>.json { runId, agentName, sessionId,
                                   effect, grantRef, askedAt }
  → run exits with status "parked"; slot released; nothing consumed
  → bot posts the approval prompt to Discord
  ⏸  (server may restart freely; pending state is on disk)
  → owner taps approve / deny, or the request expires as deny
  → governor admits a resume run
  → Runner resumes with { resume: sessionId } and the decision injected
  → run continues from where it stopped
```

This is why `sessionId` and `resume` appear in §7.1. It is the difference
between a system that survives the owner being asleep and one that does not.

Pending entries are reconciled at boot: any whose run is gone is re-posted, and
any past its timeout resolves as deny.

### 8.3 Failure handling

| Failure | Response |
|---|---|
| Agent error or timeout | Record, post with last 20 transcript lines, count toward breaker |
| Rate limited | Global backoff, alert, automatic resume |
| OAuth token expired or revoked | Halt everything, loud alert — nothing functions without it, and failing loudly beats every agent failing mysteriously |
| Discord webhook unreachable | Retry 3×, then `data/undelivered/` |
| **Discord bot unreachable** | **Nothing requiring approval may proceed.** Parked runs stay parked; alert via webhook if that path still works |
| Supervisor crash | `restart: unless-stopped`; in-flight runs marked `interrupted`; pending reconciled at boot |
| Deploy validation fails | Keep running the previous `main`; report the failure. A bad merge never takes the platform down |

---

## 9. Testing strategy

| Layer | Approach |
|---|---|
| `registry` | Valid and malformed `agent.yaml`; reject unknown tools, bad cron, `grantRefs` with no grant. Assert error messages name the path, legal values, and the fix |
| `grants` | Table-driven over (tier, grants, effect) → allow / deny / park. The security boundary; most thorough coverage |
| **Privilege boundary** | **Adversarial: an agent-authored commit that edits `grants.yaml`, sets `tier: autonomous`, or inlines a grant must fail. One test per lock in §3** |
| `governor` | Pure functions — admission, budgets, quiet hours, breaker. Deterministic, no I/O |
| `pending` | Park, restart, reconcile, resume, expire-as-deny. Simulated restart between park and resume |
| `outbox` | Local HTTP stub; retry and `undelivered/` fallback |
| End-to-end | `FakeRunner` through the full pipeline, every failure path included |
| Smoke | One real agent on `claude-haiku-4-5`, run manually — proves auth and the SDK work |

---

## 10. Deployment

**Phase 1 — local Windows.** Docker Desktop; `claude setup-token` writes the
OAuth token into `.env`; `docker compose up`. First agent on a 5-minute cron to
observe the loop, then moved to its real schedule.

**Phase 2 — VPS.** A Hetzner CX22 (~€4/month) or DigitalOcean's $6 droplet is
ample; inference happens on Anthropic's servers, so the box runs Node and holds
files. Install Docker, clone the repository, create `.env`, `docker compose up -d`.

**Deploying a change** is `git push` locally, then the supervisor's `git pull`,
validate, reload — triggered by a Discord command or a merge approval. Validation
failure keeps the previous `main` running. Rollback is `git revert`.

Three properties built in from the first commit:

1. `.env` is gitignored, with `.env.example` documenting keys.
2. `data/` is a named Docker volume, surviving `docker compose down`.
3. `!runs` in Discord shows the last 20 runs with status and cost.

---

## 11. Roadmap beyond this spec

**Sub-project 2 — the builder agent.** An agent that writes agent definitions,
validates them against the schema, pushes to `proposal/*`, and requests approval.
This is what makes the system self-extending, and it is deliberately built
*after* the privilege boundary is tested, never before.

**Sub-project 3 — control plane.** Once more than a few agents run: run history
browsing, cost trends, enabling and disabling without a deploy.

**Deferred deliberately.** Continuous autonomous workers and `auto` approval
mode, both of which are safe only for agents with an observed track record.

## 12. Honest expectations

Autonomy arrives gradually. Early agents will fail in boring, constant ways —
a half-finished deploy, a loop that runs an hour achieving nothing, an agent
confidently doing the wrong thing. The design's job is not to prevent that; it
is to make failure **cheap and visible** rather than expensive and silent. Every
mechanism here — budgets, parking, the privilege boundary, streamed transcripts
— exists to make the first year of failures survivable and legible.
