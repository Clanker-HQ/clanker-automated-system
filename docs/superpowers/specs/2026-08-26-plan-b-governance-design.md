# Claude Agent Infrastructure — Plan B: Governance & Control

**Date:** 2026-08-26
**Status:** Draft, pending review
**Scope:** Sub-project 2 of the roadmap in principle, but delivers only the
*prerequisites* to the builder agent — governor, capability tiers and grant
enforcement, park/resume, and the Discord control bot. The builder agent
itself, and everything downstream of it, is a later plan.
**Builds on:** [`2026-08-26-claude-agent-infrastructure-design.md`](2026-08-26-claude-agent-infrastructure-design.md)
(§7.2 tiers/grants, §7.3 governor, §7.4 control bot, §8.2 park/resume are the
sections this document makes concrete and, in a few places, corrects against
what the SDK actually offers). That document's §1–§4 (purpose, operating
model, privilege boundary, decisions) still hold and are not repeated here.

---

## 1. What this plan delivers, and what it deliberately doesn't

**Delivers:**

- The governor: budgets, concurrency, quiet hours, a circuit breaker, and
  best-effort rate-limit-aware admission — all currently parsed but inert.
- Capability tiers `granted` and `autonomous`, and grant enforcement —
  currently rejected at boot.
- Park/resume: a durable queue so an approval or a question can outlive a
  run, a restart, and hours of silence.
- A real two-way Discord bot: approvals, agent questions, and admin/runtime
  commands. Replaces nothing — the existing one-way webhook outbox stays for
  routine reporting; the bot is additive, for the interactive half.
- Two correctness fixes the governor's own numbers depend on: cost/token
  accounting for a run that's killed or times out (currently lost entirely),
  and passing a trimmed tool set into the SDK to lower the fixed per-run
  cost floor.

**Explicitly deferred, on purpose:**

- The builder agent and the "proposal approval" Discord flow (an agent
  writing a new `agent.yaml` and asking to merge it). Nothing produces a
  proposal branch yet, so there's nothing for that flow to do. It's built
  together with the builder agent, later.
- Outcome verification (`status: "success"` still only means the SDK didn't
  error). Bigger and fuzzier than a bullet point here — what "verified"
  means differs per agent — and deserves its own plan.
- Any real grant. `grants.yaml` gets one synthetic/test grant to exercise
  the machinery; wiring up an actual credentialed effect (a repo push, an
  API call) happens later, agent by agent, as a real need shows up.
- Browser capability (`capabilities.browser`) — still Plan C per the parent
  design doc, unaffected by this plan.

---

## 2. Architecture: how this changes the run lifecycle

Today, `cron` fires straight into `Orchestrator.executeRun()`, which runs
the agent to completion (or timeout), records the result, and reports to
Discord. This plan adds one stage before it and one branch inside it:

```
trigger fires (cron, or a parked run being resumed)
  → Governor.admit(agent)                                    [NEW]
      STOP file? breaker tripped? quiet hours? daily budget?
      concurrency slot free? rate limit looks OK (best-effort)?
      → refused: log the reason; queue if it's just "no slot yet"
      → admitted: proceed, slot reserved
  → Orchestrator.executeRun()                                 [extended]
      runs as today, EXCEPT: an attempted effect or a question
      from the agent can now stop the run early —
      → park: write data/pending/<id>.json, release the slot,
              run ends with status "parked" (or "question")
  → Discord bot posts the approval/question                   [NEW]
      owner taps or replies; the reply carries the pendingId
  → Governor.admit() again, treating the resume like any other
    admission request (it still needs a slot, still respects
    quiet hours, etc.)
  → Orchestrator resumes the same SDK session with the decision
    injected, and the run continues from where it stopped
```

Two components own two different questions, and the split matters:

- **Governor** decides *whether a run starts at all* — a property of the
  system as a whole (budgets, load, time of day). It has no idea what an
  agent does once running.
