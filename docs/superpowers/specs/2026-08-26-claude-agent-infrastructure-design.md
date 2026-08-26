# Claude Agent Infrastructure — Design

**Date:** 2026-08-26
**Status:** Approved, ready for implementation planning
**Scope:** Sub-project 1 of 3 — the core runtime and host

---

## 1. Purpose

A self-hosted platform that runs Claude agents unattended on a server, billed
against a Claude subscription rather than the API.

The platform's real job is **making experiments cheap**. Adding an agent must
cost one folder and two files. If trying an idea requires touching plumbing,
few ideas get tried, and the platform has failed regardless of how well it runs
the agents it already has.

### Success criteria

1. An agent runs on a schedule with no human present and reports to Discord.
2. Adding a new agent is creating a directory with `agent.yaml` and `prompt.md`.
3. No `ANTHROPIC_API_KEY` anywhere; authentication is the Claude subscription.
4. A runaway agent is stopped by budget, turn, or time limits without human action.
5. The whole pipeline is testable without consuming meaningful subscription quota.
6. `docker compose up` is the run command on both Windows and the VPS.

### Explicit non-goals for v1

No web dashboard. No database — JSON files on disk are correct at this scale.
No multi-user support. No automatic retry of failed runs. No resuming an
interrupted run mid-flight. No deploy pipeline.

---

## 2. Decisions and rationale

### 2.1 Authentication — subscription, via a swappable provider

`claude setup-token` mints a long-lived OAuth token tied to a Claude
subscription. Exposed to the container as `CLAUDE_CODE_OAUTH_TOKEN`, the Agent
SDK uses it and no API billing occurs.

**Terms-of-service boundary.** The Agent SDK documentation states that Anthropic
does not permit third-party developers to offer claude.ai login or rate limits
*to their products' users* without prior approval. Running agents for oneself on
one's own subscription is the intended use of `setup-token` and is not affected.
The line is crossed only if end users' actions come to trigger Claude calls on
this subscription.

The project owner has confirmed no such product is planned. The design still
isolates credential resolution in a single provider module, so a future move to
API-key billing is a configuration change rather than a rewrite.

### 2.2 Rejected: Managed Agents

Anthropic's Managed Agents product with scheduled deployments does what this
platform does, with Anthropic hosting the loop and the sandbox — less code to
own. It bills against the API, which violates the primary requirement. Rejected
on that ground alone. Worth revisiting if billing ever moves to the API.

### 2.3 Rejected: one container per run

Spawning a fresh container per agent run gives kernel-level isolation, but
requires Docker socket access from the supervisor — equivalent to host root —
plus an image pipeline and slow cold starts. Disproportionate for a single
operator running their own agents. The `Runner` interface (§5.1) is the seam
where this could be adopted later without touching anything else.

### 2.4 Chosen: one container, one supervisor, agents as folders

The container is the security boundary. Within it, agents are separated by
workspace directory, per-agent tool permissions, and capability tiers.
TypeScript, because the Agent SDK wraps the Node-based Claude Code binary and
one language runtime in the image is enough.

---

## 3. Repository layout

```
claude-agent-infrastructure/
├─ docker-compose.yml
├─ Dockerfile                  # FROM mcr.microsoft.com/playwright:v1.x-noble
├─ .env.example                # documents required keys; .env is gitignored
├─ config.yaml                 # global governor settings, Discord channel map
├─ src/
│  ├─ index.ts                 # boot: validate config, start triggers
│  ├─ registry.ts              # discover + validate agents/*/agent.yaml
│  ├─ runner/
│  │  ├─ types.ts              # Runner interface, RunEvent union
│  │  ├─ sdk-runner.ts         # THE seam — only file that imports the SDK
│  │  ├─ fake-runner.ts        # canned event streams for tests
│  │  └─ credentials.ts        # swappable: subscription token | API key
│  ├─ governor.ts              # admission control, budgets, breaker
│  ├─ grants.ts                # tier + grant enforcement (security boundary)
│  ├─ outbox/discord.ts
│  ├─ triggers/cron.ts         # v1
│  └─ triggers/webhook.ts      # v2, same interface
├─ agents/
│  └─ <agent-name>/
│     ├─ agent.yaml
│     └─ prompt.md
├─ docs/superpowers/specs/
└─ data/                       # named docker volume, gitignored
   ├─ workspaces/<agent>/      # persists across runs
   ├─ runs/<runId>/            # transcript.jsonl + result.json
   ├─ state/<agent>/           # notes an agent leaves its future self
   ├─ undelivered/             # outbox failures, never dropped
   └─ STOP                     # kill switch: presence halts everything
```

---

## 4. The agent definition

An agent is a directory containing exactly two required files.

`prompt.md` is the task in plain English. Nothing else.

`agent.yaml`:

```yaml
name: daily-digest              # must match directory name
enabled: true

trigger:
  type: cron                    # v1: cron. v2: webhook, manual
  schedule: "0 7 * * *"
  timezone: UTC

run:
  model: claude-opus-5          # claude-haiku-4-5 for dev/smoke agents
  effort: medium                # low | medium | high | xhigh | max
  maxTurns: 40
  timeoutMinutes: 15
  maxBudgetUsd: 1.00            # enforced by the SDK

permissions:
  allowedTools: [Read, Write, Edit, Glob, Grep, WebSearch, WebFetch]
  disallowedTools: [Bash]

tier: sandboxed                 # readonly | sandboxed | granted | autonomous
approval: notify                # auto | notify | approve
grants: []                      # required and enforced when tier is granted+

capabilities:
  browser:
    enabled: false
    blockedOrigins: []
    exclusiveSlot: true

outbox:
  discord: research             # channel key resolved from config.yaml
  notifyOn: [success, failure]
```

**Model choice.** `claude-opus-5` is the default for real work. Dev and smoke
agents use `claude-haiku-4-5` to minimise quota consumption while exercising the
plumbing. Note that Haiku 4.5 has a 200K context window rather than 1M — it is
for testing infrastructure, not for long research runs.

**Validation happens at boot, not at trigger time.** A malformed cron
expression, an unknown tool name, or a grant referencing an undefined secret
fails `docker compose up` loudly. Silent per-trigger skips produce agents that
appear healthy and never run.

---

## 5. Components

### 5.1 Runner — the SDK seam

```ts
interface Runner {
  execute(agent: AgentDef, runId: string, signal: AbortSignal):
    AsyncIterable<RunEvent>;
}
```

`SdkRunner` is the only module importing `@anthropic-ai/claude-agent-sdk`. It
maps an `AgentDef` onto `query()` options:

| agent.yaml | SDK option |
|---|---|
| `run.model`, `run.effort`, `run.maxTurns` | `model`, `effort`, `maxTurns` |
| `run.maxBudgetUsd` | `maxBudgetUsd` |
| `run.timeoutMinutes` | `abortController` on a timer |
| `permissions.*` | `allowedTools`, `disallowedTools` |
| workspace path | `cwd` |
| `capabilities.browser` | `mcpServers.playwright` |
| `tier`, `grants`, `approval` | `canUseTool` + `hooks.PreToolUse` |

`settingSources` is set explicitly rather than left to default, so a run's
behaviour depends only on the agent definition and not on stray files in the
image.

`FakeRunner` replays canned `RunEvent` streams. Everything downstream is tested
against it at zero quota cost, including paths that cannot be summoned on demand
from a real agent: budget exceeded, timeout, denied grant, outbox down.

### 5.2 Capability tiers and grants — the security boundary

| Tier | Permits | Forbids |
|---|---|---|
| `readonly` | Read, search, web fetch, report | All writes |
| `sandboxed` | Full freedom inside its workspace: bash, packages, local git commits | Any outward effect |
| `granted` | `sandboxed` plus enumerated grants | Anything not enumerated |
| `autonomous` | `granted` without per-action reporting | — |

Outside power is **enumerated, never general**:

```yaml
tier: granted
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
```

This yields three properties: an agent's outward powers are readable from its
file; grants are revocable individually; and each grant maps to a credential
scoped to it, so a failure's blast radius is that grant rather than an account.

**Approval modes.** `auto` proceeds and logs. `notify` proceeds and posts to
Discord as it happens — the recommended setting while learning to trust an
agent. `approve` pauses the run pending a Discord answer; it requires the
Discord bot from sub-project 2. In v1, `approval: approve` is **rejected by
registry validation at boot** with a message naming sub-project 2, consistent
with §4's rule that configuration errors fail loudly at startup rather than
surfacing mid-run.

**Browser capability.** Playwright MCP is opt-in per agent and started only for
agents declaring it. It is available at any tier, but what it may carry depends
on the tier:

| Tier | Browser configuration |
|---|---|
| `sandboxed` and below | `--headless --isolated`, no stored credentials, logged out |
| `granted` and above | May additionally use `--storage-state` or `--secrets`, and only for credentials named in a grant |

The distinction matters because a browser holding a live login can act as the
account owner on that site, which is an outward effect and therefore belongs
behind an enumerated grant. A logged-out isolated browser is a read-and-explore
tool and needs no grant.

Playwright's own documentation states that `--allowed-origins` and
`--blocked-origins` are *not* a security boundary; they are treated here as
guardrails against mistakes, not as defence. Pin the package version rather than
tracking `@latest`.

Grant enforcement receives the most thorough tests in the project: table-driven
over (tier, grants, attempted effect) → allow | deny | notify.

### 5.3 Governor — admission control

Four limits are configuration the SDK enforces; three are ours.