- **Tiers/grants** decide, *once a run is already going*, whether one
  specific action is allowed, needs a human, or is refused. It has no idea
  about budgets or concurrency.

This mirrors the parent design doc's own split between §7.2 and §7.3, and
keeps each piece testable in isolation the way `governor` and `grants` are
already separated in its testing table (§9).

---

## 3. Capability tiers & grants

### 3.1 `grants.yaml`

As specified in the parent design doc §7.2, unchanged:

```yaml
grants:
  - id: test-echo
    kind: http
    method: POST
    urlPattern: "https://httpbin.org/post"
    secret: TEST_ECHO_TOKEN
```

One synthetic grant like this is enough to exercise every code path
(allow / deny / park) without any real credential existing yet. Real grants
are added later without touching this plan's code — that's the point of
Lock 2 (grants aren't in `agent.yaml`, so authoring an agent and authorising
it are separately-reviewable acts).

### 3.2 Enforcement mechanism — `canUseTool`

The SDK calls a `canUseTool(toolName, input, options)` function before every
tool execution and awaits a `PermissionResult`. This is the enforcement
point; a new `src/grants.ts` module implements the decision:

```ts
function decide(agent: AgentDef, toolName: string, input: unknown): Decision
// Decision = { kind: "allow" } | { kind: "deny"; reason: string }
//          | { kind: "park"; grantRef?: string; effect: string }
```

A plain `allow` lets the run continue normally. A `deny` also sets
`interrupt: true` — per the parent design's own run lifecycle (§8.1),
`denied` is a whole-run outcome, not a quietly-declined tool call the agent
shrugs off and tries something else. The reasoning: if an agent has just
tried to do something it structurally isn't allowed to do, continuing to
let it flounder (and burn budget) is worse than stopping cleanly and
reporting it — the owner can grant it and re-run if it was actually a
reasonable thing to want. `park` also interrupts, but resumably, once a
human decides.

`readonly`/`sandboxed` agents never reach `park` — any attempted outward
effect is `deny`. `granted`/`autonomous` agents check the attempted effect
against `grantRefs`: no match → `deny`; a match → `park` (unless
`approval: auto`, i.e. `autonomous`) → `allow`.

Grant enforcement gets the heaviest test coverage in this plan —
table-driven over (tier, grants, attempted effect) → allow/deny/park, per
the parent design doc's §9. It is the actual security boundary; everything
else in this plan is pacing and convenience.

### 3.2a The part of this that's genuinely unsolved: detecting an "outward effect"

Worth being honest about rather than glossing over. The tier table forbids
"any outward effect" for `sandboxed` and below — but `Bash` is free-form
text. `git commit` is fine; `git push` is the exact same tool with an
outward effect hiding inside its argument string. There's no clean lookup
for "is this command reaching outside the workspace" the way there is for
"is this tool name in `allowedTools`."

**v1 approach:** a small, explicit pattern list in `src/grants.ts` — known
outward-reaching shapes (`git push`, `curl`/`wget`/`gh` hitting anything
that isn't localhost, `npm publish`, and similarly for `WebFetch`'s URL
argument) route through grant-checking; anything unrecognized inside a
`Bash` call is **allowed to proceed** rather than blocked. That is a real,
named limitation, not a hidden one: it means a sufficiently unusual command
could slip an outward effect past this check today. It's the same caveat
the parent design doc already makes about Playwright's `blockedOrigins`
("not a security boundary... a guardrail against mistakes, not defence") —
worth stating in the same terms here rather than implying `sandboxed` is
airtight against a determined-or-confused agent. The actual backstop, as
today, is the tier's own reach: a `sandboxed` agent has no grant and no
credential to act on even if a pattern slips through — Lock 3 means the
worst case is still "it tried and had nothing to push to."

### 3.3 How "park" actually stops a run

This is the one piece of real mechanism in this plan, so it's worth being
precise about it rather than leaving it as prose.

An approval can take hours. Nothing should hold a live SDK session, a
concurrency slot, or a network connection open while it waits — so `park`
has to stop the *entire run*, not just decline one tool call. The SDK
supports this directly: `PermissionResult`'s deny variant carries an
`interrupt?: boolean` field. Returning
`{ behavior: "deny", message: "...", interrupt: true }` both blocks the
tool call and tells the SDK to interrupt the whole turn — no manual
`AbortController` wiring needed inside `canUseTool` itself.

The sequence inside `SdkRunner`, before returning that result:

1. Capture `session_id` (present on every SDK message).
2. Write `data/pending/<id>.json` (schema in §5.1) with enough to resume:
   agent name, run id, session id, the effect description, the grant it
   matched (if any), and when it was asked.
3. Return the deny-with-interrupt result.

The run then needs to surface as `RunStatus: "parked"` (or `"question"` —
§3.4), not `"failed"`. The orchestrator already has to arbitrate between
competing reasons a run stopped — there's an existing comment in
`orchestrator.ts` handling exactly this race between a timeout-triggered
abort and a thrown error. Parking becomes a third case in that same spot:
whichever of {timeout, park, generic error} is the *true* reason wins, and
the other signals arriving around the same time don't overwrite it.

**New `RunStatus` values:** `"parked"`, `"question"`, `"denied"` (a `deny`
with no park — the agent asked for something with no matching grant at
all — is worth its own status rather than folding into `"failed"`, since
it's not an error, it's the boundary working as intended).

### 3.4 Agent questions — the same mechanism, a different payload

The parent design doc describes "agent questions" only in the abstract
(§7.4: "free-text; the reply is injected into the resumed run"). Concretely:
the SDK supports defining custom in-process tools (`tool()` +
`createSdkMcpServer`, no external MCP process needed). Every agent, at any
tier, gets one extra tool — call it `AskHuman` — whose handler does exactly
what `canUseTool`'s park path does (write a pending entry, deny-with-interrupt)
except the pending entry's `kind` is `"question"` and its resume payload is
the owner's free-text reply rather than an approve/deny decision. It isn't
gated by grants — asking a question isn't an outward effect, so it's
available at `readonly` too.

### 3.5 Testing

Unchanged from the parent design doc's §9: table-driven over
(tier, grants, effect) → allow/deny/park, plus one adversarial test per Lock
in §3 (an agent-authored commit editing `grants.yaml`, setting
`tier: autonomous`, or inlining a grant must fail validation).

---

## 4. Governor

### 4.1 Runtime-mutable settings

Exactly as specified in the parent design doc §7.3.1: `data/config-overrides.json`
holds `quietHours`, `dailyBudgetUsd`, `maxConcurrent`, and per-agent
enable/disable, settable from Discord (`!quiet`, `!budget`, `!concurrency`,
`!enable`/`!disable`), taking effect on the next trigger with no restart.
Precedence: override → `config.yaml` → built-in default. This plan
implements the module that reads/writes this file and the enforcement
that consults it; §7.3.1 already specifies the contract.

### 4.2 Admission checks, and their order

`Governor.admit(agent, kind: "trigger" | "resume")` runs these checks in
order, short-circuiting on the first refusal:

1. `STOP` file present → refuse (existing check, moved here from the
   orchestrator).
2. Circuit breaker tripped for this agent (3 consecutive failures) →
   refuse, alert once.
3. Quiet hours, if not overridden off → refuse.
4. Today's spend (this agent + global) at or over budget → refuse.
5. Rate-limit snapshot (§4.4) shows `rejected` or utilization over a
   configurable ceiling → refuse.
6. No concurrency slot free → **queue**, not refuse — this is the one
   check that's a wait, not a denial. `browser`-capable agents (Plan C,
   not reachable yet since `capabilities.browser.enabled` still rejects at
   boot) will need an exclusive slot per the parent design; not relevant
   until that capability exists.