| Mechanism | Prevents | Implementation |
|---|---|---|
| `maxBudgetUsd` | Unbounded thinking | SDK |
| `maxTurns` | Tool-call loops | SDK |
| `timeoutMinutes` | Wedged processes | `abortController` |
| `allowedTools` | Misuse of unnecessary tools | SDK — absent from context |
| Concurrency cap | Simultaneous wake-ups | Queue; default 2 slots; browser agents take an exclusive slot |
| Daily budgets | Unnoticed slow bleed | Per-agent and global; a global breach pauses everything and alerts |
| Circuit breaker | Endless failure loops | 3 consecutive failures disables the agent and alerts once |

Global configuration:

```yaml
governor:
  maxConcurrent: 2
  dailyBudgetUsd: 10
  quietHours: { from: "09:00", to: "18:00", timezone: UTC }
```

**Kill switch:** the presence of `data/STOP` prevents new runs and aborts running
ones. One file, usable over SSH in seconds.

**Subscription rate limits.** Agents share one rate limit with the owner's
interactive Claude Code use, and no API reports the remaining allowance. Three
mitigations: track estimated cost and tokens per run and enforce daily budgets
against those; on a rate-limit error, pause the scheduler globally, alert, and
retry with exponential backoff; and defer to the human during `quietHours`, when
scheduled agents wait. The third matters most — agents consuming the allowance
during the owner's working hours is the failure that would cause abandonment.

### 5.4 Outbox

Discord incoming webhooks, one channel per agent, mapped by key in `config.yaml`
with URLs in `.env`. Messages report what the agent did, what it cost, which
outside effects it touched, and the run ID. Failures retry three times, then
write to `data/undelivered/`. A result is never lost because the outbox was
unavailable.

---

## 6. Run lifecycle

```
trigger fires
  → governor admission (concurrency, budgets, quiet hours, breaker, STOP)
      → refused: log reason, alert only if actionable
  → prepare: runId = <agent>-<ISO timestamp>, ensure workspace,
             read prompt.md, inject state/<agent>/notes.md if present
  → execute via Runner
      → stream every event, appending to transcript.jsonl as it arrives
      → attempted outside effect → grants check → allow | deny | notify
  → finish: success | failed | timeout | budget-exceeded | denied | killed
  → record result.json { status, cost, tokens, duration, turns, effects[] }
  → outbox
```

**Transcripts are written as events stream, not assembled at the end.** When an
agent dies at 3am, the transcript up to the moment of death is the artefact that
explains why. Post-hoc logging loses precisely the run most worth reading.

### Failure handling

| Failure | Response |
|---|---|
| Agent error or timeout | Record, post with last 20 transcript lines, count toward breaker |
| Rate limited | Global backoff, alert, automatic resume |
| OAuth token expired or revoked | Halt everything, loud alert — nothing functions without it, and failing loudly beats every agent failing mysteriously |
| Discord unreachable | Retry 3×, then `data/undelivered/` |
| Supervisor crash | `restart: unless-stopped`; in-flight runs marked `interrupted` at boot |

---

## 7. Testing strategy

| Layer | Approach |
|---|---|
| `registry` | Valid and malformed `agent.yaml`; reject unknown tools, bad cron, undefined grant secrets |
| `governor` | Pure functions — admission, budgets, quiet hours, breaker. Deterministic, no I/O |
| `grants` | Table-driven over (tier, grants, effect). The security boundary; most thorough coverage |
| `outbox` | Local HTTP stub; retry and `undelivered/` fallback |
| End-to-end | `FakeRunner` through the full pipeline, including every failure path |
| Smoke | One real agent on `claude-haiku-4-5`, run manually — proves auth and the SDK work |

---

## 8. Deployment

**Phase 1 — local Windows.** Docker Desktop; `claude setup-token` writes the
OAuth token into `.env`; `docker compose up`. First agent on a 5-minute cron to
observe the loop, then moved to its real schedule.

**Phase 2 — VPS.** A Hetzner CX22 (~€4/month) or DigitalOcean's $6 droplet is
ample; inference happens on Anthropic's servers, so the box only runs Node and
holds files. Install Docker, copy the project, `docker compose up -d`. `.env` is
recreated on the server rather than travelling with the repository.

Three properties built in from the first commit:

1. `.env` is gitignored before any commit, with `.env.example` documenting keys.
2. `data/` is a named Docker volume, surviving `docker compose down`.
3. `npm run runs` prints the last 20 runs with status and cost.

---

## 9. Roadmap beyond this spec

**Sub-project 2 — trigger adapters.** Webhook trigger; a Discord bot enabling
`approval: approve` and two-way chat; a manual trigger CLI.

**Sub-project 3 — control plane.** Only once more than two agents run: run
history browsing, cost trends, enabling and disabling agents without redeploy.

**Deferred deliberately.** Continuous autonomous workers, which can exhaust a
rate limit or make a mess unsupervised, and are far safer to build after simpler
agents have been observed behaving.