A resumed run goes through the same gate as a fresh trigger — an approval
tap doesn't bypass quiet hours or the budget, it just re-enters the queue
like anything else. The one difference: a resume ignores the circuit
breaker (a run parked mid-flight isn't a failure).

### 4.3 Concurrency

`maxConcurrent` slots, held in memory (the supervisor is one process; a
restart naturally clears in-flight state, which is fine — anything that
mattered survived as a parked/interrupted run on disk). A simple FIFO queue
in front of `Orchestrator.executeRun` — trigger fires, if a slot is free it
runs immediately, otherwise it waits for one for as long as it takes.

### 4.4 Daily budget

No separate running ledger. At admission time, the governor asks
`RunStore` for today's completed runs (by `startedAt`, in the configured
timezone) and sums `costUsd` — recomputed fresh each check rather than
tracked incrementally, so it can never drift out of sync with what's
actually on disk. This is the same call `RunStore.listRecent` already
supports; at the scale this system runs at (a handful of agents, JSON files
on disk — a deliberate non-goal of a database, per the parent design's §1),
an O(runs-today) scan on every admission check costs nothing measurable.

### 4.5 Rate-limit-aware admission (best-effort)

**The real constraint:** the SDK has no "check my remaining quota" call
that doesn't require an active session — the only method close to it
(`usage_EXPERIMENTAL_...`) lives on an already-running query's control
handle and is explicitly marked unstable. `rate_limit_event` only arrives
*from* a run already in flight.

**The design, per your call:** every `rate_limit_event` seen by any run —
not just the triggering agent's own runs, since it's one shared
subscription-wide limit — is written immediately to
`data/state/rate-limit.json` (updated live as the event streams, not only
at run close, so a long-running agent's mid-flight reading is available to
admit others sooner). Admission checks (§4.2 step 5) read that snapshot. It
will occasionally be stale by however long since the last run; the
existing reactive path — on an actual rate-limit error from the SDK, pause
globally, alert, and back off exponentially (parent design §7.3, unchanged)
— is what catches the cases the stale snapshot misses. This plan needs to
add that reactive handling too: `SDKAssistantMessageError`'s `'rate_limit'`
value is already surfaced as a `RunEvent` of type `"error"` by
`toRunEvents`, but nothing currently reacts to it beyond recording it.

`rate_limit_event` itself needs a new `RunEvent` variant — today
`toRunEvents` silently drops it (only `assistant`/`user`/`result` map to
anything).

### 4.6 Circuit breaker

3 consecutive failures (status `"failed"` or `"timeout"`; `"parked"`,
`"denied"`, and `"budget-exceeded"` don't count — those aren't the agent
malfunctioning) disables the agent and alerts once. The counter is
persisted (a small per-agent state file under `data/state/<agent>/`, next
to the notes file the design doc already has agents leave for themselves)
so it survives a restart — the exact failure mode §9's adversarial testing
cares about is a wedged agent quietly burning quota forever, which a
restart-reset counter would let happen.

### 4.7 Discord's admin/runtime commands

As specified in the parent design doc §7.4/§7.3.1: `!runs`, `!stop`,
`!resume` (these two toggle the `STOP` file — a Discord-reachable version
of the existing SSH `touch`/`rm` workflow, not to be confused with
resuming one specific parked run, which happens by tapping that run's own
approval message), `!disable <agent>`, `!enable <agent>`, `!quiet`,
`!budget`, `!concurrency`. Every settings command echoes the new value and
writes an audit-log line. No command reaches grants, tiers, or permissions
— those stay git-only, per Lock 1–2.

---

## 5. Pending / park-resume

### 5.1 `data/pending/<id>.json`

```json
{
  "id": "01J...",
  "runId": "research-2026-08-26T07-00-00-000Z",
  "agentName": "research",
  "sessionId": "abc-123",
  "kind": "approval",
  "effect": "POST https://httpbin.org/post",
  "grantRef": "test-echo",
  "askedAt": "2026-08-26T07:02:11.000Z"
}
```

`kind: "question"` entries carry a `question` string instead of `effect`/
`grantRef`. The `id` is what the Discord message's approve/deny/reply
controls reference — carried through every prompt, per the parent design's
requirement that answers survive restarts and can't be misrouted.

### 5.2 Boot reconciliation

On startup, for every file in `data/pending/`:

- If it's past `pendingTimeoutHours` (config-overrides-able, default 24) →
  resolve as **deny**, report to Discord as an expired request, delete the
  file. Silence never authorises anything.
- Otherwise → re-post the prompt to Discord (covers the case where the bot,
  or the whole supervisor, was down when it should have posted the first
  time).

### 5.3 Resume

Owner taps/replies in Discord → bot looks up the pending entry by id →
`Governor.admit(agent, "resume")` (§4.2) → once admitted,
`Orchestrator.resumeRun()` calls the runner with the SDK's `resume: sessionId`
option plus the decision (approve/deny, or the free-text answer for a
question) delivered as the next turn's input. The run continues in the
same session — it isn't a fresh conversation, so context isn't lost.

---

## 6. Discord control bot

### 6.1 Transport

The existing Discord integration is a one-way incoming webhook — fine for
posting, useless for reading a reply or a button tap. The control bot needs
a real Discord Application + Bot (gateway connection via `discord.js`),
which needs a one-time setup you don't have yet:

1. Create a Discord Application + Bot in the developer portal.
2. Enable the **Message Content** privileged intent (needed to read
   `!command` text and free-text replies).
3. Invite it to your server with the minimal scope (`bot`, and only the
   permissions needed to read/send in the channels it uses).
4. Put the bot token in `.env` alongside the existing webhook URLs.

A **gateway** connection (persistent outbound websocket) rather than
Discord's alternative "interactions" model (slash commands delivered to a
public HTTPS endpoint) is the only one that fits your current setup:
you're on local Docker Desktop with no public endpoint, and a gateway bot
needs only outbound network access — the same shape as the webhook posting
that already works. This also means moving to a VPS later needs no bot
reconfiguration.

### 6.2 Responsibilities

- **Approvals** — post the pending entry's effect, the grant it invokes,
  and why; a reaction or a short reply resolves it.
- **Questions** — post the agent's free-text question; any reply is the
  answer, injected on resume.
- **Commands** — §4.7's list.

### 6.3 Reliability

Per the parent design's §8.3 failure table, unchanged by this plan: if the
bot itself is unreachable, nothing requiring approval proceeds — parked
runs just stay parked, and an alert goes out over the webhook path if that
still works. A crashed supervisor doesn't lose anything: pending state is
on disk (§5.1), reconciled at the next boot (§5.2).

---

## 7. Two bundled correctness fixes

### 7.1 Cost/token accounting for an interrupted run

**Why this is in scope here specifically:** §4.4's daily budget is computed
by summing recorded run costs. A run that gets killed mid-stream today
records **zero** cost — the only place `toRunEvents` emits a `"usage"`
event is the terminal `result` message, which an aborted run never reaches.
A budget enforced against numbers that silently undercount kills is a
budget with a hole in it.

**The fix:** each `SDKAssistantMessage` carries a standard Anthropic
Messages API `usage` block (input/output tokens) for that turn — this is
present per-message, not only on the terminal message. `SdkRunner`
accumulates these as they stream. If the run ends via abort before a
`result` message arrives, it emits a synthesized `"usage"` event from the
accumulated totals instead of nothing.

**One honest limitation to flag:** the SDK only computes a dollar
`total_cost_usd` on the terminal `result` message — per-turn messages carry
token counts, not pre-computed cost. So an interrupted run's token counts
will be accurate; its dollar figure will be an estimate (a small hardcoded
per-model $/token table), clearly distinguishable in the transcript from a
completed run's SDK-reported figure. Given the parent design doc already
notes these are subscription "estimates, not money," this seems like the
right place to stop rather than importing real-time pricing lookups for a
number that was always approximate.

### 7.2 Trimming the loaded tool set

The SDK's top-level `tools` option — distinct from `allowedTools`, which
only governs auto-approval — controls what's actually loaded into the
system prompt. `SdkRunner` currently doesn't set it at all, so every run
pays for every built-in tool's definition regardless of what the agent is
allowed to use. The fix: pass `tools: agent.permissions.allowedTools`
always, including when it's empty (an agent with no listed tools
legitimately gets none of the built-ins, same as `allowedTools` already
implies — it still keeps `AskHuman`, §3.4, which isn't a built-in). This is
the lever the parent design doc's §7.3 flagged without using; expect it to
measurably lower, not eliminate, the ~$0.046
floor — some fixed cost is inherent to the system prompt itself.

---

## 8. File layout additions

```
grants.yaml                        # NEW — human-only, one synthetic grant
src/
├─ grants.ts                       # NEW — tier + grant enforcement (§3)
├─ governor.ts                     # NEW — admission control (§4)
├─ control/
│  ├─ bot.ts                       # NEW — Discord bot (§6)
│  └─ pending.ts                   # NEW — durable park/resume queue (§5)
data/
├─ pending/<id>.json                # NEW
├─ config-overrides.json           # NEW (parsed but unwritten today)
├─ state/rate-limit.json           # NEW — last known utilization snapshot
└─ state/<agent>/breaker.json      # NEW — consecutive-failure counter
```

`src/orchestrator.ts` gains the governor call and the park/resume branch;
`src/runner/sdk-runner.ts` gains `canUseTool`, the `AskHuman` tool, and the
`tools` option; `src/runner/types.ts` gains the new `RunEvent` variant and
`RunStatus` values; `src/agent-schema.ts` drops the `NOT_YET` rejections
for `tier: granted/autonomous`, `approval: auto/approve`, and non-empty
`grantRefs`.

---

## 9. Testing strategy (additions to the parent design's §9)

| Layer | Approach |
|---|---|
| `grants` | Table-driven over (tier, grants, effect) → allow/deny/park. Heaviest coverage in this plan. |
| Privilege boundary | One adversarial test per Lock in parent §3, unchanged from what §9 already specifies — now actually implementable since grants exist to attack. |
| `governor` | Pure functions — admission order, budget math, quiet hours, breaker state transitions. Deterministic, no I/O, per parent §9. |
| `pending` | Park, simulated restart, reconcile, resume, expire-as-deny — parent §9's list, now buildable. |
| Rate-limit snapshot | Given a stale/missing snapshot file, admission still works (fails open on missing data, not closed) — this needs to be an explicit test, since "no snapshot yet" (a fresh install) must not permanently refuse every run. |
| Cost accounting on abort | `FakeRunner` gains a script mode that aborts mid-stream after partial usage; assert the recorded run isn't `$0.0000`. |
| End-to-end | `FakeRunner` extended to script `park` and `question` outcomes (previously flagged in parent §7.1 as "cannot be summoned on demand" — this plan is what makes them summonable). |
| Discord bot | No live Discord in tests — a fake gateway/transport the same way `FakeRunner` fakes the SDK, so bot logic (command parsing, pendingId round-tripping) is tested at zero cost and without a real Discord server. |

---

## 10. Open questions to settle during planning, not here

A few mechanics are grounded in what the installed SDK's type definitions
say today (`canUseTool`'s `interrupt` flag, `tool()`/`createSdkMcpServer`
for `AskHuman`, `resume`, per-message `usage`, the top-level `tools`
option) but not yet exercised against the real SDK. The implementation plan
should include a small probe script (in the spirit of the existing
`scripts/probe-sdk.ts`) confirming `canUseTool`'s `interrupt: true` actually
stops a run the way its doc comment implies, before the full park mechanism
is built on top of that assumption.
